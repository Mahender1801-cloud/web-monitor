-- ============================================================================
-- Server-side aggregation for the three table views. Run in Supabase → SQL Editor.
--
-- WHY: the pivot tables, the Web Vitals per-page table and the Monitors daily
-- sparklines were all computed in the BROWSER from DATA.rum. After the load
-- optimisation that array holds only ~500 recent rows (about an hour of traffic
-- at 12k views/day) and is not loaded at all on Summary — so pivots read
-- "No data in this range", Web Vitals showed pages with 1-2 views, and the
-- sparklines only had 1 day of bars.
--
-- These queries belong in Postgres anyway: it can aggregate 70k rows in ~1s using
-- the covering index, where the browser can only ever see a truncated slice.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) PIVOTS — every dimension broken down by page group, in one call.
-- ---------------------------------------------------------------------------
create or replace function public.dash_pivot(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select device, os, connection, referrer,
      case
        when path is null or path = '' or path = '/' then 'Homepage'
        when path like '/collections%' then 'Collections'
        when path like '/products%'    then 'Products'
        when path like '/cart%'        then 'Cart'
        when path like '/pages%'       then 'Pages'
        when path like '/apps%'        then 'Apps'
        else 'Other'
      end as grp
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
  ),
  d as (select coalesce(nullif(initcap(device),''),'Other') k, grp, count(*) c from w group by 1,2),
  o as (select coalesce(nullif(os,''),'Other') k, grp, count(*) c from w group by 1,2),
  n as (select coalesce(nullif(connection,''),'unknown') k, grp, count(*) c from w group by 1,2),
  r as (select case
          when referrer is null or referrer = ''  then 'Direct'
          when referrer ilike '%instagram%'       then 'Instagram'
          when referrer ilike '%facebook%'        then 'Facebook'
          when referrer ilike '%google%'          then 'Google'
          when referrer ilike '%hashtageyewear%'  then 'Internal'
          else 'Other' end k, grp, count(*) c from w group by 1,2)
  select json_build_object(
    'device', (select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from d),
    'os',     (select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from o),
    'net',    (select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from n),
    'ref',    (select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from r),
    'total',  (select count(*) from w)
  ) into result;
  return result;
end;
$$;
grant execute on function public.dash_pivot(timestamptz, timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- 2) PER-PAGE × DEVICE metrics — powers the Web Vitals table and the
--    current values in Monitors.
-- ---------------------------------------------------------------------------
create or replace function public.dash_pages(p_from timestamptz, p_to timestamptz, p_limit int default 60)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select path, device, lcp, inp, cls, fcp, ttfb
    from public.rum_events
    where created_at >= p_from and created_at <= p_to and path is not null
  ),
  top as (select path from w group by path order by count(*) desc limit p_limit),
  agg as (
    select w.path, coalesce(nullif(w.device,''),'other') device, count(*) n,
           percentile_cont(0.75) within group (order by w.lcp)  lcp,
           percentile_cont(0.75) within group (order by w.inp)  inp,
           percentile_cont(0.75) within group (order by w.cls)  cls,
           percentile_cont(0.75) within group (order by w.fcp)  fcp,
           percentile_cont(0.75) within group (order by w.ttfb) ttfb
    from w join top t on t.path = w.path
    group by 1,2
  )
  select coalesce(json_agg(json_build_array(path,device,n,lcp,inp,cls,fcp,ttfb) order by n desc),'[]'::json)
  into result from agg;
  return result;
end;
$$;
grant execute on function public.dash_pages(timestamptz, timestamptz, int) to anon;

-- ---------------------------------------------------------------------------
-- 3) PER-PAGE × DEVICE × DAY — powers the 10-day sparklines in Monitors.
--    Restricted to the busiest paths so the grouping stays cheap.
-- ---------------------------------------------------------------------------
create or replace function public.dash_page_daily(p_from timestamptz, p_to timestamptz, p_limit int default 25)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select path, device, created_at, lcp, inp, cls, fcp, ttfb
    from public.rum_events
    where created_at >= p_from and created_at <= p_to and path is not null
  ),
  top as (select path from w group by path order by count(*) desc limit p_limit),
  agg as (
    select w.path, coalesce(nullif(w.device,''),'other') device,
           date_trunc('day', w.created_at)::date d, count(*) n,
           percentile_cont(0.75) within group (order by w.lcp)  lcp,
           percentile_cont(0.75) within group (order by w.inp)  inp,
           percentile_cont(0.75) within group (order by w.cls)  cls,
           percentile_cont(0.75) within group (order by w.fcp)  fcp,
           percentile_cont(0.75) within group (order by w.ttfb) ttfb
    from w join top t on t.path = w.path
    group by 1,2,3
  )
  select coalesce(json_agg(json_build_array(path,device,d,n,lcp,inp,cls,fcp,ttfb) order by d),'[]'::json)
  into result from agg;
  return result;
end;
$$;
grant execute on function public.dash_page_daily(timestamptz, timestamptz, int) to anon;

analyze public.rum_events;

-- Verify:
--   select public.dash_pivot(now() - interval '7 days', now());
--   select public.dash_pages(now() - interval '7 days', now());
--   select public.dash_page_daily(now() - interval '10 days', now());
