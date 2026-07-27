-- ============================================================================
-- Funnel events + order<->journey link.  Run once in Supabase -> SQL Editor.
--
-- 1) funnel_events: the steps that aren't page views (add_to_cart, checkout_click).
--    Product-viewed / cart-viewed already come from rum_events paths.
-- 2) shop_orders.rum_session / ga_client_id: filled from the order's note_attributes
--    (the cart stamp) so EVERY new order links to its full browsing journey.
-- ============================================================================

create table if not exists public.funnel_events (
  id           bigserial primary key,
  session_id   text,
  event_type   text,          -- add_to_cart | checkout_click | ...
  path         text,
  ga_client_id text,
  referrer     text,
  created_at   timestamptz not null default now()
);
create index if not exists funnel_session_idx on public.funnel_events (session_id);
create index if not exists funnel_created_idx on public.funnel_events (created_at desc);
create index if not exists funnel_type_idx    on public.funnel_events (event_type, created_at desc);

alter table public.funnel_events enable row level security;
drop policy if exists ins_funnel on public.funnel_events;
create policy ins_funnel on public.funnel_events for insert with check (true);   -- collector (anon) inserts
drop policy if exists sel_funnel on public.funnel_events;
create policy sel_funnel on public.funnel_events for select using (true);

-- Order -> journey link columns (filled by the webhook from note_attributes)
alter table public.shop_orders add column if not exists rum_session  text;
alter table public.shop_orders add column if not exists ga_client_id text;
create index if not exists shop_orders_rumsession_idx on public.shop_orders (rum_session);
create index if not exists shop_orders_gaclient_idx   on public.shop_orders (ga_client_id);

-- ---------------------------------------------------------------------------
-- Funnel counts for a window: sessions reaching each step.
--   viewed_product : a rum_events pageview on /products/*
--   added_to_cart  : a funnel_events add_to_cart
--   viewed_cart    : a rum_events pageview on /cart
--   checkout_click : a funnel_events checkout_click
--   purchased      : a shop_orders row whose rum_session matches a tracked session
-- ---------------------------------------------------------------------------
-- Covering index so the window scan is Index-Only (also speeds recent_visitors).
create index if not exists rum_session_cover_idx
  on public.rum_events (created_at)
  include (session_id, path, ga_client_id, time_on_page, device, referrer);

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

-- Verify:  select public.funnel_stats(now() - interval '7 days', now());
