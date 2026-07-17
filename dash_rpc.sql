-- ============================================================================
-- Server-side aggregation — run ONCE in Supabase → SQL Editor. Idempotent.
--
-- WHY: the store does ~12k views/day (22k+ rows already). The dashboard was
-- downloading raw rows and counting them in the browser, capped at 12k — so
-- "last 7 days" was really only the newest ~1 day, and every p75 was computed
-- on partial data. Postgres must do the maths, not the browser.
--
-- One call returns everything for a window: counts, p75s, breakdowns, the
-- daily trend and the slowest paths — computed over EVERY row, transferring
-- only a few KB.
-- ============================================================================

create or replace function public.dash_stats(p_from timestamptz, p_to timestamptz)
returns json
language sql
stable
as $$
  with w as (
    select * from public.rum_events
    where created_at >= p_from and created_at <= p_to
  )
  select json_build_object(
    'views',     (select count(*) from w),
    'visitors',  (select count(distinct ga_client_id) from w where ga_client_id is not null),
    'lcp',       (select percentile_cont(0.75) within group (order by lcp)  from w),
    'inp',       (select percentile_cont(0.75) within group (order by inp)  from w),
    'cls',       (select percentile_cont(0.75) within group (order by cls)  from w),
    'fcp',       (select percentile_cont(0.75) within group (order by fcp)  from w),
    'ttfb',      (select percentile_cont(0.75) within group (order by ttfb) from w),
    'dwell',     (select avg(time_on_page) from w),
    'by_device', (select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                    from (select coalesce(nullif(device,''),'other') k, count(*) c from w group by 1) t),
    'by_os',     (select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                    from (select coalesce(nullif(os,''),'Other') k, count(*) c from w group by 1) t),
    'by_net',    (select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                    from (select coalesce(nullif(connection,''),'unknown') k, count(*) c from w group by 1) t),
    'by_ref',    (select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                    from (select case
                            when referrer is null or referrer = '' then 'Direct'
                            when referrer ilike '%instagram%'      then 'Instagram'
                            when referrer ilike '%facebook%'       then 'Facebook'
                            when referrer ilike '%google%'         then 'Google'
                            when referrer ilike '%hashtageyewear%' then 'Internal'
                            else 'Other' end k, count(*) c from w group by 1) t),
    'daily',     (select coalesce(json_agg(json_build_array(d,v) order by d),'[]'::json)
                    from (select date_trunc('day', created_at)::date d,
                                 percentile_cont(0.75) within group (order by lcp) v
                          from w group by 1) t),
    'hourly',    (select coalesce(json_agg(json_build_array(h,v) order by h),'[]'::json)
                    from (select date_trunc('hour', created_at) h,
                                 percentile_cont(0.75) within group (order by lcp) v
                          from w group by 1) t),
    'slow',      (select coalesce(json_agg(json_build_array(path,n,l,i,c2) order by l desc nulls last),'[]'::json)
                    from (select path, count(*) n,
                                 percentile_cont(0.75) within group (order by lcp) l,
                                 percentile_cont(0.75) within group (order by inp) i,
                                 percentile_cont(0.75) within group (order by cls) c2
                          from w group by 1 having count(*) >= 3
                          order by l desc nulls last limit 8) t)
  );
$$;

-- The dashboard reads with the public anon key.
grant execute on function public.dash_stats(timestamptz, timestamptz) to anon;

-- Makes the window scans fast as the table grows.
create index if not exists rum_created_idx on public.rum_events (created_at desc);

-- Try it:
--   select public.dash_stats(now() - interval '24 hours', now());
