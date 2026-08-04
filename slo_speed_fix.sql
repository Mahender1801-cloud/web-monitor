-- ============================================================================
-- slo_status: the real fix.  Run in Supabase -> SQL Editor.
--
-- The previous attempt grouped by the classifier's raw inputs, including gclid and
-- fbclid. Those are per-click identifiers — every row has a different one — so the
-- GROUP BY produced roughly as many groups as rows and collapsed nothing. It still
-- took 19.8s.
--
-- Only the PRESENCE of a click id matters to traffic_channel(), never its value.
-- Grouping on a boolean instead reduces a 7-day window to a few hundred groups.
-- ============================================================================
create or replace function public.slo_status(
  p_from timestamptz, p_to timestamptz, p_target numeric default 0.95, p_budget_ms int default 2500
) returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json;
begin
  with raw as (
    select coalesce(nullif(device,''),'other')             as device,
           split_part(coalesce(referrer,''),'/',3)         as ref_host,
           nullif(utm_source,'')                           as utm_source,
           nullif(utm_medium,'')                           as utm_medium,
           (gclid  is not null and gclid  <> '')           as has_gclid,
           (fbclid is not null and fbclid <> '')           as has_fbclid,
           count(*)                                        as n,
           count(*) filter (where lcp <= p_budget_ms)      as good
    from public.rum_events
    where created_at >= p_from and created_at <= p_to and lcp is not null
    group by 1,2,3,4,5,6
  ),
  seg as (
    select public.traffic_channel(
             ref_host, utm_source, utm_medium,
             case when has_gclid  then 'x' end,     -- only presence matters
             case when has_fbclid then 'x' end
           ) as ch,
           device, sum(n) n, sum(good) good
    from raw group by 1,2 having sum(n) >= 200
  ),
  tot as (select sum(n) n, sum(good) good from raw)
  select json_build_object(
    'target', p_target, 'budget_ms', p_budget_ms,
    'overall', (select json_build_object('n', n, 'good', good,
                  'ratio', round(good::numeric / nullif(n,0), 4)) from tot),
    'segments', (select coalesce(json_agg(json_build_array(
                    ch, device, n, good, round(good::numeric/n, 4),
                    round(((good::numeric/n) - p_target) / nullif(1 - p_target, 0), 3)
                  ) order by n desc), '[]'::json) from seg)
  ) into result;
  return result;
end $$;
grant execute on function public.slo_status(timestamptz, timestamptz, numeric, int) to anon;

-- Verify — should now be a couple of seconds:
--   select public.slo_status(now() - interval '7 days', now());
