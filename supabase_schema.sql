-- ============================================================================
-- Hashtag Eyewear — Site Monitoring schema for Supabase (Postgres)
-- Run this ONCE in Supabase → SQL Editor → New query → paste → Run.
-- Everything here is free-tier safe. No extensions beyond pgcrypto (built in).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) RUM events — one row per page view, written by the browser collector.
--    The `raw` column stores the exact JSON that arrived, so nothing is ever
--    lost even if a named column is empty. That is your "raw data" view.
-- ---------------------------------------------------------------------------
create table if not exists public.rum_events (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  session_id    text,
  url           text,
  path          text,
  referrer      text,
  device        text,
  os            text,
  browser       text,
  viewport      text,
  connection    text,
  save_data     boolean,
  device_memory numeric,
  cpu_cores     numeric,
  nav_type      text,
  lcp           numeric, lcp_rating text, lcp_element text,
  cls           numeric, cls_rating text, cls_element text,
  inp           numeric, inp_rating text, inp_target  text, inp_type text,
  fcp           numeric, fcp_rating text,
  ttfb          numeric, ttfb_rating text,
  ttfb_waiting  numeric, ttfb_dns numeric, ttfb_connect numeric, ttfb_request numeric,
  utm_source    text, utm_medium text, utm_campaign text,
  screen        text, lang text,
  raw           jsonb
);
create index if not exists rum_events_created_idx on public.rum_events (created_at desc);
create index if not exists rum_events_path_idx    on public.rum_events (path);

-- ---------------------------------------------------------------------------
-- 2) Monitors — the list of URLs you want watched. Add any web link here
--    (from the dashboard or by inserting a row).
-- ---------------------------------------------------------------------------
create table if not exists public.monitors (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  screenshot_mobile  text,
  screenshot_desktop text,
  label      text not null,
  url        text not null unique,
  active     boolean not null default true,
  screenshot_mobile  text,   -- cached page thumbnail (data URI), refreshed each run
  screenshot_desktop text
);

-- ---------------------------------------------------------------------------
-- 3) PSI results — PageSpeed Insights output per URL per device.
--    Powers the "Web Vitals" dashboard (the DebugBear-style table).
--    History is kept so you can trend it; the dashboard reads the latest.
-- ---------------------------------------------------------------------------
create table if not exists public.psi_results (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  url        text not null,
  label      text,
  strategy   text not null,           -- 'mobile' | 'desktop'
  lcp_crux   numeric, inp_crux numeric, cls_crux numeric,   -- field (CrUX), ms / unitless
  lcp_lab    numeric, tbt_lab  numeric, cls_lab  numeric,   -- lab (Lighthouse), ms / unitless
  perf_score integer,
  run_type   text default 'scheduled',
  raw        jsonb
);
create index if not exists psi_created_idx on public.psi_results (created_at desc);
create index if not exists psi_url_strat_idx on public.psi_results (url, strategy, created_at desc);

-- ---------------------------------------------------------------------------
-- 4) Task items — the QA checklist (your daily-tasks PDF), one row per check.
--    check_type: 'auto'  -> a script decides pass/fail
--                'manual'-> a human toggles it done (no reliable automation)
--    auto_key : which automated probe feeds it (see scripts/check.mjs)
-- ---------------------------------------------------------------------------
create table if not exists public.task_items (
  id         uuid primary key default gen_random_uuid(),
  category   text not null,
  item       text not null,
  check_type text not null default 'manual',   -- 'auto' | 'manual'
  auto_key   text,
  sort       integer not null default 0
);

-- ---------------------------------------------------------------------------
-- 5) Task checks — result of each run. Dashboard reads the latest per item.
-- ---------------------------------------------------------------------------
create table if not exists public.task_checks (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  category   text,
  item       text,
  url        text,
  status     text,                         -- 'pass'|'warn'|'fail'|'manual'|'error'
  value      text,
  detail     text,
  run_type   text default 'scheduled'      -- 'scheduled'|'manual'
);
create index if not exists task_checks_created_idx on public.task_checks (created_at desc);
create index if not exists task_checks_item_idx on public.task_checks (category, item, created_at desc);

