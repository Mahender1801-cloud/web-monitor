-- ============================================================================
-- Link orders to browsing journeys when the cart stamp doesn't survive.
--
-- WHY: the collector writes _rum_sid into the Shopify cart, but on this store the
-- attribute rarely reaches the order — the checkout flow (COD / partially_paid via
-- a third-party checkout) doesn't carry cart attributes. Measured: only 2 of 13
-- orders in a day arrived stamped, and it failed both before and after the
-- collector update, so it isn't a collector bug.
--
-- We now record checkout_click events (session_id + timestamp). An order created
-- shortly AFTER a checkout click is almost certainly that session. This links them
-- and marks the link as INFERRED so the dashboard can be honest about it.
--
-- Exact stamps always win; inference only fills the gaps.
-- ============================================================================

alter table public.shop_orders add column if not exists inferred_session text;
alter table public.shop_orders add column if not exists link_source     text;
create index if not exists shop_orders_inferred_idx on public.shop_orders (inferred_session);

update public.shop_orders
   set link_source = 'stamp'
 where rum_session is not null and link_source is distinct from 'stamp';

-- ---------------------------------------------------------------------------
-- Match unlinked orders to the closest preceding checkout intent.
--   window: 45 minutes before the order (covers filling the checkout form)
--   preference: checkout_click > view_cart > add_to_cart, then most recent
--   a session is used at most once, so two orders can't claim the same journey
-- ---------------------------------------------------------------------------
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
     and f.created_at >= o.created_at - interval '45 minutes'
  ),
  best as (
    select id, session_id,
           row_number() over (partition by session_id order by id) as dup
    from cand where rk = 1
  ),
  upd as (
    update public.shop_orders s
       set inferred_session = b.session_id,
           link_source = 'inferred'
      from best b
     where b.dup = 1 and s.id = b.id
    returning 1
  )
  select count(*) into n from upd;
  return coalesce(n,0);
end $$;
grant execute on function public.link_orders_by_intent(timestamptz, timestamptz) to anon;

-- Backfill everything we have intent data for:
select public.link_orders_by_intent(now() - interval '30 days', now());

-- ---------------------------------------------------------------------------
-- shop_stats: report exact vs inferred links so the tile can be honest.
-- ---------------------------------------------------------------------------
create or replace function public.shop_stats(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '15s'
as $$
declare result json;
begin
  with w as (
    select order_number, total_price, currency, created_at, financial_status,
           rum_session, ga_client_id, inferred_session,
           (coalesce(order_number,'') ilike 'R-%') as is_return,
           (coalesce(order_number,'') ilike 'E-%') as is_exchange
    from public.shop_orders
    where created_at >= p_from and created_at <= p_to
  ),
  net as (select * from w where not is_return and not is_exchange)
  select json_build_object(
    'orders',    (select count(*) from net),
    'rows',      (select count(*) from w),
    'revenue',   (select coalesce(sum(total_price),0) from net),
    'aov',       (select case when count(*) > 0 then sum(total_price)/count(*) end from net),
    'currency',  (select currency from net order by created_at desc limit 1),
    'linked',    (select count(*) from net where rum_session is not null or ga_client_id is not null or inferred_session is not null),
    'linked_exact',   (select count(*) from net where rum_session is not null or ga_client_id is not null),
    'linked_inferred',(select count(*) from net where rum_session is null and ga_client_id is null and inferred_session is not null),
    'returns',   (select count(*) from w where is_return),
    'exchanges', (select count(*) from w where is_exchange),
    'cancelled', (select count(*) from net where financial_status in ('voided','refunded')),
    'paid',      (select count(*) from net where financial_status = 'paid'),
    'pending',   (select count(*) from net where financial_status in ('pending','partially_paid')),
    'daily',     (select coalesce(json_agg(json_build_array(d,n,rev) order by d),'[]'::json)
                  from (select date_trunc('day',created_at)::date d, count(*) n, sum(total_price) rev
                        from net group by 1) x)
  ) into result;
  return result;
end;
$$;
grant execute on function public.shop_stats(timestamptz, timestamptz) to anon;

-- Verify:
--   select public.shop_stats(now() - interval '1 day', now());
