-- ============================================================================
-- Top brands benchmark.  Run in Supabase -> SQL Editor.
--
-- "Is 2.2s good?" has no answer without context. This stores PageSpeed results
-- for the leading eyewear retailers in India and worldwide, so the store can be
-- read against the market rather than against an abstract threshold.
--
-- The field figures come from Chrome UX Report — real visitors on those sites,
-- not a lab test — which is why this counts as live market data.
-- ============================================================================
create table if not exists public.benchmarks (
  id          bigserial primary key,
  brand       text not null,
  url         text not null,
  region      text,              -- India | Global
  strategy    text,              -- mobile | desktop
  perf_score  int,
  lcp_field   int,               -- CrUX p75, real users
  inp_field   int,
  cls_field   numeric,
  lcp_lab     int,
  tbt_lab     int,
  weight_kb   int,
  requests    int,
  created_at  timestamptz not null default now()
);
create index if not exists bench_created_idx on public.benchmarks (created_at desc);
create index if not exists bench_brand_idx   on public.benchmarks (brand, created_at desc);
alter table public.benchmarks enable row level security;
drop policy if exists sel_bench on public.benchmarks;
create policy sel_bench on public.benchmarks for select to anon using (true);

-- ---------------------------------------------------------------------------
-- Latest run per brand, with this store placed in the ranking.
-- ---------------------------------------------------------------------------
create or replace function public.benchmark_report(p_strategy text default 'mobile')
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json; ours_lcp numeric; ours_inp numeric; ours_cls numeric;
begin
  -- our own field numbers, measured from our own visitors over the last 28 days
  select public.hist_pct(public.hist_sum(h_lcp), 50),
         public.hist_pct(public.hist_sum(h_inp), 10),
         public.hist_pct(public.hist_sum(h_cls), 0.005)
    into ours_lcp, ours_inp, ours_cls
  from public.rum_daily where d > current_date - 28;

  with latest as (
    select distinct on (brand) brand, url, region, perf_score,
           lcp_field, inp_field, cls_field, lcp_lab, tbt_lab, weight_kb, requests, created_at
    from public.benchmarks
    where strategy = p_strategy and created_at > now() - interval '14 days'
    order by brand, created_at desc
  ),
  withus as (
    select brand, region, perf_score, lcp_field, inp_field, cls_field, weight_kb, false as is_us from latest
    union all
    select 'Hashtag Eyewear', 'India', null, round(ours_lcp)::int, round(ours_inp)::int,
           round(ours_cls, 3), null, true
  )
  select json_build_object(
    'strategy', p_strategy,
    'ours', json_build_object('lcp', round(ours_lcp), 'inp', round(ours_inp), 'cls', round(ours_cls,3)),
    'rank_lcp', (select count(*) + 1 from withus where lcp_field is not null and lcp_field < ours_lcp and not is_us),
    'total',    (select count(*) from withus where lcp_field is not null),
    'median_lcp', (select percentile_cont(0.5) within group (order by lcp_field)
                   from withus where lcp_field is not null and not is_us),
    'brands', (select coalesce(json_agg(json_build_array(
                 brand, region, perf_score, lcp_field, inp_field, cls_field, weight_kb, is_us
               ) order by (lcp_field is null), lcp_field), '[]'::json) from withus)
  ) into result;
  return result;
end $$;
grant execute on function public.benchmark_report(text) to anon;

-- Verify:  select public.benchmark_report('mobile');