-- ============================================================================
-- Row Level Security
-- This is non-sensitive performance telemetry for an internal dashboard.
-- v1 policy: anon may READ everything and INSERT telemetry. No anon UPDATE/DELETE
-- except on `monitors` (so the dashboard can add/remove URLs without login).
-- Harden later by turning on Supabase Auth and scoping these to your email.
-- ============================================================================
alter table public.rum_events  enable row level security;
alter table public.monitors    enable row level security;
alter table public.psi_results enable row level security;
alter table public.task_items  enable row level security;
alter table public.task_checks enable row level security;

-- READ (anon) — everything
create policy "read_all_rum"    on public.rum_events  for select using (true);
create policy "read_all_mon"    on public.monitors    for select using (true);
create policy "read_all_psi"    on public.psi_results for select using (true);
create policy "read_all_items"  on public.task_items  for select using (true);
create policy "read_all_checks" on public.task_checks for select using (true);

-- INSERT (anon) — telemetry + browser "Test now"
create policy "insert_rum"    on public.rum_events  for insert with check (true);
create policy "insert_psi"    on public.psi_results for insert with check (true);
create policy "insert_checks" on public.task_checks for insert with check (true);

-- Monitors — dashboard manages them (add / toggle / remove) without login in v1
create policy "insert_mon" on public.monitors for insert with check (true);
create policy "update_mon" on public.monitors for update using (true) with check (true);
create policy "delete_mon" on public.monitors for delete using (true);

-- Task items — read-only for anon; you seed/edit them as the project owner.
-- (The service_role key used by GitHub Actions bypasses RLS entirely.)

-- ============================================================================
-- Seed: monitored URLs  (edit to taste)
-- ============================================================================
insert into public.monitors (label, url) values
  ('Homepage',          'https://hashtageyewears.com/'),
  ('Bestsellers',       'https://hashtageyewears.com/collections/bestsellers'),
  ('Sports Sunglasses', 'https://hashtageyewears.com/collections/sports-sunglasses'),
  ('Product (sample)',  'https://hashtageyewears.com/products/falcon-grey-large-half-rim-shield-sports-sunglasses-for-men-women-mirrored'),
  ('Cart',              'https://hashtageyewears.com/cart')
on conflict (url) do nothing;

