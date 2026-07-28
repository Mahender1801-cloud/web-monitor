-- ============================================================================
-- DAILY ROLLUP — the real fix for the dashboard timing out.  Run once.
--
-- WHY: rum_events is ~250k rows over 7 days and grows ~12k/day. Measured live:
--        percentiles over a 7-day window ……  5.0s
--        dimension group-bys (device/os/…) … 12.3s
--        dash_stats does both + distinct …… 21.8s  -> exceeds the 20s timeout,
--   so the dashboard silently fell back to the truncated 500-row client cache
--   ("PARTIAL", "24 sessions in range"). Live aggregation cannot keep up, and it
--   only gets worse as the table grows.
--
-- FIX: summarise each day ONCE into rum_daily. A 30-day window then reads 30
--   pre-computed rows instead of a million raw ones. Percentiles stay accurate
--   because we store HISTOGRAMS (not just averages) and merge them.
--
-- Accuracy: percentiles are exact to within one bucket (LCP/FCP 50ms, TTFB 25ms,
--   INP 10ms, CLS 0.005). "Slowest paths" combines daily p75s weighted by views
--   (a very close approximation, used only for ranking).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Storage
-- ---------------------------------------------------------------------------
create table if not exists public.rum_daily (
  d           date primary key,
  views       bigint  not null default 0,
  visitors    bigint  not null default 0,   -- distinct ga_client_id that day
  sessions    bigint  not null default 0,   -- distinct session_id that day
  dwell_sum   numeric not null default 0,
  dwell_cnt   bigint  not null default 0,
  h_lcp jsonb, h_inp jsonb, h_cls jsonb, h_fcp jsonb, h_ttfb jsonb,
  by_device jsonb, by_os jsonb, by_net jsonb, by_ref jsonb,
  by_path   jsonb,                          -- [[path, views, lcp75, inp75, cls75], …]
  by_pivot  jsonb,                          -- {'device||Mobile||Products': n, …} for dash_pivot
  updated_at timestamptz not null default now()
);
alter table public.rum_daily add column if not exists by_pivot jsonb;
alter table public.rum_daily enable row level security;
drop policy if exists sel_rum_daily on public.rum_daily;
create policy sel_rum_daily on public.rum_daily for select using (true);

-- ---------------------------------------------------------------------------
-- 2) Histogram helpers.  A histogram is jsonb {bucket_index: count}; the same
--    merge works for the dimension maps ({'mobile': 812, …}) since both are
--    key -> count.
-- ---------------------------------------------------------------------------
create or replace function public.hist_add(a jsonb, b jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(key, val), '{}'::jsonb)
  from (
    select key, sum(value::bigint) val
    from ( select * from jsonb_each_text(coalesce(a, '{}'::jsonb))
           union all
           select * from jsonb_each_text(coalesce(b, '{}'::jsonb)) ) x
    group by key
  ) y;
$$;

drop aggregate if exists public.hist_sum(jsonb);
create aggregate public.hist_sum(jsonb) (
  sfunc = public.hist_add, stype = jsonb, initcond = '{}'
);

-- percentile from a merged histogram (bucket midpoint)
create or replace function public.hist_pct(h jsonb, width numeric, pct numeric default 0.75)
returns numeric language plpgsql immutable as $$
declare tot bigint; run bigint := 0; target numeric; k text; v bigint;
begin
  if h is null or h = '{}'::jsonb then return null; end if;
  select sum(value::bigint) into tot from jsonb_each_text(h);
  if tot is null or tot = 0 then return null; end if;
  target := tot * pct;
  for k, v in select key, value::bigint from jsonb_each_text(h) order by (key)::int loop
    run := run + v;
    if run >= target then return (k::numeric + 0.5) * width; end if;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Build one day's rollup (scans ~12k rows -> fast)
