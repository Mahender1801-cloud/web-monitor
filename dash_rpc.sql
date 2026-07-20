-- ============================================================================
-- Server-side aggregation — RE-RUN this version in Supabase → SQL Editor.
--
-- v4 — performance. Measured on the live table:
--        1-day  window (11k rows) …… 0.9s   OK
--        7-day  window (61k rows) …… 8.5s   hitting the timeout
--        30-day window (95k rows) …… ~13s   always timing out
--
--   The cost was the "slowest paths" block: it grouped by path (thousands of
--   distinct product URLs) and ran THREE percentile sorts per group. Percentiles
--   need a sort, so that is thousands of sorts per call.
--
--   Fix: pick the busiest paths first with a cheap COUNT aggregate, then compute
--   percentiles for only those. Same numbers for the rows anyone actually looks
--   at (a path with 2 views was never going to be shown), a fraction of the work.
-- ============================================================================

create or replace function public.dash_stats(p_from timestamptz, p_to timestamptz)
returns json
language plpgsql
stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select lcp, inp, cls, fcp, ttfb, time_on_page,
           device, os, connection, referrer, path, ga_client_id
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
  ),
  agg as (
    select count(*) views,
           count(distinct ga_client_id) visitors,
           percentile_cont(0.75) within group (order by lcp)  lcp,
           percentile_cont(0.75) within group (order by inp)  inp,
           percentile_cont(0.75) within group (order by cls)  cls,
           percentile_cont(0.75) within group (order by fcp)  fcp,
           percentile_cont(0.75) within group (order by ttfb) ttfb,
           avg(time_on_page) dwell
    from w
  ),
  -- cheap: hash-aggregate to find the busiest paths, no sorting involved
  toppaths as (
    select path from w where path is not null
    group by path having count(*) >= 5
    order by count(*) desc limit 40
  ),
  -- expensive percentiles now run over ~40 groups instead of thousands
  slowpaths as (
    select w.path, count(*) n,
           percentile_cont(0.75) within group (order by w.lcp) l,
           percentile_cont(0.75) within group (order by w.inp) i,
           percentile_cont(0.75) within group (order by w.cls) c2
    from w join toppaths t on t.path = w.path
    group by w.path
    order by l desc nulls last
    limit 8
  )
  select json_build_object(
    'views',    (select views    from agg),
    'visitors', (select visitors from agg),
    'lcp',      (select lcp      from agg),
    'inp',      (select inp      from agg),
    'cls',      (select cls      from agg),
    'fcp',      (select fcp      from agg),
    'ttfb',     (select ttfb     from agg),
    'dwell',    (select dwell    from agg),
    'by_device',(select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                   from (select coalesce(nullif(device,''),'other') k, count(*) c from w group by 1) t),
    'by_os',    (select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                   from (select coalesce(nullif(os,''),'Other') k, count(*) c from w group by 1) t),
    'by_net',   (select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                   from (select coalesce(nullif(connection,''),'unknown') k, count(*) c from w group by 1) t),
    'by_ref',   (select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                   from (select case
                           when referrer is null or referrer = '' then 'Direct'
                           when referrer ilike '%instagram%'      then 'Instagram'
                           when referrer ilike '%facebook%'       then 'Facebook'
                           when referrer ilike '%google%'         then 'Google'
                           when referrer ilike '%hashtageyewear%' then 'Internal'
                           else 'Other' end k, count(*) c from w group by 1) t),
    'slow',     (select coalesce(json_agg(json_build_array(path,n,l,i,c2) order by l desc nulls last),'[]'::json)
                   from slowpaths)
  ) into result;
  return result;
end;
$$;

grant execute on function public.dash_stats(timestamptz, timestamptz) to anon;

-- Keep the planner honest after big inserts (this is what fixed the seq scans):
analyze public.rum_events;

-- Verify — 7-day window should now come back in a couple of seconds:
--   select public.dash_stats(now() - interval '7 days', now());
