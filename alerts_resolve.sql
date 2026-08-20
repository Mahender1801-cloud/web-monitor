-- ============================================================================
-- Alerts that close themselves, and a history you can read.
-- Run once in Supabase -> SQL Editor.
--
-- The dashboard has been showing two CRITICAL banners saying "No orders in the
-- last 3 hours" while orders were arriving normally. Both were true when they
-- fired and neither was ever wrong:
--
--   alert 6  fired 19 Aug 13:31   6 orders arrived within the next 3 hours
--   alert 5  fired 18 Aug 16:02   5 orders arrived within the next 3 hours
--
-- Nothing closes an alert once its condition clears, so they sat at the top of
-- the page for two days looking like a live outage while 21 orders came in.
-- An alert that cannot clear itself trains you to ignore alerts, which costs
-- more than the alert saves.
--
-- Two changes: alerts resolve when the thing they warned about stops being
-- true, and every alert keeps its fired and cleared times so "when did this
-- happen" has an answer instead of a guess.
--
-- NOTE on the first version of this file, which failed to run. It used column
-- names message and kind; the table has title and source. It also declared
-- open_alerts() as RETURNS TABLE when the existing one returns json — which is
-- what Postgres refused, and rightly: the dashboard destructures each row as
-- [id, sev, title, detail, src, val, at], so a table of named columns would
-- have parsed as undefined everywhere. The shape below is unchanged from what
-- the UI already reads.
-- ============================================================================

alter table public.alerts add column if not exists resolved_at timestamptz;
alter table public.alerts add column if not exists resolved_by text;   -- 'auto' | 'user'

-- A distinct name: alerts_open_idx already exists on (acknowledged, created_at)
-- and "if not exists" would have silently kept the old one, leaving this query
-- unindexed while the file appeared to have worked.
create index if not exists alerts_unresolved_idx
  on public.alerts (created_at desc) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- Close what is no longer true.
--
-- Only order alerts are auto-resolved, because "orders resumed" is a fact this
-- database can re-check. Alerts about things it cannot re-test are left for a
-- person; closing those automatically would be guessing.
--
-- resolved_at is set to the first order that arrived after the alert, not to
-- now(), so the history shows how long the drought actually lasted rather than
-- how long it took someone to run this.
-- ---------------------------------------------------------------------------
create or replace function public.alerts_autoresolve()
returns integer language plpgsql
set statement_timeout = '20s'
as $$
declare n integer;
begin
  update public.alerts a
     set resolved_at = (select min(o.created_at) from public.shop_orders o
                         where o.created_at > a.created_at),
         resolved_by = 'auto'
   where a.resolved_at is null
     and a.source = 'orders'
     and exists (select 1 from public.shop_orders o where o.created_at > a.created_at);
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.alerts_autoresolve() to anon;

-- ---------------------------------------------------------------------------
-- open_alerts now means open. It meant "not acknowledged", which is why a
-- two-day-old alert whose condition had cleared still counted as one.
--
-- Same json-array shape as before — the dashboard reads positions, not names.
-- ---------------------------------------------------------------------------
create or replace function public.open_alerts()
returns json language sql stable as $$
  select coalesce(json_agg(json_build_array(id, severity, title, detail, source, value, created_at)
                           order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end,
                                    created_at desc), '[]'::json)
  from public.alerts
  where not coalesce(acknowledged,false)
    and resolved_at is null
    and created_at > now() - interval '7 days';
$$;
grant execute on function public.open_alerts() to anon;

-- ---------------------------------------------------------------------------
-- The log: everything, open or closed, newest first, with how long each lasted.
-- A banner can be checked against when it actually fired instead of being read
-- as "now".
-- ---------------------------------------------------------------------------
create or replace function public.alert_history(p_days int default 14)
returns json language plpgsql stable
set statement_timeout = '15s'
as $$
declare result json;
begin
  select coalesce(json_agg(json_build_array(
           id, severity, title, detail, source, created_at, resolved_at, resolved_by,
           case when resolved_at is null then null
                else round(extract(epoch from (resolved_at - created_at))/60) end,
           coalesce(acknowledged,false)
         ) order by created_at desc), '[]'::json)
  into result
  from public.alerts
  where created_at > now() - make_interval(days => p_days);
  return result;
end $$;
grant execute on function public.alert_history(int) to anon;

-- ---------------------------------------------------------------------------
-- Close the two that are already stale, then check:
--
--   select public.alerts_autoresolve();     -- expect 2
--   select public.open_alerts();            -- expect []
--   select public.alert_history(14);
--
-- In the history, each of those two should carry a resolved_at within a few
-- hours of its created_at — the gap being how long the store actually went
-- without an order, which was the real event.
-- ---------------------------------------------------------------------------
