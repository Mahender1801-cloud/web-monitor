-- ============================================================================
-- Speed fix for the two heavy Health RPCs.  Run in Supabase -> SQL Editor.
--
-- Measured after monitoring_v2.sql landed:
--     slo_status ……………………… 19.4s   (near the timeout)
--     regression_attribution …… timed out
--
-- Cause in both: traffic_channel() was evaluated PER ROW, so a 7-day window meant
-- ~250k function calls for the SLO and ~500k for the attribution (it reads two
-- windows). The classifier only depends on utm_source / utm_medium / gclid /
-- fbclid / referrer-host, so we group by those inputs FIRST — collapsing hundreds
-- of thousands of rows into a few hundred combinations — and classify once per
-- combination instead of once per row.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SLO: group by the classifier's inputs, then classify.
-- ---------------------------------------------------------------------------
create or replace function public.slo_status(
  p_from timestamptz, p_to timestamptz, p_target numeric default 0.95, p_budget_ms int default 2500
) returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json;
begin
  with raw as (
    select coalesce(nullif(device,''),'other')      as device,
           split_part(coalesce(referrer,''),'/',3)  as ref_host,   -- host is enough for the classifier
           utm_source, utm_medium, gclid, fbclid,
           count(*)                                  as n,
           count(*) filter (where lcp <= p_budget_ms) as good
    from public.rum_events
    where created_at >= p_from and created_at <= p_to and lcp is not null
    group by 1,2,3,4,5,6
  ),
  seg as (
    select public.traffic_channel(ref_host, utm_source, utm_medium, gclid, fbclid) as ch,
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

-- ---------------------------------------------------------------------------
-- Regression attribution: one narrow scan per window, classify after grouping,
-- and compute each dimension's percentiles separately rather than over a
-- five-way UNION of the whole window.
-- ---------------------------------------------------------------------------
create or replace function public.regression_attribution(
  p_from timestamptz, p_to timestamptz, p_metric text default 'lcp'
) returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json; span interval;
begin
  span := p_to - p_from;

  with cur as materialized (
    select coalesce(nullif(device,''),'other') device,
           coalesce(nullif(os,''),'Other') os,
           coalesce(nullif(connection,''),'unknown') net,
           split_part(coalesce(referrer,''),'/',3) ref_host,
           utm_source, utm_medium, gclid, fbclid,
           case when path like '/products%' then '/products'
                when path like '/collections%' then '/collections'
                when path is null or path='' or path='/' then 'Homepage'
                else 'other' end pg,
           case p_metric when 'inp' then inp when 'cls' then cls else lcp end v
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
      and (case p_metric when 'inp' then inp when 'cls' then cls else lcp end) is not null
  ),
  prev as materialized (
    select coalesce(nullif(device,''),'other') device,
           coalesce(nullif(os,''),'Other') os,
           coalesce(nullif(connection,''),'unknown') net,
           split_part(coalesce(referrer,''),'/',3) ref_host,
           utm_source, utm_medium, gclid, fbclid,
           case when path like '/products%' then '/products'
                when path like '/collections%' then '/collections'
                when path is null or path='' or path='/' then 'Homepage'
                else 'other' end pg,
           case p_metric when 'inp' then inp when 'cls' then cls else lcp end v
    from public.rum_events
    where created_at >= p_from - span and created_at < p_from
      and (case p_metric when 'inp' then inp when 'cls' then cls else lcp end) is not null
  ),
  a as (
    select 'device' d, device k, count(*) n, percentile_cont(0.75) within group (order by v) p from cur group by 2
    union all select 'os',      os,  count(*), percentile_cont(0.75) within group (order by v) from cur group by 2
    union all select 'network', net, count(*), percentile_cont(0.75) within group (order by v) from cur group by 2
    union all select 'page',    pg,  count(*), percentile_cont(0.75) within group (order by v) from cur group by 2
    union all select 'channel',
             public.traffic_channel(ref_host, utm_source, utm_medium, gclid, fbclid),
             count(*), percentile_cont(0.75) within group (order by v)
             from cur group by 2
  ),
  b as (
    select 'device' d, device k, count(*) n, percentile_cont(0.75) within group (order by v) p from prev group by 2
    union all select 'os',      os,  count(*), percentile_cont(0.75) within group (order by v) from prev group by 2
    union all select 'network', net, count(*), percentile_cont(0.75) within group (order by v) from prev group by 2
    union all select 'page',    pg,  count(*), percentile_cont(0.75) within group (order by v) from prev group by 2
    union all select 'channel',
             public.traffic_channel(ref_host, utm_source, utm_medium, gclid, fbclid),
             count(*), percentile_cont(0.75) within group (order by v)
             from prev group by 2
  )
  select coalesce(json_agg(json_build_array(d, k, now_p, was_p, n) order by delta desc), '[]'::json)
  into result
  from (
    select a.d, a.k, round(a.p) now_p, round(b.p) was_p, a.n, (a.p - b.p) delta
    from a join b on a.d = b.d and a.k = b.k
    where a.n >= 200 and b.p > 0 and a.p > b.p
    order by delta desc limit 12
  ) t;
  return result;
end $$;
grant execute on function public.regression_attribution(timestamptz, timestamptz, text) to anon;

-- Verify (both should be a couple of seconds):
--   select public.slo_status(now() - interval '7 days', now());
--   select public.regression_attribution(now() - interval '1 day', now(), 'lcp');
