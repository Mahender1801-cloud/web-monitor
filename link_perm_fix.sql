-- ============================================================================
-- Fix: the dashboard's linker call returns 42501 (insufficient privilege).
--
-- The RLS lockdown correctly revoked UPDATE on shop_orders from anon, but the
-- linker needs to write inferred_session. The webhook is fine (it uses the
-- service key); the browser's safety-net call was failing silently.
--
-- SECURITY DEFINER lets these two functions perform that one narrow update with
-- the owner's rights while still being callable by anon. anon still cannot update
-- or delete anything directly — it can only ask for this specific operation.
-- search_path is pinned so the definer context can't be hijacked.
-- ============================================================================

alter function public.link_orders_by_intent(timestamptz, timestamptz)
  security definer set search_path = public, pg_temp;

alter function public.link_recent_orders()
  security definer set search_path = public, pg_temp;

grant execute on function public.link_orders_by_intent(timestamptz, timestamptz) to anon;
grant execute on function public.link_recent_orders() to anon;

-- Verify: this should return a number (rows newly linked), not an error.
select public.link_recent_orders();

-- And confirm anon still cannot write directly — both must fail:
--   curl -X DELETE ".../rest/v1/shop_orders?id=eq.-1" -H "apikey: <anon>" ...
--   curl -X PATCH  ".../rest/v1/shop_orders?id=eq.-1" -H "apikey: <anon>" ...
