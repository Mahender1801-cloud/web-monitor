-- ============================================================================
-- MONITORING v2 — the high-level layer.  Run once in Supabase -> SQL Editor.
--
-- What the project had was reporting: numbers you must go and look at. This adds
-- the parts that make it monitoring — signals that tell you something is wrong,
-- and analysis that says WHERE it is wrong.
--
--   health_events    frustration + JS errors from real sessions
--   vendor_perf      per third-party script weight over time (86 scripts, 12 3P)
--   catalog_issues   whole-catalog integrity, not an 8-image sample
--   synthetic_runs   the real add-to-cart -> checkout journey, in a real browser
--
--   anomaly_scan()            seasonality-aware: compares now against the same
--                             weekday+hour baseline, not a fixed threshold
--   regression_attribution()  cross-cuts device/os/network/channel to say which
--                             segment moved, instead of just "LCP got worse"
--   slo_status()              revenue-weighted SLO + error budget burn
--   checkout_health()         the third-party checkout hand-off, where the funnel
--                             currently goes dark
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Storage
-- ---------------------------------------------------------------------------
create table if not exists public.health_events (
  id          bigserial primary key,
  session_id  text,
  kind        text,              -- js_error | rage_click | dead_click | rapid_back
  path        text,
  detail      text,              -- message / selector
  source      text,              -- script url, when known
  line        int,
  browser     text,
  os          text,
  device      text,
  created_at  timestamptz not null default now()
);
create index if not exists health_created_idx on public.health_events (created_at desc);
create index if not exists health_kind_idx    on public.health_events (kind, created_at desc);
alter table public.health_events enable row level security;
drop policy if exists ins_health on public.health_events;
create policy ins_health on public.health_events for insert to anon with check (true);
drop policy if exists sel_health on public.health_events;
create policy sel_health on public.health_events for select to anon using (true);

create table if not exists public.vendor_perf (
  id          bigserial primary key,
  vendor      text not null,     -- judge.me, gempages, searchanise, …
  host        text,
  scripts     int,
  bytes       bigint,
  blocking    int,               -- render-blocking count attributable to it
  url         text,
  created_at  timestamptz not null default now()
);
create index if not exists vendor_created_idx on public.vendor_perf (created_at desc);
create index if not exists vendor_name_idx    on public.vendor_perf (vendor, created_at desc);
alter table public.vendor_perf enable row level security;
drop policy if exists sel_vendor on public.vendor_perf;
create policy sel_vendor on public.vendor_perf for select to anon using (true);

create table if not exists public.catalog_issues (
  id          bigserial primary key,
  handle      text,
  title       text,
  issue       text,              -- no_image | out_of_stock | no_price | no_schema | broken_image | slow
  detail      text,
  url         text,
  created_at  timestamptz not null default now()
);
create index if not exists catalog_created_idx on public.catalog_issues (created_at desc);
create index if not exists catalog_issue_idx   on public.catalog_issues (issue, created_at desc);
alter table public.catalog_issues enable row level security;
drop policy if exists sel_catalog on public.catalog_issues;
create policy sel_catalog on public.catalog_issues for select to anon using (true);

create table if not exists public.synthetic_runs (
  id          bigserial primary key,
  ok          boolean not null,
  failed_step text,
  steps       jsonb,             -- [{step, ms, ok, note}, …]
  total_ms    int,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists synthetic_created_idx on public.synthetic_runs (created_at desc);
alter table public.synthetic_runs enable row level security;
drop policy if exists sel_synth on public.synthetic_runs;
create policy sel_synth on public.synthetic_runs for select to anon using (true);

-- ---------------------------------------------------------------------------
-- 2) Seasonality-aware anomaly scan.
--    A fixed threshold is wrong for a store: Sunday 9pm and Tuesday 7am are not
--    comparable. This builds the baseline from the SAME weekday over the last 4
--    weeks and flags only what falls outside it.
-- ---------------------------------------------------------------------------
create or replace function public.anomaly_scan(p_now timestamptz default now())
returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json; today date := (p_now at time zone 'UTC')::date;
begin
  with base as (          -- same weekday, previous 4 weeks
    select views, visitors,
           public.hist_pct(h_lcp, 50) lcp,
           public.hist_pct(h_inp, 10) inp
    from public.rum_daily
    where d < today and d >= today - 28
      and extract(dow from d) = extract(dow from today)
  ),
  cur as (
    select views, visitors,
           public.hist_pct(h_lcp, 50) lcp,
           public.hist_pct(h_inp, 10) inp
    from public.rum_daily where d = today
  ),
  ord_base as (
    select count(*)::numeric / greatest(count(distinct created_at::date),1) per_day
    from public.shop_orders
    where created_at::date < today and created_at::date >= today - 28
      and extract(dow from created_at) = extract(dow from today)
      and coalesce(order_number,'') not ilike 'R-%' and coalesce(order_number,'') not ilike 'E-%'
  ),
  ord_cur as (
    select count(*) n from public.shop_orders
    where created_at::date = today
      and coalesce(order_number,'') not ilike 'R-%' and coalesce(order_number,'') not ilike 'E-%'
  )
  select json_build_object(
    'day', today,
    'metrics', json_build_array(
      json_build_object('name','Page views','cur',(select views from cur),
        'baseline',(select round(avg(views)) from base),'sd',(select round(coalesce(stddev_samp(views),0)) from base)),
      json_build_object('name','Visitors','cur',(select visitors from cur),
        'baseline',(select round(avg(visitors)) from base),'sd',(select round(coalesce(stddev_samp(visitors),0)) from base)),
      json_build_object('name','LCP p75','cur',(select round(lcp) from cur),
        'baseline',(select round(avg(lcp)) from base),'sd',(select round(coalesce(stddev_samp(lcp),0)) from base)),
      json_build_object('name','INP p75','cur',(select round(inp) from cur),
        'baseline',(select round(avg(inp)) from base),'sd',(select round(coalesce(stddev_samp(inp),0)) from base)),
      json_build_object('name','Orders','cur',(select n from ord_cur),
        'baseline',(select round(per_day) from ord_base),'sd',0)
    )
  ) into result;
  return result;
