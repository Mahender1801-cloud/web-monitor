-- ============================================================================
-- Google Analytics (GA4) → Supabase
-- Run ONCE in Supabase → SQL Editor. Idempotent (safe to re-run).
-- The GitHub Action fills this daily from the GA4 Data API.
--
-- Two kinds of rows (so one table serves both views):
--   • device rows : device='mobile'|'desktop'|'tablet', page_path=''
--   • page rows   : device='',                          page_path='/products/x'
-- ============================================================================

create table if not exists public.ga_daily (
  id          bigint generated always as identity primary key,
  date        date not null,
  device      text not null default '',
  page_path   text not null default '',
  sessions    numeric default 0,
  users       numeric default 0,
  purchases   numeric default 0,   -- ecommercePurchases = real orders
  revenue     numeric default 0,   -- purchaseRevenue
  add_to_carts numeric default 0,
  checkouts   numeric default 0,
  updated_at  timestamptz not null default now(),
  unique (date, device, page_path)
);
create index if not exists ga_daily_date_idx on public.ga_daily (date desc);

alter table public.ga_daily enable row level security;

-- anon may READ (dashboard). Writes come from the Action's service_role key,
-- which bypasses RLS entirely.
drop policy if exists "read_all_ga" on public.ga_daily;
create policy "read_all_ga" on public.ga_daily for select using (true);

-- Check after the first Action run:
-- select date, device, sessions, purchases, revenue from public.ga_daily
-- where page_path='' order by date desc limit 20;
