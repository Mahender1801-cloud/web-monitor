-- ============================================================================
-- Server-side aggregation — RE-RUN this version in Supabase → SQL Editor.
--
-- v3 fixes a real timeout:
--   • Converted to plpgsql. A LANGUAGE sql function can be INLINED by the
--     planner, which ignores its `SET statement_timeout` — so it kept hitting
--     the anon role's 3s cap and timing out (=> dashboard showed "PARTIAL").
--     plpgsql is never inlined, so the 25s override actually applies.
--   • Dropped the daily/hourly series (the trend chart now uses dash_trend),
--     which also makes this noticeably lighter.
-- ============================================================================

create or replace function public.dash_stats(p_from timestamptz, p_to timestamptz)
returns json
language plpgsql
stable
set statement_timeout = '25s'
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
                   from (select path, count(*) n,
                                percentile_cont(0.75) within group (order by lcp) l,
                                percentile_cont(0.75) within group (order by inp) i,
                                percentile_cont(0.75) within group (order by cls) c2
                         from w group by 1 having count(*) >= 3
                         order by l desc nulls last limit 8) t)
  ) into result;
  return result;
end;
$$;

grant execute on function public.dash_stats(timestamptz, timestamptz) to anon;
create index if not exists rum_created_idx on public.rum_events (created_at desc);

-- Test (should return in a couple of seconds, NOT time out):
--   select public.dash_stats(now() - interval '7 days', now());
