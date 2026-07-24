-- ============================================================================
-- Complete order feed from Shopify (server-side) — run ONCE in Supabase SQL Editor.
--
-- WHY: the browser checkout_completed pixel captures <1% of orders (it only fires
-- when the shopper accepts cookies AND the thank-you page fully loads). This table
-- is filled by the GitHub Action pulling the Shopify Admin API, so it holds EVERY
-- order — the real counts/revenue. The existing `purchases` table (pixel) stays as
-- the small subset that can be linked to a shopper's page-speed via GA client id.
-- ============================================================================

create table if not exists public.shop_orders (
  id            bigint primary key,          -- Shopify order id (numeric)
  order_number  text,                         -- e.g. "#1234" / name
  created_at    timestamptz not null,
  processed_at  timestamptz,
  total_price   numeric,
  currency      text,
  items         numeric,
  financial_status text,                       -- paid / pending / refunded …
  landing_site  text,                          -- first page of the order's session
  referring_site text,
  source_name   text,                          -- web / pos / …
  raw           jsonb,
  updated_at    timestamptz not null default now()
);
create index if not exists shop_orders_created_idx on public.shop_orders (created_at desc);

alter table public.shop_orders enable row level security;
drop policy if exists "read_shop_orders" on public.shop_orders;
create policy "read_shop_orders" on public.shop_orders for select using (true);
-- Writes come from the Action's service_role key, which bypasses RLS.

-- Accurate order totals for a window + a daily series (powers the Purchases tiles).
create or replace function public.shop_stats(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '10s'
as $$
declare result json;
begin
  with w as (
    select created_at, total_price, currency
    from public.shop_orders
    where created_at >= p_from and created_at <= p_to
      and coalesce(financial_status,'') not in ('voided','refunded')
  )
  select json_build_object(
    'orders',  (select count(*) from w),
    'revenue', (select coalesce(sum(total_price),0) from w),
    'aov',     (select case when count(*)>0 then sum(total_price)/count(*) end from w),
    'currency',(select currency from w order by created_at desc limit 1),
    'daily',   (select coalesce(json_agg(json_build_array(d,n,rev) order by d),'[]'::json)
                from (select date_trunc('day',created_at)::date d, count(*) n, sum(total_price) rev
                      from w group by 1) x)
  ) into result;
  return result;
end;
$$;
grant execute on function public.shop_stats(timestamptz, timestamptz) to anon;

-- After the first Action run:
--   select public.shop_stats(now() - interval '7 days', now());
--   select date_trunc('day',created_at)::date d, count(*), sum(total_price)
--   from public.shop_orders group by 1 order by 1 desc;