-- ---------------------------------------------------------------------------
create or replace function public.rum_rollup_day(p_day date)
returns void language plpgsql
set statement_timeout = '60s'
as $$
begin
  with src as materialized (
    select lcp, inp, cls, fcp, ttfb, time_on_page, device, os, connection,
           referrer, path, ga_client_id, session_id
    from public.rum_events
    where created_at >= p_day::timestamptz
      and created_at <  (p_day + 1)::timestamptz
  ),
  base as (
    select count(*) views,
           count(distinct ga_client_id) visitors,
           count(distinct session_id)   sessions,
           coalesce(sum(time_on_page),0) dwell_sum,
           count(time_on_page) dwell_cnt
    from src
  ),
  hl as (select jsonb_object_agg(b::text, c) j from (
           select least(floor(lcp/50)::int,400) b, count(*) c from src where lcp is not null group by 1) t),
  hi as (select jsonb_object_agg(b::text, c) j from (
           select least(floor(inp/10)::int,400) b, count(*) c from src where inp is not null group by 1) t),
  hc as (select jsonb_object_agg(b::text, c) j from (
           select least(floor(cls/0.005)::int,400) b, count(*) c from src where cls is not null group by 1) t),
  hf as (select jsonb_object_agg(b::text, c) j from (
           select least(floor(fcp/50)::int,400) b, count(*) c from src where fcp is not null group by 1) t),
  ht as (select jsonb_object_agg(b::text, c) j from (
           select least(floor(ttfb/25)::int,400) b, count(*) c from src where ttfb is not null group by 1) t),
  dv as (select jsonb_object_agg(k, c) j from (
           select coalesce(nullif(device,''),'other') k, count(*) c from src group by 1) t),
  os_ as (select jsonb_object_agg(k, c) j from (
           select coalesce(nullif(os,''),'Other') k, count(*) c from src group by 1) t),
  nt as (select jsonb_object_agg(k, c) j from (
           select coalesce(nullif(connection,''),'unknown') k, count(*) c from src group by 1) t),
  rf as (select jsonb_object_agg(k, c) j from (
           select case
             when referrer is null or referrer = '' then 'Direct'
             when referrer ilike '%instagram%'      then 'Instagram'
             when referrer ilike '%facebook%'       then 'Facebook'
             when referrer ilike '%google%'         then 'Google'
             when referrer ilike '%hashtageyewear%' then 'Internal'
             else 'Other' end k, count(*) c from src group by 1) t),
  pth as (select coalesce(jsonb_agg(jsonb_build_array(path, n, l, i, c2)), '[]'::jsonb) j from (
           select path, count(*) n,
                  percentile_cont(0.75) within group (order by lcp) l,
                  percentile_cont(0.75) within group (order by inp) i,
                  percentile_cont(0.75) within group (order by cls) c2
           from src where path is not null
           group by path having count(*) >= 3
           order by count(*) desc limit 50) t),
  -- 2-D breakdown for the pivot tables: dimension x page-group
  pv as (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) j from (
           select dim || '||' || val || '||' || grp k, count(*) c
           from (
             select case
                      when path is null or path = '' or path = '/' then 'Homepage'
                      when path like '/collections%' then 'Collections'
                      when path like '/products%'    then 'Products'
                      when path like '/cart%'        then 'Cart'
                      when path like '/pages%'       then 'Pages'
                      when path like '/apps%'        then 'Apps'
                      else 'Other' end grp,
                    coalesce(nullif(initcap(device),''),'Other') dev,
                    coalesce(nullif(os,''),'Other') os2,
                    coalesce(nullif(connection,''),'unknown') net,
                    case
                      when referrer is null or referrer = ''  then 'Direct'
                      when referrer ilike '%instagram%'       then 'Instagram'
                      when referrer ilike '%facebook%'        then 'Facebook'
                      when referrer ilike '%google%'          then 'Google'
                      when referrer ilike '%hashtageyewear%'  then 'Internal'
                      else 'Other' end ref
             from src
           ) s,
           lateral (values ('device', s.dev), ('os', s.os2), ('net', s.net), ('ref', s.ref)) v(dim, val)
           group by 1) t)
  insert into public.rum_daily (d, views, visitors, sessions, dwell_sum, dwell_cnt,
        h_lcp, h_inp, h_cls, h_fcp, h_ttfb, by_device, by_os, by_net, by_ref, by_path, by_pivot, updated_at)
  select p_day, b.views, b.visitors, b.sessions, b.dwell_sum, b.dwell_cnt,
         hl.j, hi.j, hc.j, hf.j, ht.j, dv.j, os_.j, nt.j, rf.j, pth.j, pv.j, now()
  from base b, hl, hi, hc, hf, ht, dv, os_, nt, rf, pth, pv
  on conflict (d) do update set
    views=excluded.views, visitors=excluded.visitors, sessions=excluded.sessions,
    dwell_sum=excluded.dwell_sum, dwell_cnt=excluded.dwell_cnt,
    h_lcp=excluded.h_lcp, h_inp=excluded.h_inp, h_cls=excluded.h_cls,
    h_fcp=excluded.h_fcp, h_ttfb=excluded.h_ttfb,
    by_device=excluded.by_device, by_os=excluded.by_os, by_net=excluded.by_net,
    by_ref=excluded.by_ref, by_path=excluded.by_path, by_pivot=excluded.by_pivot,
    updated_at=now();
