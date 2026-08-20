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
-- the page for two days looking like a live outage. An alert that cannot clear
-- itself trains you to ignore alerts, which costs more than the alert saves.
--
-- Two changes: alerts resolve when the thing they warned about stops being
-- true, and every alert keeps its fired/cleared times so "when did this happen"
-- has an answer instead of a guess.
-- ============================================================================

alter table public.alerts add column if not exists resolved_at timestamptz;
alter table public.alerts add column if not exists resolved_by text;   -- 'auto' | 'user'

create index if not exists alerts_open_idx on public.alerts (created_at desc)
  where resolved_at is null and not acknowledged;

-- ---------------------------------------------------------------------------
-- Close what is no longer true.
--
-- Only order alerts are auto-resolved here, because "orders resumed" is a fact
-- this database can check. Alerts about things it cannot re-test are left for a
-- person — closing those automatically would be guessing.
-- ---------------------------------------------------------------------------
create or replace function public.alerts_autoresolve()
returns integer language plpgsql
set statement_timeout = '20s'
as $$
declare n integer;
begin
  update public.alerts a
     set resolved_at = coalesce(
           (select min(o.created_at) from public.shop_orders o
             where o.created_at > a.created_at),
           now()),
         resolved_by = 'auto'
   where a.resolved_at is null
     and a.kind = 'orders'
     -- an order after the alert means the drought ended
     and exists (select 1 from public.shop_orders o where o.created_at > a.created_at);
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function public.alerts_autoresolve() to anon;

-- ---------------------------------------------------------------------------
-- open_alerts now means open. It used to mean "not acknowledged", which is why
-- a two-day-old resolved alert still counted as one.
-- ---------------------------------------------------------------------------
create or replace function public.open_alerts()
returns table(id bigint, severity text, message text, detail text,
              kind text, value text, created_at timestamptz)
language sql stable
set statement_timeout = '10s'
as $$
  select a.id, a.severity, a.message, a.detail, a.kind, a.value::text, a.created_at
  from public.alerts a
  where a.resolved_at is null
    and not coalesce(a.acknowledged,false)
  order by a.created_at desc
  limit 50;
$$;
grant execute on function public.open_alerts() to anon;

-- ---------------------------------------------------------------------------
-- The log. Everything, open or closed, newest first, with how long it lasted —
-- so a banner can be checked against when it actually fired rather than being
-- read as "now".
-- ---------------------------------------------------------------------------
create or replace function public.alert_history(p_days int default 14)
returns json language plpgsql stable
set statement_timeout = '15s'
as $$
declare result json;
begin
  select coalesce(json_agg(json_build_array(
           id, severity, message, detail, kind, created_at, resolved_at, resolved_by,
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

-- Close the two that are already stale, and confirm:
--   select public.alerts_autoresolve();
--   select * from public.open_alerts();
--   select public.alert_history(14);
