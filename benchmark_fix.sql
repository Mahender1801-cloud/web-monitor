-- ============================================================================
-- Fill in our own PSI score and page weight in the brand table.
-- Run in Supabase -> SQL Editor.
--
-- Our row was built only from rum_daily, which holds field metrics and nothing
-- else, so PSI score and page weight came out blank while every competitor row was
-- complete. Both numbers already exist elsewhere in the project — the scheduled
-- PageSpeed run (psi_results) and the optimisation audit (total page weight) — so
-- the row is assembled from those instead of left half empty.
-- ============================================================================
create or replace function public.benchmark_report(p_strategy text default 'mobile')
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare
  result json;
  ours_lcp numeric; ours_inp numeric; ours_cls numeric;
  ours_psi int; ours_kb int;
begin
  -- field metrics from our own visitors, last 28 days
  select public.hist_pct(public.hist_sum(h_lcp), 50),
         public.hist_pct(public.hist_sum(h_inp), 10),
         public.hist_pct(public.hist_sum(h_cls), 0.005)
    into ours_lcp, ours_inp, ours_cls
  from public.rum_daily where d > current_date - 28;

  -- lab score: the most recent PageSpeed run for the home page on this strategy,
  -- falling back to the newest scored run of any page so the cell is not empty
  select perf_score into ours_psi
  from public.psi_results
  where strategy = p_strategy and perf_score is not null
  order by (url ~ '^https?://[^/]+/?$') desc, created_at desc
  limit 1;

  -- page weight from the optimisation audit's own measurement of the home page
  select nullif(regexp_replace(value, '[^0-9].*$', ''), '')::int into ours_kb
  from public.optimize_audit
  where name = 'Total page weight'
  order by (page ~ '^https?://[^/]+/?$') desc, created_at desc
  limit 1;

  with latest as (
    select distinct on (brand) brand, url, region, perf_score,
           lcp_field, inp_field, cls_field, lcp_lab, tbt_lab, weight_kb, requests, created_at
    from public.benchmarks
    where strategy = p_strategy and created_at > now() - interval '14 days'
    order by brand, created_at desc
  ),
  withus as (
    select brand, region, perf_score, lcp_field, inp_field, cls_field,
           nullif(weight_kb, 0) weight_kb, false as is_us
    from latest
    union all
    select 'Hashtag Eyewear', 'India', ours_psi, round(ours_lcp)::int, round(ours_inp)::int,
           round(ours_cls, 3), nullif(ours_kb, 0), true
  )
  select json_build_object(
    'strategy', p_strategy,
    'ours', json_build_object('lcp', round(ours_lcp), 'inp', round(ours_inp),
                              'cls', round(ours_cls,3), 'psi', ours_psi, 'kb', ours_kb),
    'rank_lcp', (select count(*) + 1 from withus where lcp_field is not null and lcp_field < ours_lcp and not is_us),
    'total',    (select count(*) from withus where lcp_field is not null),
    'median_lcp', (select percentile_cont(0.5) within group (order by lcp_field)
                   from withus where lcp_field is not null and not is_us),
    'median_psi', (select percentile_cont(0.5) within group (order by perf_score)
                   from withus where perf_score is not null and not is_us),
    'median_kb',  (select percentile_cont(0.5) within group (order by weight_kb)
                   from withus where weight_kb is not null and not is_us),
    'brands', (select coalesce(json_agg(json_build_array(
                 brand, region, perf_score, lcp_field, inp_field, cls_field, weight_kb, is_us
               ) order by (lcp_field is null), lcp_field), '[]'::json) from withus)
  ) into result;
  return result;
end $$;
grant execute on function public.benchmark_report(text) to anon;

-- Verify — the Hashtag Eyewear row should now carry a PSI score and a weight:
--   select public.benchmark_report('mobile');
