-- ============================================================================
-- APPLY ALL #2 — everything still pending, in ONE run.
-- Supabase → SQL Editor → New query → paste → Run. Idempotent (safe to re-run).
--
-- Combines: ga_fix.sql + user_tracking.sql
--   1) GA scope fix + landing-page attribution (real per-page conversion)
--   2) Link our visitors to GA4 (ga_client_id / ga_session_id)
--   3) Time on page + bounce flag
--   4) purchases table (transaction ID from the Shopify pixel)
-- ============================================================================

-- 1) GA: scope column so device-rows and page-rows can't collide -------------
alter table public.ga_daily add column if not exists scope text not null default 'device';
alter table public.ga_daily drop constraint if exists ga_daily_date_device_page_path_key;
delete from public.ga_daily;                       -- ambiguous rows; refilled next run
alter table public.ga_daily drop constraint if exists ga_daily_uniq;
alter table public.ga_daily add constraint ga_daily_uniq unique (date, scope, device, page_path);
create index if not exists ga_daily_scope_idx on public.ga_daily (scope, date desc);

-- 2) Link our RUM rows to Google Analytics ----------------------------------
alter table public.rum_events add column if not exists ga_client_id  text;
alter table public.rum_events add column if not exists ga_session_id text;
create index if not exists rum_ga_client_idx on public.rum_events (ga_client_id);

-- 3) Time on page (exact visible time, measured by our collector) ------------
alter table public.rum_events add column if not exists time_on_page numeric;
alter table public.rum_events add column if not exists is_bounce    boolean;

-- 4) Purchases (written by the Shopify custom pixel) -------------------------
create table if not exists public.purchases (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  transaction_id text unique,          -- GA4 "transaction_id"
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
drop policy if exists "insert_purchases" on public.purchases;
create policy "insert_purchases" on public.purchases for insert with check (true);
drop policy if exists "read_purchases" on public.purchases;
create policy "read_purchases" on public.purchases for select using (true);

-- Done. Verify:
--   select count(*) from public.purchases;
--   select column_name from information_schema.columns
--    where table_name='rum_events' and column_name in
--          ('ga_client_id','ga_session_id','time_on_page','is_bounce');
