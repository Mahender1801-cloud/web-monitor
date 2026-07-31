-- ============================================================================
-- Add the direct "Buy now" path to order linking.  Run in Supabase -> SQL Editor.
--
-- Accelerated checkout (Shop Pay / dynamic checkout buttons) SKIPS the cart, so no
-- cart attribute can ever reach those orders — they were unlinkable by definition.
-- The collector now emits a `buy_now` event on those clicks; because that click is
-- followed almost immediately by the order, it is the STRONGEST signal we have and
-- sits at the top of the cascade.
--
-- Cascade, best signal first:
--   stamp    - the cart attribute itself                    (certain)
--   buy_now  - clicked Buy now / Shop Pay  <=20 min prior    (very strong)
--   checkout - clicked checkout            <=45 min prior    (strong)
--   cart     - opened the cart             <=45 min prior    (good)
--   atc      - added to cart               <=90 min prior    (weaker)
-- ============================================================================
create or replace function public.link_orders_by_intent(
  p_from timestamptz, p_to timestamptz
) returns int language plpgsql
security definer set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
declare n int;
begin
  with unlinked as (
    select id, created_at
    from public.shop_orders
    where created_at >= p_from and created_at <= p_to
      and rum_session is null and inferred_session is null
      and coalesce(order_number,'') not ilike 'R-%'
      and coalesce(order_number,'') not ilike 'E-%'
  ),
  cand as (
    select o.id,
           f.session_id,
           case f.event_type
             when 'buy_now'        then 'buynow'
             when 'checkout_click' then 'checkout'
             when 'view_cart'      then 'cart'
             else 'atc' end as src,
           row_number() over (
             partition by o.id
             order by case f.event_type
                        when 'buy_now'        then 0
                        when 'checkout_click' then 1
                        when 'view_cart'      then 2
                        else 3 end,
                      f.created_at desc
           ) as rk
    from unlinked o
    join public.funnel_events f
      on f.session_id is not null
     and f.created_at <= o.created_at
     and f.created_at >= o.created_at - (case f.event_type
                                           when 'buy_now'     then interval '20 minutes'
                                           when 'add_to_cart' then interval '90 minutes'
                                           else interval '45 minutes' end)
  ),
  best as (
    select id, session_id, src,
           row_number() over (partition by session_id order by id) as dup
    from cand where rk = 1
  ),
  upd as (
    update public.shop_orders s
       set inferred_session = b.session_id, link_source = b.src
      from best b
     where b.dup = 1 and s.id = b.id
    returning 1
  )
  select count(*) into n from upd;
  return coalesce(n,0);
end $$;
grant execute on function public.link_orders_by_intent(timestamptz, timestamptz) to anon;

-- link_recent_orders() calls the above, so it picks this up automatically.
alter function public.link_recent_orders() security definer set search_path = public, pg_temp;
grant execute on function public.link_recent_orders() to anon;

select public.link_orders_by_intent(now() - interval '30 days', now());

-- Coverage by path (run after a day of the new collector):
--   select link_source, count(*) from public.shop_orders
--   where created_at > now() - interval '2 days'
--     and order_number not ilike 'R-%' and order_number not ilike 'E-%'
--   group by 1 order by 2 desc;
