-- ============================================================================
-- checkout_health was wrong.  Run in Supabase -> SQL Editor.
--
-- It reported 334 conversions in a window that contained only 221 orders — more
-- conversions than orders, which is impossible. Cause: it evaluated one row PER
-- CHECKOUT CLICK, so a shopper who clicked checkout three times and then ordered
-- was counted three times in "converted", and a shopper who clicked three times
-- and left was counted three times in "lost".
--
-- Everything is now measured per SESSION, which is the unit a person maps to.
--
-- Honest caveat, surfaced in the UI as well: orders are linked to sessions partly
-- BY the checkout click itself, so "sessions that clicked and ordered" can only
-- ever count orders we managed to link. Treat the conversion figure as a floor.
-- ============================================================================
create or replace function public.checkout_health(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json;
begin
  with clicks as (
    select session_id, min(created_at) first_click, count(*) n_clicks
    from public.funnel_events
    where created_at >= p_from and created_at <= p_to
      and event_type in ('checkout_click','buy_now') and session_id is not null
    group by session_id                                  -- one row per person
  ),
  landed as (
    select c.session_id, c.n_clicks,
           exists (select 1 from public.shop_orders o
                    where (o.rum_session = c.session_id or o.inferred_session = c.session_id)
                      and o.created_at between c.first_click and c.first_click + interval '45 minutes'
                      and coalesce(o.order_number,'') not ilike 'R-%'
                      and coalesce(o.order_number,'') not ilike 'E-%') as converted
    from clicks c
  ),
  ord as (
    select count(*) n from public.shop_orders
    where created_at >= p_from and created_at <= p_to
      and coalesce(order_number,'') not ilike 'R-%'
      and coalesce(order_number,'') not ilike 'E-%'
  )
  select json_build_object(
    'click_events',  (select coalesce(sum(n_clicks),0) from clicks),   -- raw taps
    'sessions',      (select count(*) from clicks),                    -- people
    'converted',     (select count(*) filter (where converted) from landed),
    'lost',          (select count(*) filter (where not converted) from landed),
    'conversion',    (select round(count(*) filter (where converted)::numeric
                                   / nullif(count(*),0), 4) from landed),
    'orders_window', (select n from ord),
    'repeat_clicks', (select count(*) filter (where n_clicks > 1) from clicks)
  ) into result;
  return result;
end $$;
grant execute on function public.checkout_health(timestamptz, timestamptz) to anon;

-- Sanity check that must now hold: converted <= orders_window
--   select public.checkout_health(now() - interval '7 days', now());
