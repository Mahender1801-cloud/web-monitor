-- ============================================================================
-- Keep the database under the free tier, without losing any report.
-- Run storage_audit.sql FIRST and read its output. Run the steps here in order.
--
-- CORRECTION, from measuring the data once it was copied into Docker where it
-- could be counted properly. My first reading of this was wrong.
--
-- I originally wrote that rum_events_all was the problem and nothing else was
-- close. That was based on counting each table through PostgREST, and the count
-- on health_events returned HTTP 500 — it timed out — so I moved past it. It is
-- the bigger table:
--
--     health_events    884,262 rows    314 MB
--     rum_events_all   363,187 rows    ~550 MB projected at full size
--     shop_orders       37,035 rows      6 MB
--     everything else                   <5 MB each
--
-- And 867,000 of those health rows are js_error, 302 MB of the 314. They are a
-- handful of third-party failures repeated on every page a shopper opens:
--
--     unhandled promise: Failed to fetch                 229,299   26.4%
--     Uncaught NetworkError: importScripts               117,004   13.5%
--     failed to load: wishlist.thimatic-apps.com          80,536    9.3%
--     unhandled promise: Cannot read properties of null   56,318    6.5%
--     failed to load: checkout-merchant.snapmint.com      45,021    5.2%
--
-- So both tables need bounding, and the js_error flood needs stopping at the
-- source — see the change to webvitals.js, which now sends one row per distinct
-- problem per visit instead of one per time it fires.
--
-- The architecture already anticipated this. rum_daily stores merged histograms
-- per day, which is why the dashboard is fast at any window size: history lives
-- in the rollup, and raw rows only serve the recent edge. The raw table was
-- never meant to hold a month. It just was never pruned.
--
-- One thing that is NOT safe, and it is worth saying because it is the obvious
-- move: do not drop the raw jsonb column. bot_filter.sql's insert trigger reads
-- raw->>'ua' to decide is_bot. Dropping it breaks bot detection on every future
-- row. Old rows are different — they were already classified and is_bot is
-- stored — so their raw can be emptied, which is what step 4 does.
--
-- ORDER MATTERS. Steps 1-3 are additive and reversible. Steps 4-5 delete data.
-- Do not run 4 or 5 until step 3's verification passes.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- STEP 1 — give the rollup somewhere to keep the QA report's inputs.
--
-- qa_day() groups events into home/collection/product/cart and returns a p75
-- per group. It reads raw rows, so pruning would silently break every QA report
-- older than the retention window. rum_daily.by_path is per-path, not per-group,
-- so it cannot answer the same question. This adds a per-group summary that can.
-- Seven numbers per group per day — a few hundred bytes for a whole day.
-- ---------------------------------------------------------------------------
alter table public.rum_daily add column if not exists by_group jsonb;


-- ---------------------------------------------------------------------------
-- STEP 2 — fill by_group whenever a day is rolled up, and backfill every day
-- that already exists while the raw rows are still here to compute it from.
-- ---------------------------------------------------------------------------
create or replace function public.rum_rollup_group(p_day date)
returns void language plpgsql
set statement_timeout = '60s'
as $$
begin
  with w as materialized (
    select
      case
        when path is null or path = '' or path = '/' then 'home'
        when path like '/collections%' then 'collection'
        when path like '/products%'    then 'product'
        when path like '/cart%'        then 'cart'
        when path like '/pages%'       then 'pages'
        else 'other'
      end as grp,
      lcp, inp, cls
    from public.rum_events
    where created_at >= p_day::timestamptz
      and created_at <  (p_day + 1)::timestamptz
  ),
  g as (
    select grp,
           count(*)                                         as views,
           percentile_cont(0.75) within group (order by lcp) as lcp,
           percentile_cont(0.75) within group (order by inp) as inp,
           percentile_cont(0.75) within group (order by cls) as cls,
           count(lcp) as lcp_n, count(inp) as inp_n, count(cls) as cls_n
    from w group by grp
  )
  update public.rum_daily set by_group = (
    select coalesce(jsonb_object_agg(grp, jsonb_build_object(
             'views', views, 'lcp', lcp, 'inp', inp, 'cls', cls,
             'lcp_n', lcp_n, 'inp_n', inp_n, 'cls_n', cls_n)), '{}'::jsonb)
    from g)
  where d = p_day;
