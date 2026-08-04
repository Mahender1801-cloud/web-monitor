-- ============================================================================
-- One helper for the QA task report.  Run once in Supabase -> SQL Editor.
--
-- The report needs a TRUE 75th percentile per page-group per day (Homepage,
-- Collection, Product, Cart) — the same basis Google uses for Core Web Vitals.
-- Doing that in the browser would mean pulling ~150k raw rows across the window;
-- this aggregates it server-side in one pass per day instead.
-- ============================================================================
create or replace function public.qa_day(p_day date)
returns json language plpgsql stable
set statement_timeout = '60s'
as $$
declare result json;
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
           count(*)                                            as views,
           percentile_cont(0.75) within group (order by lcp)    as lcp,
           percentile_cont(0.75) within group (order by inp)    as inp,
           percentile_cont(0.75) within group (order by cls)    as cls,
           count(lcp) as lcp_n, count(inp) as inp_n, count(cls) as cls_n
    from w group by grp
  )
  select json_build_object(
    'day',   p_day,
    'total', (select count(*) from w),
    'groups',(select coalesce(json_object_agg(grp, json_build_object(
                'views', views, 'lcp', lcp, 'inp', inp, 'cls', cls,
                'lcp_n', lcp_n, 'inp_n', inp_n, 'cls_n', cls_n)), '{}'::json) from g)
  ) into result;
  return result;
end $$;
grant execute on function public.qa_day(date) to anon;

-- Verify:  select public.qa_day('2026-07-20');
