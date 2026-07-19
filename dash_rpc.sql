-- ============================================================================
-- Server-side aggregation — run in Supabase → SQL Editor (RE-RUN this version).
--
-- v2: the previous version re-scanned rum_events ~15× (once per percentile /
-- breakdown), which timed out as the table grew past ~50k rows — so the dashboard
-- silently fell back to truncated client data (wrong counts + wrong trend line).
-- This version scans the window ONCE (materialized), then reads that snapshot,
-- and is allowed a longer statement timeout for big windows.
-- ============================================================================

create or replace function public.dash_stats(p_from timestamptz, p_to timestamptz)
returns json
language sql
stable
set statement_timeout = '25s'
as $$
  with w as materialized (          -- scan base table + index ONCE, then reuse
    select lcp, inp, cls, fcp, ttfb, time_on_page,
           device, os, connection, referrer, path, ga_client_id, created_at
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
    'daily',    (select coalesce(json_agg(json_build_array(d,v) order by d),'[]'::json)
                   from (select date_trunc('day', created_at)::date d,
                                percentile_cont(0.75) within group (order by lcp) v
                         from w group by 1) t),
    'hourly',   (select coalesce(json_agg(json_build_array(h,v) order by h),'[]'::json)
                   from (select date_trunc('hour', created_at) h,
                                percentile_cont(0.75) within group (order by lcp) v
                         from w group by 1) t),
    'slow',     (select coalesce(json_agg(json_build_array(path,n,l,i,c2) order by l desc nulls last),'[]'::json)
                   from (select path, count(*) n,
                                percentile_cont(0.75) within group (order by lcp) l,
                                percentile_cont(0.75) within group (order by inp) i,
                                percentile_cont(0.75) within group (order by cls) c2
                         from w group by 1 having count(*) >= 3
                         order by l desc nulls last limit 8) t)
  );
$$;

grant execute on function public.dash_stats(timestamptz, timestamptz) to anon;
create index if not exists rum_created_idx on public.rum_events (created_at desc);

-- Test (should return in a couple of seconds, not time out):
--   select public.dash_stats(now() - interval '7 days', now());