end $$;
grant execute on function public.rum_rollup_group(date) to anon;

-- Backfill every stored day. Do this while raw rows still exist — after step 5
-- the older days can no longer be reconstructed.
select public.rum_rollup_group(d) from public.rum_daily order by d;

-- Keep it filled from now on, so this never has to be remembered again.
create or replace function public.rum_rollup_refresh(p_days int default 2)
returns int language plpgsql
set statement_timeout = '300s'
as $$
declare dd date; n int := 0;
begin
  for dd in select generate_series(current_date - (p_days - 1), current_date, '1 day')::date loop
    perform public.rum_rollup_day(dd);
    perform public.rum_rollup_group(dd);
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function public.rum_rollup_refresh(int) to anon;


-- ---------------------------------------------------------------------------
-- STEP 3 — make qa_day read raw when it is there and the rollup when it is not.
--
-- Same JSON shape either way, so make_qa_csv and every report keep working
-- unchanged. Live days stay exact; pruned days answer from the stored summary.
-- ---------------------------------------------------------------------------
create or replace function public.qa_day(p_day date)
returns json language plpgsql stable
set statement_timeout = '60s'
as $$
declare result json; n_raw bigint;
begin
  select count(*) into n_raw from public.rum_events
  where created_at >= p_day::timestamptz and created_at < (p_day + 1)::timestamptz;

  -- No raw rows left for this day: answer from the rollup written before pruning.
  if n_raw = 0 then
    select json_build_object(
      'day', p_day,
      'total', coalesce(views, 0),
      'groups', coalesce(by_group::json, '{}'::json),
      'source', 'rollup'
    ) into result
    from public.rum_daily where d = p_day;
    return coalesce(result, json_build_object(
      'day', p_day, 'total', 0, 'groups', '{}'::json, 'source', 'no data'));
  end if;

  with w as materialized (
    select
      case
        when path is null or path = '' or path = '/' then 'home'
        when path like '/collections%' then 'collection'
        when path like '/products%'    then 'product'
        when path like '/cart%'        then 'cart'
        when path like '/pages%'       then 'pages'
        else 'other'
      end as grp,
      lcp, inp, cls
    from public.rum_events
    where created_at >= p_day::timestamptz
      and created_at <  (p_day + 1)::timestamptz
  ),
  g as (
    select grp,
           count(*)                                         as views,
           percentile_cont(0.75) within group (order by lcp) as lcp,
           percentile_cont(0.75) within group (order by inp) as inp,
           percentile_cont(0.75) within group (order by cls) as cls,
           count(lcp) as lcp_n, count(inp) as inp_n, count(cls) as cls_n
    from w group by grp
  )
  select json_build_object(
    'day',   p_day,
    'total', (select count(*) from w),
    'groups',(select coalesce(json_object_agg(grp, json_build_object(
                'views', views, 'lcp', lcp, 'inp', inp, 'cls', cls,
                'lcp_n', lcp_n, 'inp_n', inp_n, 'cls_n', cls_n)), '{}'::json) from g),
    'source', 'raw'
  ) into result;
  return result;
end $$;
grant execute on function public.qa_day(date) to anon;

-- VERIFY BEFORE GOING FURTHER. Pick a day with raw rows and confirm the stored
-- summary already reproduces it. The two must agree; if they do not, stop.
--
--   select public.qa_day('2026-08-09') -> 'groups' -> 'product' as from_raw,
--          by_group -> 'product'                               as from_rollup
--   from public.rum_daily where d = '2026-08-09';


-- ===========================================================================
-- Everything below deletes data. Nothing above did.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- STEP 4 — empty raw on rows older than 3 days. Recovers the single largest
-- chunk without losing a metric or a row.
--
-- Safe because the insert trigger reads raw only at insert time, and is_bot is
-- already stored on every one of these rows. What is lost is the ability to
-- re-run bot classification over history — the classification itself survives.
--
-- COMMENTED OUT DELIBERATELY. Everything above this line can be pasted and run
-- as a block with no risk; this cannot. Uncomment it only after
-- `node scripts/db_sync.mjs` has copied these rows into the Docker archive,
-- because once raw is emptied here it exists nowhere else.
-- ---------------------------------------------------------------------------
-- update public.rum_events_all
-- set raw = null
-- where created_at < now() - interval '3 days' and raw is not null;
--
-- vacuum full public.rum_events_all;   -- returns the freed pages to the OS


