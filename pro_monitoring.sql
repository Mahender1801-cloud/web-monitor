-- ============================================================================
-- PROFESSIONAL LAYER — run once in Supabase -> SQL Editor.
--
-- Everything before this answered "what is happening". This answers the three
-- questions that make a monitoring tool worth opening:
--
--   so what?          speed_revenue()  — conversion by speed band, measured on
--                                        THIS store's own orders, and the revenue
--                                        sitting behind the slow band
--   what first?       priorities()     — one ranked list across every source,
--                                        scored by money and effort
--   did my fix work?  deploys / deploy_effect() — metrics before vs after each
--                                        theme release
--   tell me when it breaks  alerts + alert_scan()
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Speed -> money, from this store's own data.
--
-- HONEST SCOPE: this is a correlation, not a proof. Slow sessions also skew to
-- older phones and weaker networks, and those shoppers may convert differently
-- for reasons other than speed. It is still far better than quoting an industry
-- "100ms = 1%" rule, because it is measured here. The UI says so as well.
-- ---------------------------------------------------------------------------
create or replace function public.speed_revenue(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '30s'
as $$
declare result json;
begin
  with sess as materialized (
    select session_id,
           percentile_cont(0.75) within group (order by lcp) lcp
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
      and session_id is not null and lcp is not null
    group by session_id
  ),
  buyers as (
    select distinct coalesce(rum_session, inferred_session) sid
    from public.shop_orders
    where created_at >= p_from and created_at <= p_to
      and coalesce(order_number,'') not ilike 'R-%'
      and coalesce(order_number,'') not ilike 'E-%'
      and coalesce(rum_session, inferred_session) is not null
  ),
  banded as (
    select case when s.lcp <= 2500 then 'Fast (<=2.5s)'
                when s.lcp <= 4000 then 'Moderate (2.5-4s)'
                else 'Slow (>4s)' end band,
           case when s.lcp <= 2500 then 1 when s.lcp <= 4000 then 2 else 3 end ord,
           (b.sid is not null) bought
    from sess s left join buyers b on b.sid = s.session_id
  ),
  agg as (
    select band, ord, count(*) sessions, count(*) filter (where bought) orders,
           count(*) filter (where bought)::numeric / nullif(count(*),0) cvr
    from banded group by band, ord
  ),
  aov as (
    select coalesce(avg(total_price),0) v from public.shop_orders
    where created_at >= p_from and created_at <= p_to
      and coalesce(order_number,'') not ilike 'R-%'
      and coalesce(order_number,'') not ilike 'E-%'
  ),
  fast as (select cvr from agg where ord = 1)
  select json_build_object(
    'aov',   (select round(v) from aov),
    'bands', (select coalesce(json_agg(json_build_array(band, sessions, orders, round(cvr*100,3)) order by ord), '[]'::json) from agg),
    -- what the non-fast sessions would have produced at the fast band's rate
    'lost_orders',  (select round(sum(greatest((select cvr from fast) - a.cvr, 0) * a.sessions))
                     from agg a where a.ord > 1),
    'lost_revenue', (select round(sum(greatest((select cvr from fast) - a.cvr, 0) * a.sessions) * (select v from aov))
                     from agg a where a.ord > 1),
    'slow_sessions',(select coalesce(sum(sessions),0) from agg where ord > 1),
    'days', round(extract(epoch from (p_to - p_from))/86400.0, 1)
  ) into result;
  return result;
end $$;
grant execute on function public.speed_revenue(timestamptz, timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- 2) Deploy detection + effect.
--    Shopify fingerprints theme assets (theme.js?v=123456). When that changes,
--    something shipped — which is exactly the moment to compare metrics.
-- ---------------------------------------------------------------------------
create table if not exists public.deploys (
  id         bigserial primary key,
  version    text unique,
  detected_at timestamptz not null default now(),
  note       text
);
alter table public.deploys enable row level security;
drop policy if exists sel_deploys on public.deploys;
create policy sel_deploys on public.deploys for select to anon using (true);

create or replace function public.deploy_effect()
returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json;
begin
  with d as (
    select id, version, detected_at from public.deploys
    where detected_at > now() - interval '30 days'
    order by detected_at desc limit 6
  ),
  eff as (
    select d.version, d.detected_at,
      (select public.hist_pct(public.hist_sum(h_lcp), 50) from public.rum_daily
        where d2.d >= (d.detected_at - interval '3 days')::date and d2.d < d.detected_at::date) as lcp_before,
      (select public.hist_pct(public.hist_sum(h_lcp), 50) from public.rum_daily d3
        where d3.d >= d.detected_at::date and d3.d <= (d.detected_at + interval '3 days')::date) as lcp_after
    from d, lateral (select * from public.rum_daily) d2
    group by d.version, d.detected_at, d.id
  )
  select coalesce(json_agg(json_build_array(version, detected_at, lcp_before, lcp_after) order by detected_at desc), '[]'::json)
  into result from eff;
  return result;
end $$;
grant execute on function public.deploy_effect() to anon;

-- ---------------------------------------------------------------------------
-- 3) Alerts — the difference between a report and a monitor.
-- ---------------------------------------------------------------------------
create table if not exists public.alerts (
  id         bigserial primary key,
  severity   text not null,          -- critical | warning | info
  title      text not null,
  detail     text,
  source     text,                   -- synthetic | orders | speed | errors | catalog
  value      text,
  acknowledged boolean default false,
  created_at timestamptz not null default now()
);
create index if not exists alerts_created_idx on public.alerts (created_at desc);
create index if not exists alerts_open_idx on public.alerts (acknowledged, created_at desc);
alter table public.alerts enable row level security;
drop policy if exists sel_alerts on public.alerts;
create policy sel_alerts on public.alerts for select to anon using (true);
drop policy if exists upd_alerts on public.alerts;
create policy upd_alerts on public.alerts for update to anon using (true) with check (true);
grant update (acknowledged) on public.alerts to anon;

