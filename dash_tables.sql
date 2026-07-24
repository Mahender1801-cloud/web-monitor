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

-- ---------------------------------------------------------------------------
-- 4) CORE WEB VITALS ASSESSMENT — the PageSpeed-style report, but from LIVE
--    real users instead of CrUX's 28-day rolling average.
--    Returns p75 AND the good / needs-improvement / poor distribution per metric,
--    which is what draws the coloured bars.
--    p_device: 'mobile' | 'desktop' | null (all)   p_path: exact path | null (all)
-- ---------------------------------------------------------------------------
create or replace function public.dash_cwv(
  p_from timestamptz, p_to timestamptz, p_device text default null, p_path text default null
) returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select lcp, inp, cls, fcp, ttfb
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
      and (p_device is null or device = p_device)
      and (p_path   is null or path   = p_path)
  )
  select json_build_object(
    'total', (select count(*) from w),
    'lcp', (select json_build_object('p75',percentile_cont(0.75) within group (order by lcp),
              'n',count(lcp),
              'good',count(*) filter (where lcp <= 2500),
              'ni',  count(*) filter (where lcp >  2500 and lcp <= 4000),
              'poor',count(*) filter (where lcp >  4000)) from w where lcp is not null),
    'inp', (select json_build_object('p75',percentile_cont(0.75) within group (order by inp),
              'n',count(inp),
              'good',count(*) filter (where inp <= 200),
              'ni',  count(*) filter (where inp >  200 and inp <= 500),
              'poor',count(*) filter (where inp >  500)) from w where inp is not null),
    'cls', (select json_build_object('p75',percentile_cont(0.75) within group (order by cls),
              'n',count(cls),
              'good',count(*) filter (where cls <= 0.1),
              'ni',  count(*) filter (where cls >  0.1 and cls <= 0.25),
              'poor',count(*) filter (where cls >  0.25)) from w where cls is not null),
    'fcp', (select json_build_object('p75',percentile_cont(0.75) within group (order by fcp),
              'n',count(fcp),
              'good',count(*) filter (where fcp <= 1800),
              'ni',  count(*) filter (where fcp >  1800 and fcp <= 3000),
              'poor',count(*) filter (where fcp >  3000)) from w where fcp is not null),
    'ttfb',(select json_build_object('p75',percentile_cont(0.75) within group (order by ttfb),
              'n',count(ttfb),
              'good',count(*) filter (where ttfb <= 800),
              'ni',  count(*) filter (where ttfb >  800 and ttfb <= 1800),
              'poor',count(*) filter (where ttfb >  1800)) from w where ttfb is not null)
  ) into result;
  return result;
end;
$$;
grant execute on function public.dash_cwv(timestamptz, timestamptz, text, text) to anon;

analyze public.rum_events;

-- Verify:
--   select public.dash_pivot(now() - interval '7 days', now());
--   select public.dash_pages(now() - interval '7 days', now());
--   select public.dash_page_daily(now() - interval '10 days', now());
--   select public.dash_cwv(now() - interval '7 days', now(), 'mobile');
