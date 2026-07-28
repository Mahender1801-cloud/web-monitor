-- ============================================================================
-- Purchases KPIs — count NET orders, and report returns/exchanges separately.
--
-- The table showed 16 rows while the tile said 12. Two causes:
--   * Shopify writes returns as "R-xxxxx" and exchanges as "E-xxxxx" rows in the
--     same feed (₹0, voided). They are not new orders and must not inflate — or
--     silently disappear from — the count.
--   * The old shop_stats filtered on financial_status only, which mixed a genuine
--     voided sale in with the R-/E- rows.
-- Now: orders = real orders only (# prefix), plus explicit returns/exchanges counts.
-- Run in Supabase -> SQL Editor.
-- ============================================================================
create or replace function public.shop_stats(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '15s'
as $$
declare result json;
begin
  with w as (
    select order_number, total_price, currency, created_at, financial_status,
           rum_session, ga_client_id,
           (order_number ilike 'R-%') as is_return,
           (order_number ilike 'E-%') as is_exchange
    from public.shop_orders
    where created_at >= p_from and created_at <= p_to
  ),
  net as (   -- genuine orders only
    select * from w where not is_return and not is_exchange
  )
  select json_build_object(
    'orders',    (select count(*) from net),
    'revenue',   (select coalesce(sum(total_price),0) from net),
    'aov',       (select case when count(*) > 0 then sum(total_price)/count(*) end from net),
    'currency',  (select currency from net order by created_at desc limit 1),
    'linked',    (select count(*) from net where rum_session is not null or ga_client_id is not null),
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

-- Verify:  select public.shop_stats(now() - interval '1 day', now());