-- ============================================================================
-- Seed: QA checklist  (from Task_to_Perform_daily.pdf)
-- auto = scripted probe;  manual = human toggle (visual / subjective checks)
-- ============================================================================
insert into public.task_items (category, item, check_type, auto_key, sort) values
-- Homepage
('Homepage Testing','Check homepage loading speed','auto','load_speed',1),
('Homepage Testing','Verify banners / sliders are loading properly','manual',null,2),
('Homepage Testing','Test mega menu and navigation links','manual',null,3),
('Homepage Testing','Check mobile + desktop responsiveness','manual',null,4),
('Homepage Testing','Verify homepage sections alignment','manual',null,5),
('Homepage Testing','Check 404 page and broken links','auto','broken_links',6),
-- Search
('Search Page Testing','Test site search functionality & autocomplete','manual',null,1),
('Search Page Testing','Verify "no results found" page behavior','manual',null,2),
('Search Page Testing','Check search filters / sorting','manual',null,3),
-- Collection
('Collection Page Testing','Check collection page loading speed','auto','load_speed',1),
('Collection Page Testing','Verify filters / sorting working properly','manual',null,2),
('Collection Page Testing','Check product cards alignment','manual',null,3),
('Collection Page Testing','Verify wishlist / cart buttons','manual',null,4),
('Collection Page Testing','Test pagination or infinite scroll','manual',null,5),
('Collection Page Testing','Ensure collection banners / images load','auto','http_status',6),
('Collection Page Testing','Check breadcrumb navigation','manual',null,7),
('Collection Page Testing','Verify "no products found" empty state','manual',null,8),
('Collection Page Testing','Check out-of-stock product display logic','manual',null,9),
-- Product
('Product Page Testing','Check product page loading speed','auto','load_speed',1),
('Product Page Testing','Check product images & variant images','manual',null,2),
('Product Page Testing','Verify Add to Cart & Buy Now buttons','manual',null,3),
('Product Page Testing','Test variant selection','manual',null,4),
('Product Page Testing','Verify reviews are loading properly','manual',null,5),
('Product Page Testing','Ensure no broken layout on mobile','manual',null,6),
('Product Page Testing','Check breadcrumb navigation','manual',null,7),
('Product Page Testing','Verify stock/inventory status','manual',null,8),
('Product Page Testing','Check sale price / compare-at price display','manual',null,9),
('Product Page Testing','Verify related / upsell / cross-sell','manual',null,10),
('Product Page Testing','Test sticky Add to Cart on scroll (mobile)','manual',null,11),
-- Cart & Checkout
('Cart & Checkout Testing','Add product to cart','manual',null,1),
('Cart & Checkout Testing','Verify corner cart / drawer cart working','manual',null,2),
('Cart & Checkout Testing','Test Shiprocket checkout redirect','manual',null,3),
('Cart & Checkout Testing','Check discount codes','manual',null,4),
('Cart & Checkout Testing','Verify payment methods visibility','manual',null,5),
('Cart & Checkout Testing','Test Partial COD / prepaid logic','manual',null,6),
('Cart & Checkout Testing','Update quantity / remove item','manual',null,7),
('Cart & Checkout Testing','Check empty cart state','manual',null,8),
('Cart & Checkout Testing','Verify guest checkout option','manual',null,9),
('Cart & Checkout Testing','Test address & pincode serviceability','manual',null,10),
('Cart & Checkout Testing','Check shipping cost calculation display','manual',null,11),
-- Performance & Speed
('Performance & Speed Testing','Core Web Vitals (LCP, INP, CLS) via PageSpeed','auto','cwv',1),
('Performance & Speed Testing','Verify optimized images are loading','manual',null,2),
('Performance & Speed Testing','Check lazy loading sections','manual',null,3),
('Performance & Speed Testing','Ensure no heavy scripts breaking performance','auto','load_speed',4),
('Performance & Speed Testing','Audit third-party app script bloat','manual',null,5),
-- App & Integration
('App & Integration Testing','Verify wishlist app','manual',null,1),
('App & Integration Testing','Test review integrations','manual',null,2),
-- SEO & Metadata
('SEO & Metadata Testing','Check meta titles / descriptions on key pages','auto','meta',1),
('SEO & Metadata Testing','Verify sitemap.xml & robots.txt','auto','robots_sitemap',2),
('SEO & Metadata Testing','Check schema markup (product, breadcrumb)','auto','schema',3),
('SEO & Metadata Testing','Verify image alt text','manual',null,4),
('SEO & Metadata Testing','Check canonical tags','auto','canonical',5),
-- Security & Compliance
('Security & Compliance Testing','Verify SSL certificate validity','auto','ssl',1),
('Security & Compliance Testing','Check cookie consent banner','manual',null,2),
('Security & Compliance Testing','Verify Privacy / Terms / Returns pages load','auto','policy_pages',3),
-- Cross-Browser & Accessibility
('Cross-Browser & Accessibility Testing','Test on Chrome / Safari / Firefox / Edge','manual',null,1),
('Cross-Browser & Accessibility Testing','Check keyboard nav / screen reader basics','manual',null,2),
('Cross-Browser & Accessibility Testing','Verify 404 page & broken link check','auto','broken_links',3)
on conflict do nothing;