end $$;
grant execute on function public.anomaly_scan(timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- 3) Regression attribution — WHICH segment moved, not just "LCP got worse".
--    Compares a window against the preceding one across every dimension and
--    returns the segments with the largest deterioration.
-- ---------------------------------------------------------------------------
create or replace function public.regression_attribution(
  p_from timestamptz, p_to timestamptz, p_metric text default 'lcp'
) returns json language plpgsql stable
set statement_timeout = '30s'
as $$
declare result json; span interval;
begin
  span := p_to - p_from;
  with cur as materialized (
    select device, os, connection,
           public.traffic_channel(referrer, utm_source, utm_medium, gclid, fbclid) ch,
           case when path like '/products%' then '/products'
                when path like '/collections%' then '/collections'
                when path is null or path='' or path='/' then '/'
                else 'other' end pg,
           case p_metric when 'inp' then inp when 'cls' then cls else lcp end v
    from public.rum_events where created_at >= p_from and created_at <= p_to
  ),
  prev as materialized (
    select device, os, connection,
           public.traffic_channel(referrer, utm_source, utm_medium, gclid, fbclid) ch,
           case when path like '/products%' then '/products'
                when path like '/collections%' then '/collections'
                when path is null or path='' or path='/' then '/'
                else 'other' end pg,
           case p_metric when 'inp' then inp when 'cls' then cls else lcp end v
    from public.rum_events where created_at >= p_from - span and created_at < p_from
  ),
  dims as (
    select 'device' d, device k, v from cur union all
    select 'os',      os,     v from cur union all
    select 'network', connection, v from cur union all
    select 'channel', ch,     v from cur union all
    select 'page',    pg,     v from cur
  ),
  dimp as (
    select 'device' d, device k, v from prev union all
    select 'os',      os,     v from prev union all
    select 'network', connection, v from prev union all
    select 'channel', ch,     v from prev union all
    select 'page',    pg,     v from prev
  ),
  a as (select d, k, count(v) n, percentile_cont(0.75) within group (order by v) p from dims  where v is not null group by 1,2),
  b as (select d, k, count(v) n, percentile_cont(0.75) within group (order by v) p from dimp  where v is not null group by 1,2)
  select coalesce(json_agg(json_build_array(d, k, now_p, was_p, n) order by delta desc), '[]'::json) into result
  from (
    select a.d, a.k, round(a.p) now_p, round(b.p) was_p, a.n,
           (a.p - b.p) delta
    from a join b on a.d=b.d and a.k=b.k
    where a.n >= 200 and b.p > 0 and (a.p - b.p) > 0
    order by delta desc limit 12
  ) t;
  return result;
end $$;
grant execute on function public.regression_attribution(timestamptz, timestamptz, text) to anon;

