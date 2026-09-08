-- ============================================================================
-- Give the Visitors page a rollup fallback, so it keeps working for windows
-- older than the raw-retention horizon (14 days) after pruning.
-- Run once in Supabase -> SQL Editor. Safe / additive until the very last block.
--
-- visitor_report() reads raw rum_events. Once raw is pruned to 14 days, any
-- older window returns nothing. This stores the per-visitor aggregates the page
-- needs, per day, in rum_daily.by_visitor, and rewrites visitor_report() to
-- merge those when the window predates the raw horizon.
--
-- One honest limit, stated because it cannot be engineered away with daily
-- rollups: a UNIQUE-visitor count over a multi-day window is the sum of each
-- day's uniques. A shopper who visited on three days counts three times in the
-- rollup path, once in the raw path. Within a single day both agree exactly.
-- Everything else — views, bounce, multipage, depth, entry/exit, by-hour,
-- by-device — merges cleanly and matches.
-- ============================================================================

alter table public.rum_daily add column if not exists by_visitor jsonb;

-- ---------------------------------------------------------------------------
-- Compute one day's visitor aggregates and store them. Mirrors exactly what
-- visitor_report derives from raw, so the two paths line up.
-- ---------------------------------------------------------------------------
create or replace function public.rum_rollup_visitor(p_day date)
returns void language plpgsql
set statement_timeout = '60s'
as $$
begin
  with w as materialized (
    select coalesce(nullif(ga_client_id,''), session_id) k,
           path, device, coalesce(time_on_page,0) top, created_at,
           (ga_client_id is not null and ga_client_id <> '') has_ga
    from public.rum_events
    where created_at >= p_day::timestamptz
      and created_at <  (p_day + 1)::timestamptz
      and coalesce(nullif(ga_client_id,''), session_id) is not null
  ),
  per as (
    select k, count(*) pages, sum(top) engaged, bool_or(has_ga) has_ga,
           (array_agg(device order by created_at))[1] device,
           (array_agg(path   order by created_at))[1] entry,
           (array_agg(path   order by created_at desc))[1] exitp,
           min(created_at) first_seen
    from w group by k
  )
  update public.rum_daily set by_visitor = jsonb_build_object(
    'visitors',    (select count(*) from per),
    'views',       (select count(*) from w),
    'identified',  (select count(*) from per where has_ga),
    'multipage',   (select count(*) from per where pages > 1),
    'bounced',     (select count(*) from per where pages = 1),
    'deep',        (select count(*) from per where pages >= 5),
    'engaged_sum', (select coalesce(sum(engaged),0) from per),
    'engaged_cnt', (select count(*) from per),
    'pages_sum',   (select coalesce(sum(pages),0) from per),
    'by_device',   (select coalesce(jsonb_object_agg(k2,c),'{}'::jsonb)
                      from (select coalesce(nullif(device,''),'other') k2, count(*) c from per group by 1) t),
    'by_hour',     (select coalesce(jsonb_object_agg(h::text,c),'{}'::jsonb)
                      from (select extract(hour from first_seen)::int h, count(*) c from per group by 1) t),
    'top_entry',   (select coalesce(jsonb_object_agg(entry,c),'{}'::jsonb)
                      from (select entry, count(*) c from per group by entry order by count(*) desc limit 20) t),
    'top_exit',    (select coalesce(jsonb_object_agg(exitp,c),'{}'::jsonb)
                      from (select exitp, count(*) c from per group by exitp order by count(*) desc limit 20) t)
  )
  where d = p_day;
end $$;
grant execute on function public.rum_rollup_visitor(date) to anon;

-- Backfill every stored day while the raw rows still exist.
select public.rum_rollup_visitor(d) from public.rum_daily order by d;

-- Keep it filled going forward, next to the other rollups.
create or replace function public.rum_rollup_refresh(p_days int default 2)
returns int language plpgsql
set statement_timeout = '300s'
as $$
declare dd date; n int := 0;
begin
  for dd in select generate_series(current_date - (p_days - 1), current_date, '1 day')::date loop
    perform public.rum_rollup_day(dd);
    perform public.rum_rollup_group(dd);
    perform public.rum_rollup_visitor(dd);
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function public.rum_rollup_refresh(int) to anon;