-- ---------------------------------------------------------------------------
-- STEP 5 — delete raw rows past the retention window.
--
-- The guard is the point: it refuses to delete any day that has no rum_daily
-- row, so a day that was never rolled up can never be thrown away. Deleting
-- rows whose summary was never written would lose that day permanently.
-- ---------------------------------------------------------------------------
create or replace function public.rum_prune(p_keep_days int default 14)
returns table(day date, deleted bigint) language plpgsql
set statement_timeout = '300s'
as $$
declare dd date; n bigint;
begin
  for dd in
    select distinct created_at::date
    from public.rum_events_all
    where created_at < (current_date - p_keep_days)
    order by 1
  loop
    -- never drop a day the rollup does not already describe
    if not exists (select 1 from public.rum_daily r
                   where r.d = dd and r.by_group is not null) then
      day := dd; deleted := -1;      -- -1 means "skipped, not summarised"
      return next;
      continue;
    end if;
    delete from public.rum_events_all where created_at::date = dd;
    get diagnostics n = row_count;
    day := dd; deleted := n;
    return next;
  end loop;
end $$;
grant execute on function public.rum_prune(int) to anon;

-- Dry run first — shows which days WOULD go, and flags any that are unsafe:
--   select d, views, (by_group is not null) as summarised
--   from public.rum_daily
--   where d < current_date - 14 order by d;
--
-- Then, when that list looks right:
--   select * from public.rum_prune(14);
--   vacuum full public.rum_events_all;
--
-- Any row returning deleted = -1 was skipped because its summary is missing.
-- Fix those with  select public.rum_rollup_group('<that date>');  then re-run.


-- ---------------------------------------------------------------------------
-- STEP 5b — the bigger half: health_events.
--
-- Run scripts/db_sync.mjs first. Unlike rum_events, there is no rollup standing
-- behind this table, so whatever is deleted here exists only in the Docker
-- archive afterwards. That is the whole point of copying it there first.
--
-- 7 days, and the number is measured rather than chosen. With the archive
-- loaded locally the whole plan could be costed exactly, projecting from the
-- last 14 days of real traffic and applying the new per-session dedupe:
--
--     health kept    health      rum (14d, raw 3d)    total incl. other tables
--        7 days      119 MB           170 MB                 349 MB
--       10 days      171 MB           170 MB                 400 MB
--       14 days      239 MB           170 MB                 469 MB
--       21 days      358 MB           170 MB                 588 MB
--
-- The free tier is 500 MB. 7 days lands at 349 MB with real headroom, and 21
-- days does not fit at all. Nothing is lost by choosing it: error_diagnosis.sql
-- already only looks back 7 days, so this deletes rows no view was reading —
-- and the Docker archive keeps them all anyway.
-- ---------------------------------------------------------------------------
create or replace function public.health_prune(p_keep_days int default 7)
returns bigint language plpgsql
set statement_timeout = '300s'
as $$
declare n bigint;
begin
  delete from public.health_events where created_at < now() - make_interval(days => p_keep_days);
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.health_prune(int) to anon;

-- Check what it would remove, and confirm the archive already has it:
--   select created_at::date d, count(*) from public.health_events
--   where created_at < now() - interval '7 days' group by 1 order by 1;
--
-- Against the archive (psql on the container), the same range must be present:
--   docker exec wm-archive-db psql -U monitor -d monitor -c \
--     "select min(created_at)::date, max(created_at)::date, count(*) from health_events"
--
-- Then:
--   select public.health_prune(7);
--   vacuum full public.health_events;


-- ---------------------------------------------------------------------------
-- STEP 6 — keep it from filling again.
--
-- Add this to the monitor workflow (scripts/check.mjs already calls
-- rum_rollup_refresh; one more RPC next to it costs nothing):
--
--   POST /rest/v1/rpc/rum_prune   {"p_keep_days": 14}
--
-- At ~10,000 rows a day, a 14-day window settles at ~140,000 rows instead of
-- growing without limit. With raw emptied beyond 3 days, that is roughly a
-- fifth of what is stored today.
-- ---------------------------------------------------------------------------