-- Evaluate the current state and raise anything that deserves attention.
-- Deduplicates: the same title is not re-raised while it is still open.
create or replace function public.alert_scan()
returns int language plpgsql
security definer set search_path = public, pg_temp
set statement_timeout = '40s'
as $$
declare n int := 0;
  v_orders int; v_base numeric; v_synth boolean; v_synth_step text;
  v_err int; v_err_prev int; v_fastratio numeric;
begin
  -- a) orders have stopped relative to the same weekday
  select count(*) into v_orders from public.shop_orders
   where created_at > now() - interval '3 hours'
     and coalesce(order_number,'') not ilike 'R-%' and coalesce(order_number,'') not ilike 'E-%';
  select avg(c) into v_base from (
    select count(*) c from public.shop_orders
     where created_at > now() - interval '28 days'
       and extract(dow from created_at) = extract(dow from now())
       and extract(hour from created_at) between extract(hour from now()) - 3 and extract(hour from now())
       and coalesce(order_number,'') not ilike 'R-%' and coalesce(order_number,'') not ilike 'E-%'
     group by created_at::date) t;
  if v_base >= 3 and v_orders = 0 then
    insert into public.alerts (severity,title,detail,source,value)
    select 'critical','No orders in the last 3 hours',
           'Normally about '||round(v_base)||' orders arrive in this window on this weekday.','orders',v_orders::text
    where not exists (select 1 from public.alerts where title='No orders in the last 3 hours'
                       and not acknowledged and created_at > now() - interval '6 hours');
    n := n + 1;
  end if;

  -- b) the purchase path is broken
  select ok, failed_step into v_synth, v_synth_step from public.synthetic_runs order by created_at desc limit 1;
  if v_synth is false then
    insert into public.alerts (severity,title,detail,source,value)
    select 'critical','Purchase path failing',
           'The synthetic journey could not get past: '||coalesce(v_synth_step,'?'),'synthetic',v_synth_step
    where not exists (select 1 from public.alerts where title='Purchase path failing'
                       and not acknowledged and created_at > now() - interval '3 hours');
    n := n + 1;
  end if;

  -- c) JS errors spiking against the previous day
  select count(*) into v_err from public.health_events
    where kind='js_error' and created_at > now() - interval '24 hours';
  select count(*) into v_err_prev from public.health_events
    where kind='js_error' and created_at between now() - interval '48 hours' and now() - interval '24 hours';
  if v_err_prev > 50 and v_err > v_err_prev * 2 then
    insert into public.alerts (severity,title,detail,source,value)
    select 'warning','JavaScript errors have doubled',
           v_err||' in the last 24h against '||v_err_prev||' the day before. Usually a deploy or a failing app.','errors',v_err::text
    where not exists (select 1 from public.alerts where title='JavaScript errors have doubled'
                       and not acknowledged and created_at > now() - interval '12 hours');
    n := n + 1;
  end if;

  -- d) speed SLO breached
  select count(*) filter (where lcp <= 2500)::numeric / nullif(count(*),0) into v_fastratio
    from public.rum_events where created_at > now() - interval '24 hours' and lcp is not null;
  if v_fastratio is not null and v_fastratio < 0.75 then
    insert into public.alerts (severity,title,detail,source,value)
    select 'warning','Speed below target',
           round(v_fastratio*100)||'% of visitors got LCP under 2.5s in the last 24h; the target is 95%.','speed',
           round(v_fastratio*100)||'%'
    where not exists (select 1 from public.alerts where title='Speed below target'
                       and not acknowledged and created_at > now() - interval '24 hours');
    n := n + 1;
  end if;

  return n;
