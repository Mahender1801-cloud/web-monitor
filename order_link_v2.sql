-- ============================================================================
-- Order -> journey linking, v2.  Run in Supabase -> SQL Editor.
--
-- Two problems with v1:
--   1. It only ran from the scheduled job (5x/day), so an order placed at 5:16pm
--      sat unlinked for hours. It now also runs the moment the order webhook
--      fires, and whenever the Purchases tab is opened.
--   2. It only matched a checkout_click. If that beacon didn't fire (accelerated
--      "Buy now", a third-party checkout page, or the shopper left the tab before
--      the beacon flushed) the order had no candidate at all.
--
-- v2 walks a cascade of progressively weaker signals and records WHICH one matched
-- in link_source, so the dashboard can show how confident the link is:
--     stamp    - the cart attribute itself      (certain)
--     checkout - clicked checkout <=45 min prior (strong)
--     cart     - opened the cart  <=45 min prior (good)
--     atc      - added to cart    <=90 min prior (weaker)
-- We deliberately do NOT fall back to "any session browsing at the time": with
-- ~4,800 sessions a day that would be little better than a guess, and a wrong
-- journey is worse than an honest blank.
-- ============================================================================

alter table public.shop_orders add column if not exists inferred_session text;
alter table public.shop_orders add column if not exists link_source     text;
create index if not exists shop_orders_inferred_idx on public.shop_orders (inferred_session);
create index if not exists funnel_sess_time_idx on public.funnel_events (created_at desc, event_type);

update public.shop_orders set link_source='stamp'
 where rum_session is not null and link_source is distinct from 'stamp';

create or replace function public.link_orders_by_intent(
  p_from timestamptz, p_to timestamptz
) returns int language plpgsql
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
           case f.event_type when 'checkout_click' then 'checkout'
                             when 'view_cart'      then 'cart'
                             else 'atc' end as src,
           row_number() over (
             partition by o.id
             order by case f.event_type when 'checkout_click' then 0
                                        when 'view_cart'      then 1
                                        else 2 end,
                      f.created_at desc
           ) as rk
    from unlinked o
    join public.funnel_events f
      on f.session_id is not null
     and f.created_at <= o.created_at
     -- add_to_cart gets a longer lookback: shoppers browse a while before paying
     and f.created_at >= o.created_at - (case when f.event_type = 'add_to_cart'
                                              then interval '90 minutes'
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

-- Convenience wrapper the dashboard calls on open (last 3 days, cheap).
create or replace function public.link_recent_orders()
returns int language sql
as $$ select public.link_orders_by_intent(now() - interval '3 days', now()); $$;
grant execute on function public.link_recent_orders() to anon;

-- Re-link everything we have intent data for
select public.link_orders_by_intent(now() - interval '30 days', now());

-- How well are we doing? (run after)
--   select link_source, count(*) from public.shop_orders
--   where created_at > now() - interval '2 days'
--     and order_number not ilike 'R-%' and order_number not ilike 'E-%'
--   group by 1 order by 2 desc;