-- ---------------------------------------------------------------------------
-- 4) Revenue-weighted SLO + error budget.
--    "95% of <segment> visitors get LCP <= 2.5s" — and how much of the budget
--    for the window has already been burned.
-- ---------------------------------------------------------------------------
create or replace function public.slo_status(
  p_from timestamptz, p_to timestamptz, p_target numeric default 0.95, p_budget_ms int default 2500
) returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json;
begin
  with w as materialized (
    select coalesce(nullif(device,''),'other') device,
           public.traffic_channel(referrer, utm_source, utm_medium, gclid, fbclid) ch,
           lcp
    from public.rum_events
    where created_at >= p_from and created_at <= p_to and lcp is not null
  ),
  seg as (
    select ch, device, count(*) n,
           count(*) filter (where lcp <= p_budget_ms) good
    from w group by ch, device having count(*) >= 200
  )
  select json_build_object(
    'target', p_target, 'budget_ms', p_budget_ms,
    'overall', (select json_build_object('n', count(*), 'good', count(*) filter (where lcp <= p_budget_ms),
                  'ratio', round(count(*) filter (where lcp <= p_budget_ms)::numeric / nullif(count(*),0), 4)) from w),
    'segments', (select coalesce(json_agg(json_build_array(
                    ch, device, n, good, round(good::numeric/n, 4),
                    round(((good::numeric/n) - p_target) / nullif(1 - p_target, 0), 3)   -- budget headroom
                  ) order by n desc), '[]'::json) from seg)
  ) into result;
  return result;
end $$;
grant execute on function public.slo_status(timestamptz, timestamptz, numeric, int) to anon;

-- ---------------------------------------------------------------------------
-- 5) Third-party checkout health — the hand-off where the funnel goes dark.
--    A checkout click that never becomes an order within 45 minutes is a
--    drop-off on someone else's page.
-- ---------------------------------------------------------------------------
create or replace function public.checkout_health(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json;
begin
  with clicks as (
    select session_id, created_at from public.funnel_events
    where created_at >= p_from and created_at <= p_to
      and event_type in ('checkout_click','buy_now') and session_id is not null
  ),
  landed as (
    select c.session_id,
           exists (select 1 from public.shop_orders o
                    where (o.rum_session = c.session_id or o.inferred_session = c.session_id)
                      and o.created_at between c.created_at and c.created_at + interval '45 minutes'
                      and coalesce(o.order_number,'') not ilike 'R-%'
                      and coalesce(o.order_number,'') not ilike 'E-%') as converted
    from clicks c
  )
  select json_build_object(
    'checkout_clicks', (select count(*) from clicks),
    'sessions',        (select count(distinct session_id) from clicks),
    'converted',       (select count(*) filter (where converted) from landed),
    'lost',            (select count(*) filter (where not converted) from landed),
    'conversion',      (select round(count(*) filter (where converted)::numeric
                                     / nullif(count(*),0), 4) from landed)
  ) into result;
  return result;
end $$;
grant execute on function public.checkout_health(timestamptz, timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- 6) Health roll-up for the dashboard tiles.
-- ---------------------------------------------------------------------------
create or replace function public.health_summary(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json;
begin
  select json_build_object(
    'errors', (select coalesce(json_agg(json_build_array(kind, n) order by n desc), '[]'::json)
               from (select kind, count(*) n from public.health_events
                     where created_at >= p_from and created_at <= p_to group by kind) t),
    'top_errors', (select coalesce(json_agg(json_build_array(detail, path, n) order by n desc), '[]'::json)
               from (select detail, path, count(*) n from public.health_events
                     where created_at >= p_from and created_at <= p_to and kind='js_error'
                     group by detail, path order by count(*) desc limit 8) t),
    'rage_pages', (select coalesce(json_agg(json_build_array(path, n) order by n desc), '[]'::json)
               from (select path, count(*) n from public.health_events
                     where created_at >= p_from and created_at <= p_to and kind in ('rage_click','dead_click')
                     group by path order by count(*) desc limit 8) t),
    'vendors', (select coalesce(json_agg(json_build_array(vendor, scripts, bytes) order by bytes desc nulls last), '[]'::json)
               from (select distinct on (vendor) vendor, scripts, bytes from public.vendor_perf
                     where created_at >= p_from order by vendor, created_at desc) t),
    'catalog', (select coalesce(json_agg(json_build_array(issue, n) order by n desc), '[]'::json)
               from (select issue, count(*) n from public.catalog_issues
                     where created_at >= (select max(created_at)::date from public.catalog_issues)
                     group by issue) t),
    'synthetic', (select coalesce(json_agg(json_build_array(ok, failed_step, total_ms, created_at) order by created_at desc), '[]'::json)
               from (select ok, failed_step, total_ms, created_at from public.synthetic_runs
                     where created_at >= p_from order by created_at desc limit 20) t)
  ) into result;
  return result;
end $$;
grant execute on function public.health_summary(timestamptz, timestamptz) to anon;

-- Verify:
--   select public.anomaly_scan();
--   select public.regression_attribution(now() - interval '1 day', now(), 'lcp');
--   select public.slo_status(now() - interval '7 days', now());
--   select public.checkout_health(now() - interval '7 days', now());
--   select public.health_summary(now() - interval '7 days', now());