end $$;
grant execute on function public.alert_scan() to anon;

create or replace function public.open_alerts()
returns json language sql stable as $$
  select coalesce(json_agg(json_build_array(id, severity, title, detail, source, value, created_at)
                           order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end,
                                    created_at desc), '[]'::json)
  from public.alerts where not acknowledged and created_at > now() - interval '7 days';
$$;
grant execute on function public.open_alerts() to anon;

-- ---------------------------------------------------------------------------
-- 4) One ranked list of what to do next, across every source.
-- ---------------------------------------------------------------------------
create or replace function public.priorities(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '30s'
as $$
declare result json; sr json; aov numeric; slow_sessions bigint; lost numeric;
begin
  select public.speed_revenue(p_from, p_to) into sr;
  aov  := coalesce((sr->>'aov')::numeric, 0);
  lost := coalesce((sr->>'lost_revenue')::numeric, 0);
  slow_sessions := coalesce((sr->>'slow_sessions')::bigint, 0);

  with opt as (
    select area, name, status, value, advice
    from public.optimize_audit
    where created_at >= (select max(created_at) - interval '20 minutes' from public.optimize_audit)
      and status <> 'pass'
  ),
  ranked as (
    -- Money is attributed to the speed-related work, because that is the only
    -- link this store can actually evidence. Everything else is ranked by how
    -- directly it blocks a purchase.
    select distinct on (name)
      case when area = 'Images' then 1 when area = 'JavaScript' then 2
           when area = 'CSS' then 3 else 4 end as tier,
      area, name, status, value, advice,
      case when area in ('Images','JavaScript','CSS') and status = 'fail'
           then round(lost * 0.25) else 0 end as money
    from opt order by name, case status when 'fail' then 0 else 1 end
  )
  select json_build_object(
    'aov', aov, 'lost_revenue', lost, 'slow_sessions', slow_sessions,
    'items', (select coalesce(json_agg(json_build_array(area, name, status, value, advice, money)
                              order by case status when 'fail' then 0 else 1 end, tier, name), '[]'::json)
              from (select * from ranked order by case status when 'fail' then 0 else 1 end, tier limit 12) t)
  ) into result;
  return result;
end $$;
grant execute on function public.priorities(timestamptz, timestamptz) to anon;

-- Verify:
--   select public.speed_revenue(now() - interval '7 days', now());
--   select public.alert_scan();  select public.open_alerts();
--   select public.priorities(now() - interval '7 days', now());