-- ---------------------------------------------------------------------------
-- visitor_report v2: raw when the whole window is still in raw, the merged
-- rollup when it is not. Same JSON shape either way, so the page is unchanged.
-- ---------------------------------------------------------------------------
create or replace function public.visitor_report(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json; horizon timestamptz;
begin
  select min(created_at) into horizon from public.rum_events;

  -- Whole window still covered by raw -> exact per-visitor path (as before).
  if horizon is not null and p_from >= horizon then
    with w as materialized (
      select coalesce(nullif(ga_client_id,''), session_id) k,
             path, device, coalesce(time_on_page,0) top, created_at,
             (ga_client_id is not null and ga_client_id <> '') has_ga
      from public.rum_events
      where created_at >= p_from and created_at <= p_to
        and coalesce(nullif(ga_client_id,''), session_id) is not null
    ),
    per as (
      select k, count(*) pages, sum(top) engaged, bool_or(has_ga) has_ga,
             (array_agg(device order by created_at))[1] device,
             (array_agg(path   order by created_at))[1] entry,
             (array_agg(path   order by created_at desc))[1] exitp,
             min(created_at) first_seen
      from w group by k
    )
    select json_build_object(
      'visitors',(select count(*) from per),'views',(select count(*) from w),
      'identified',(select count(*) from per where has_ga),
      'multipage',(select count(*) from per where pages>1),
      'bounced',(select count(*) from per where pages=1),
      'engaged_avg',(select round((avg(engaged)/1000.0)::numeric,1) from per),
      'pages_avg',(select round(avg(pages)::numeric,2) from per),
      'deep',(select count(*) from per where pages>=5),
      'by_device',(select coalesce(json_agg(json_build_array(k2,c) order by c desc),'[]'::json)
                     from (select coalesce(nullif(device,''),'other') k2,count(*) c from per group by 1) t),
      'top_entry',(select coalesce(json_agg(json_build_array(entry,c) order by c desc),'[]'::json)
                     from (select entry,count(*) c from per group by entry order by count(*) desc limit 12) t),
      'top_exit',(select coalesce(json_agg(json_build_array(exitp,c) order by c desc),'[]'::json)
                     from (select exitp,count(*) c from per group by exitp order by count(*) desc limit 12) t),
      'by_hour',(select coalesce(json_agg(json_build_array(h,c) order by h),'[]'::json)
                     from (select extract(hour from first_seen)::int h,count(*) c from per group by 1) t),
      'source','raw'
    ) into result;
    return result;
  end if;

  -- Older than the raw horizon -> merge the daily by_visitor summaries.
  with days as (
    select by_visitor v from public.rum_daily
    where d >= p_from::date and d <= p_to::date and by_visitor is not null
  ),
  agg as (
    select
      sum((v->>'visitors')::bigint)   visitors,
      sum((v->>'views')::bigint)      views,
      sum((v->>'identified')::bigint) identified,
      sum((v->>'multipage')::bigint)  multipage,
      sum((v->>'bounced')::bigint)    bounced,
      sum((v->>'deep')::bigint)       deep,
      sum((v->>'engaged_sum')::numeric) esum,
      sum((v->>'engaged_cnt')::bigint)  ecnt,
      sum((v->>'pages_sum')::numeric)   psum
    from days
  ),
  -- merge the per-key jsonb maps across days
  dev as (select key k2, sum(value::bigint) c from days, jsonb_each_text(v->'by_device') group by 1),
  hr  as (select key h,  sum(value::bigint) c from days, jsonb_each_text(v->'by_hour')   group by 1),
  ent as (select key p,  sum(value::bigint) c from days, jsonb_each_text(v->'top_entry') group by 1),
  ext as (select key p,  sum(value::bigint) c from days, jsonb_each_text(v->'top_exit')  group by 1)
  select json_build_object(
    'visitors',(select visitors from agg),'views',(select views from agg),
    'identified',(select identified from agg),'multipage',(select multipage from agg),
    'bounced',(select bounced from agg),'deep',(select deep from agg),
    'engaged_avg',(select round(((esum/nullif(ecnt,0))/1000.0)::numeric,1) from agg),
    'pages_avg',(select round((psum/nullif(visitors,0))::numeric,2) from agg),
    'by_device',(select coalesce(json_agg(json_build_array(k2,c) order by c desc),'[]'::json) from dev),
    'top_entry',(select coalesce(json_agg(json_build_array(p,c) order by c desc),'[]'::json)
                   from (select p,c from ent order by c desc limit 12) t),
    'top_exit', (select coalesce(json_agg(json_build_array(p,c) order by c desc),'[]'::json)
                   from (select p,c from ext order by c desc limit 12) t),
    'by_hour',  (select coalesce(json_agg(json_build_array(h::int,c) order by h::int),'[]'::json) from hr),
    'source','rollup'
  ) into result;
  return result;
end $$;
grant execute on function public.visitor_report(timestamptz, timestamptz) to anon;

-- Verify: a recent window says source=raw, an old one source=rollup, and the
-- totals are close where the two overlap.
--   select public.visitor_report(now() - interval '1 day', now()) ->> 'source';
--   select public.visitor_report(now() - interval '40 days', now() - interval '30 days');
