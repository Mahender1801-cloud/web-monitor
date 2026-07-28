-- ============================================================================
-- Funnel accuracy fix.  Run in Supabase -> SQL Editor.
--
-- Bug: the "Purchased" step counted only orders carrying an EXACT cart stamp
-- (rum_session). Since most orders are linked by inference now, it showed 5 while
-- 15 real orders had been placed — the one number on that chart people actually
-- act on was wrong.
--
-- Purchased now counts NET orders in the window (excluding R- returns and
-- E- exchanges), which is the true business figure and matches the Orders tile.
-- We also return `buyers` (distinct linked sessions) separately for anyone who
-- wants the session-level view, and `views` so the top of the funnel can say how
-- many page views those sessions produced.
-- ============================================================================
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
  ),
  o as (
    select rum_session, inferred_session from public.shop_orders
    where created_at >= p_from and created_at <= p_to
      and coalesce(order_number,'') not ilike 'R-%'
      and coalesce(order_number,'') not ilike 'E-%'
  )
  select json_build_object(
    'sessions',       (select count(distinct session_id) from r),
    'views',          (select count(*) from r),
    'viewed_product', (select count(distinct session_id) from r where path like '/products%'),
    'viewed_cart',    (select greatest(
                          (select count(distinct session_id) from r where path like '/cart%'),
                          (select count(distinct session_id) from f where event_type = 'view_cart')
                       )),
    'added_to_cart',  (select count(distinct session_id) from f where event_type = 'add_to_cart'),
    'checkout_click', (select count(distinct session_id) from f where event_type = 'checkout_click'),
    -- the real order count, not just the exactly-stamped ones
    'purchased',      (select count(*) from o),
    'buyers',         (select count(distinct coalesce(rum_session, inferred_session))
                         from o where coalesce(rum_session, inferred_session) is not null)
  ) into result;
  return result;
end;
$$;
grant execute on function public.funnel_stats(timestamptz, timestamptz) to anon;

-- Verify — 'purchased' must equal the Orders tile for the same window:
--   select public.funnel_stats(date_trunc('day', now()), now());
--   select public.shop_stats(date_trunc('day', now()), now());
