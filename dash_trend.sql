-- ============================================================================
-- Flexible trend series for the interactive chart. Run ONCE in Supabase.
--   p_metric : 'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb'
--   p_bucket : 'minute' | 'hour' | 'day'   (drill-down granularity)
-- Returns [[bucket_ts, p75, sample_count], ...] computed over EVERY row.
-- Called twice by the dashboard: current window + comparison window (dashed).
-- ============================================================================

create or replace function public.dash_trend(
  p_from timestamptz, p_to timestamptz, p_bucket text, p_metric text
) returns json
language sql
stable
set statement_timeout = '25s'
as $$
  with w as materialized (
    select created_at,
           case lower(p_metric)
             when 'inp'  then inp
             when 'cls'  then cls
             when 'fcp'  then fcp
             when 'ttfb' then ttfb
             else lcp
           end as v
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
  )
  select coalesce(json_agg(json_build_array(b, p, n) order by b), '[]'::json)
  from (
    select date_trunc(
             case when lower(p_bucket) in ('minute','hour','day') then lower(p_bucket) else 'hour' end,
             created_at) b,
           percentile_cont(0.75) within group (order by v) p,
           count(v) n
    from w
    group by 1
  ) t;
$$;

grant execute on function public.dash_trend(timestamptz, timestamptz, text, text) to anon;

-- Test:
--   select public.dash_trend(now()-interval '24 hours', now(), 'hour', 'lcp');
