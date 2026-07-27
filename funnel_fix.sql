-- ============================================================================
-- Fix: funnel_stats was timing out. Two changes — run once in SQL Editor.
--   1) A covering index so session-grouped scans are Index-Only (no heap fetches).
--   2) funnel_stats rewritten to scan the window ONCE (materialized) instead of
--      3 separate distinct scans over rum_events.
-- Also speeds up recent_visitors (same index).
-- ============================================================================

create index if not exists rum_session_cover_idx
  on public.rum_events (created_at)
  include (session_id, path, ga_client_id, time_on_page, device, referrer);
analyze public.rum_events;

create or replace function public.funnel_stats(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with r as materialized (
    select session_id, path from public.rum_events
    where created_at >= p_from and created_at <= p_to and session_id is not null
  ),
  f as materialized (
    select session_id, event_type from public.funnel_events
    where created_at >= p_from and created_at <= p_to
  )
  select json_build_object(
    'sessions',       (select count(distinct session_id) from r),
    'viewed_product', (select count(distinct session_id) from r where path like '/products%'),
    'viewed_cart',    (select count(distinct session_id) from r where path like '/cart%'),
    'added_to_cart',  (select count(distinct session_id) from f where event_type = 'add_to_cart'),
    'checkout_click', (select count(distinct session_id) from f where event_type = 'checkout_click'),
    'purchased',      (select count(distinct rum_session) from public.shop_orders
                        where created_at >= p_from and created_at <= p_to and rum_session is not null)
  ) into result;
  return result;
end;
$$;
grant execute on function public.funnel_stats(timestamptz, timestamptz) to anon;

-- Verify (should return in ~1s now):
--   select public.funnel_stats(now() - interval '7 days', now());