end $$;
grant execute on function public.rum_rollup_day(date) to anon;

-- Refresh the last N days (call with 2 from the Action; larger to backfill).
create or replace function public.rum_rollup_refresh(p_days int default 2)
returns int language plpgsql
set statement_timeout = '300s'
as $$
declare dd date; n int := 0;
begin
  for dd in select generate_series(current_date - (p_days - 1), current_date, '1 day')::date loop
    perform public.rum_rollup_day(dd);
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function public.rum_rollup_refresh(int) to anon;

-- ---------------------------------------------------------------------------
-- 4) dash_stats v5 — reads the rollup for whole days, live-queries only the
--    partial edges (at most 2 part-days ≈ 24k rows). Fast at any window size.
-- ---------------------------------------------------------------------------
create or replace function public.dash_stats(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare
  result json;
  full_lo date; full_hi date;
begin
  full_lo := (date_trunc('day', p_from))::date;
  if date_trunc('day', p_from) < p_from then full_lo := full_lo + 1; end if;
  full_hi := (date_trunc('day', p_to))::date;          -- days < full_hi are complete
  if full_hi < full_lo then full_hi := full_lo; end if;

  with roll as (
    select * from public.rum_daily where d >= full_lo and d < full_hi
  ),
  -- the partial head/tail that the rollup doesn't cover
  live as materialized (
    select lcp, inp, cls, fcp, ttfb, time_on_page, device, os, connection,
           referrer, path, ga_client_id
    from public.rum_events
    where (created_at >= p_from and created_at < full_lo::timestamptz)
       or (created_at >= full_hi::timestamptz and created_at <= p_to)
  ),
  lb as (
    select count(*) views, count(distinct ga_client_id) visitors,
           coalesce(sum(time_on_page),0) dwell_sum, count(time_on_page) dwell_cnt
    from live
  ),
  lhl as (select coalesce(jsonb_object_agg(b::text,c),'{}'::jsonb) j from (
            select least(floor(lcp/50)::int,400) b, count(*) c from live where lcp is not null group by 1) t),
  lhi as (select coalesce(jsonb_object_agg(b::text,c),'{}'::jsonb) j from (
            select least(floor(inp/10)::int,400) b, count(*) c from live where inp is not null group by 1) t),
  lhc as (select coalesce(jsonb_object_agg(b::text,c),'{}'::jsonb) j from (
            select least(floor(cls/0.005)::int,400) b, count(*) c from live where cls is not null group by 1) t),
  lhf as (select coalesce(jsonb_object_agg(b::text,c),'{}'::jsonb) j from (
            select least(floor(fcp/50)::int,400) b, count(*) c from live where fcp is not null group by 1) t),
  lht as (select coalesce(jsonb_object_agg(b::text,c),'{}'::jsonb) j from (
            select least(floor(ttfb/25)::int,400) b, count(*) c from live where ttfb is not null group by 1) t),
  ldv as (select coalesce(jsonb_object_agg(k,c),'{}'::jsonb) j from (
            select coalesce(nullif(device,''),'other') k, count(*) c from live group by 1) t),
  los as (select coalesce(jsonb_object_agg(k,c),'{}'::jsonb) j from (
            select coalesce(nullif(os,''),'Other') k, count(*) c from live group by 1) t),
  lnt as (select coalesce(jsonb_object_agg(k,c),'{}'::jsonb) j from (
            select coalesce(nullif(connection,''),'unknown') k, count(*) c from live group by 1) t),
  lrf as (select coalesce(jsonb_object_agg(k,c),'{}'::jsonb) j from (
            select case
              when referrer is null or referrer = '' then 'Direct'
              when referrer ilike '%instagram%'      then 'Instagram'
              when referrer ilike '%facebook%'       then 'Facebook'
              when referrer ilike '%google%'         then 'Google'
              when referrer ilike '%hashtageyewear%' then 'Internal'
              else 'Other' end k, count(*) c from live group by 1) t),
  lpt as (select coalesce(jsonb_agg(jsonb_build_array(path,n,l,i,c2)),'[]'::jsonb) j from (
            select path, count(*) n,
                   percentile_cont(0.75) within group (order by lcp) l,
                   percentile_cont(0.75) within group (order by inp) i,
                   percentile_cont(0.75) within group (order by cls) c2
            from live where path is not null
            group by path having count(*) >= 3
            order by count(*) desc limit 50) t),
  -- merged totals
  tot as (
    select (select coalesce(sum(views),0) from roll)    + (select views from lb)     views,
           (select coalesce(sum(visitors),0) from roll) + (select visitors from lb)  visitors,
           (select coalesce(sum(dwell_sum),0) from roll)+ (select dwell_sum from lb) dsum,
           (select coalesce(sum(dwell_cnt),0) from roll)+ (select dwell_cnt from lb) dcnt
  ),
  mh as (
    select public.hist_add((select public.hist_sum(h_lcp) from roll), (select j from lhl)) lcp,
           public.hist_add((select public.hist_sum(h_inp) from roll), (select j from lhi)) inp,
           public.hist_add((select public.hist_sum(h_cls) from roll), (select j from lhc)) cls,
           public.hist_add((select public.hist_sum(h_fcp) from roll), (select j from lhf)) fcp,
           public.hist_add((select public.hist_sum(h_ttfb)from roll), (select j from lht)) ttfb,
           public.hist_add((select public.hist_sum(by_device) from roll), (select j from ldv)) dev,
           public.hist_add((select public.hist_sum(by_os)     from roll), (select j from los)) os,
           public.hist_add((select public.hist_sum(by_net)    from roll), (select j from lnt)) net,
           public.hist_add((select public.hist_sum(by_ref)    from roll), (select j from lrf)) ref
  ),
  -- slowest paths: daily p75s combined weighted by views
  allp as (
    select e->>0 path, (e->>1)::bigint n, nullif(e->>2,'')::numeric l,
           nullif(e->>3,'')::numeric i, nullif(e->>4,'')::numeric c2
    from roll, jsonb_array_elements(coalesce(roll.by_path,'[]'::jsonb)) e
    union all
    select e->>0, (e->>1)::bigint, nullif(e->>2,'')::numeric,
           nullif(e->>3,'')::numeric, nullif(e->>4,'')::numeric
    from lpt, jsonb_array_elements(lpt.j) e
  ),
  comb as (
    select path, sum(n) n,
      sum(l*n) filter (where l is not null) / nullif(sum(n) filter (where l is not null),0) l,
      sum(i*n) filter (where i is not null) / nullif(sum(n) filter (where i is not null),0) i,
      sum(c2*n)filter (where c2 is not null)/ nullif(sum(n) filter (where c2 is not null),0) c2
    from allp group by path
    having sum(n) >= 5
    order by 3 desc nulls last limit 8
  )
  select json_build_object(
    'views',    (select views from tot),
    'visitors', (select visitors from tot),
    'lcp',      (select public.hist_pct(lcp, 50)    from mh),
    'inp',      (select public.hist_pct(inp, 10)    from mh),
    'cls',      (select public.hist_pct(cls, 0.005) from mh),
    'fcp',      (select public.hist_pct(fcp, 50)    from mh),
    'ttfb',     (select public.hist_pct(ttfb, 25)   from mh),
    'dwell',    (select case when dcnt > 0 then dsum/dcnt end from tot),
    'by_device',(select coalesce(json_agg(json_build_array(key, value::bigint) order by value::bigint desc),'[]'::json)
                   from mh, jsonb_each_text(mh.dev)),
    'by_os',    (select coalesce(json_agg(json_build_array(key, value::bigint) order by value::bigint desc),'[]'::json)
                   from mh, jsonb_each_text(mh.os)),
    'by_net',   (select coalesce(json_agg(json_build_array(key, value::bigint) order by value::bigint desc),'[]'::json)
                   from mh, jsonb_each_text(mh.net)),
    'by_ref',   (select coalesce(json_agg(json_build_array(key, value::bigint) order by value::bigint desc),'[]'::json)
                   from mh, jsonb_each_text(mh.ref)),
    'slow',     (select coalesce(json_agg(json_build_array(path,n,l,i,c2) order by l desc nulls last),'[]'::json)
                   from comb)
  ) into result;
  return result;
end $$;
grant execute on function public.dash_stats(timestamptz, timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- 4b) dash_pivot from the rollup (was 12.3s live).
-- ---------------------------------------------------------------------------
create or replace function public.dash_pivot(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json; full_lo date; full_hi date;
begin
  full_lo := (date_trunc('day', p_from))::date;
  if date_trunc('day', p_from) < p_from then full_lo := full_lo + 1; end if;
  full_hi := (date_trunc('day', p_to))::date;
  if full_hi < full_lo then full_hi := full_lo; end if;

  with roll as (select by_pivot j from public.rum_daily where d >= full_lo and d < full_hi),
  live as materialized (
    select device, os, connection, referrer, path from public.rum_events
    where (created_at >= p_from and created_at < full_lo::timestamptz)
       or (created_at >= full_hi::timestamptz and created_at <= p_to)
  ),
  lpv as (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) j from (
            select dim || '||' || val || '||' || grp k, count(*) c
            from (
              select case
                       when path is null or path = '' or path = '/' then 'Homepage'
                       when path like '/collections%' then 'Collections'
                       when path like '/products%'    then 'Products'
                       when path like '/cart%'        then 'Cart'
                       when path like '/pages%'       then 'Pages'
                       when path like '/apps%'        then 'Apps'
                       else 'Other' end grp,
                     coalesce(nullif(initcap(device),''),'Other') dev,
                     coalesce(nullif(os,''),'Other') os2,
                     coalesce(nullif(connection,''),'unknown') net,
                     case
                       when referrer is null or referrer = ''  then 'Direct'
                       when referrer ilike '%instagram%'       then 'Instagram'
                       when referrer ilike '%facebook%'        then 'Facebook'
                       when referrer ilike '%google%'          then 'Google'
                       when referrer ilike '%hashtageyewear%'  then 'Internal'
                       else 'Other' end ref
              from live
            ) s,
            lateral (values ('device', s.dev), ('os', s.os2), ('net', s.net), ('ref', s.ref)) v(dim, val)
            group by 1) t),
  merged as (
    select public.hist_add((select public.hist_sum(j) from roll), (select j from lpv)) j
  ),
  ex as (
    select split_part(key,'||',1) dim, split_part(key,'||',2) k, split_part(key,'||',3) grp,
           value::bigint c
    from merged, jsonb_each_text(merged.j)
  )
  select json_build_object(
    'device',(select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from ex where dim='device'),
    'os',    (select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from ex where dim='os'),
    'net',   (select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from ex where dim='net'),
    'ref',   (select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from ex where dim='ref'),
    'total', (select coalesce(sum(c),0) from ex where dim='device')
  ) into result;
  return result;
end $$;
grant execute on function public.dash_pivot(timestamptz, timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- 5) Backfill every day we have data for (run once — takes a few minutes).
-- ---------------------------------------------------------------------------
do $$
declare dd date; lo date; hi date;
begin
  select min(created_at)::date, max(created_at)::date into lo, hi from public.rum_events;
  if lo is null then return; end if;
  for dd in select generate_series(lo, hi, '1 day')::date loop
    perform public.rum_rollup_day(dd);
  end loop;
end $$;

analyze public.rum_daily;

-- Verify (should be well under a second now):
--   select public.dash_stats(now() - interval '7 days', now());
--   select d, views, visitors from public.rum_daily order by d desc limit 10;
