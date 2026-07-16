-- ============================================================================
-- Per-user tracking: dwell time + real purchases (with transaction ID)
-- Run ONCE in Supabase → SQL Editor. Idempotent.
-- ============================================================================

-- 1) TIME ON PAGE ------------------------------------------------------------
-- Measured by our own collector (exact engaged/visible time), not GA's estimate.
--   time_on_page  = milliseconds the page was actually visible to the user
--   is_bounce     = true when they left almost immediately with no interaction
alter table public.rum_events add column if not exists time_on_page numeric;
alter table public.rum_events add column if not exists is_bounce    boolean;

-- 2) PURCHASES ---------------------------------------------------------------
-- Written by a Shopify custom pixel on checkout_completed. Carries GA4's
-- client id, so a purchase can be tied back to the exact visitor whose page
-- speed we recorded in rum_events.
create table if not exists public.purchases (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  transaction_id text unique,          -- GA4 "transaction_id" (Shopify order id/number)
  order_number   text,
  value          numeric,
  currency       text,
  items          numeric,
  ga_client_id   text,                 -- joins to rum_events.ga_client_id
  ga_session_id  text,
  landing_page   text,
  raw            jsonb
);
create index if not exists purchases_ga_client_idx on public.purchases (ga_client_id);
create index if not exists purchases_created_idx   on public.purchases (created_at desc);

alter table public.purchases enable row level security;

-- The storefront pixel inserts with the anon key; dashboard reads.
drop policy if exists "insert_purchases" on public.purchases;
create policy "insert_purchases" on public.purchases for insert with check (true);
drop policy if exists "read_purchases" on public.purchases;
create policy "read_purchases" on public.purchases for select using (true);

-- ============================================================================
-- After the pixel is live, THIS is the query you actually wanted —
-- "did slow pages cost us the sale?" (per real visitor):
--
--   select
--     case when r.lcp > 4000 then 'slow (LCP>4s)' else 'fast (LCP<=4s)' end as speed,
--     count(distinct r.ga_client_id)                                        as visitors,
--     count(distinct p.ga_client_id)                                        as buyers,
--     round(100.0*count(distinct p.ga_client_id)/nullif(count(distinct r.ga_client_id),0),2) as cvr_pct,
--     round(avg(r.time_on_page)/1000,1)                                     as avg_seconds_on_page
--   from public.rum_events r
--   left join public.purchases p on p.ga_client_id = r.ga_client_id
--   where r.ga_client_id is not null
--   group by 1;
-- ============================================================================
