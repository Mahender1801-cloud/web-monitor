-- ============================================================================
-- APPLY ALL — run this ONCE in Supabase → SQL Editor → New query → Run.
-- Does two things:
--   1) Adds extra RUM columns (UTM campaign, screen, language)
--   2) Converts 12 automatable QA checks from manual → auto
-- Idempotent: safe to run more than once.
-- ============================================================================

-- 1) EXTRA RUM COLUMNS -------------------------------------------------------
alter table public.rum_events add column if not exists utm_source   text;
alter table public.rum_events add column if not exists utm_medium   text;
alter table public.rum_events add column if not exists utm_campaign text;
alter table public.rum_events add column if not exists screen       text;
alter table public.rum_events add column if not exists lang         text;

-- 1b) MONITOR THUMBNAILS (cached page screenshots per device) ---------------
alter table public.monitors add column if not exists screenshot_mobile  text;
alter table public.monitors add column if not exists screenshot_desktop text;

-- 2) QA AUTOMATION -----------------------------------------------------------
update public.task_items set check_type='auto', auto_key='images_load'
  where category='Homepage Testing' and item='Verify banners / sliders are loading properly';
update public.task_items set check_type='auto', auto_key='viewport_meta'
  where category='Homepage Testing' and item='Check mobile + desktop responsiveness';
update public.task_items set check_type='auto', auto_key='search_page'
  where category='Search Page Testing' and item='Test site search functionality & autocomplete';
update public.task_items set check_type='auto', auto_key='search_noresults'
  where category='Search Page Testing' and item='Verify "no results found" page behavior';
update public.task_items set check_type='auto', auto_key='review_app'
  where category='Product Page Testing' and item='Verify reviews are loading properly';
update public.task_items set check_type='auto', auto_key='images_load'
  where category='Performance & Speed Testing' and item='Verify optimized images are loading';
update public.task_items set check_type='auto', auto_key='lazyload'
  where category='Performance & Speed Testing' and item='Check lazy loading sections';
update public.task_items set check_type='auto', auto_key='script_bloat'
  where category='Performance & Speed Testing' and item='Audit third-party app script bloat';
update public.task_items set check_type='auto', auto_key='wishlist_app'
  where category='App & Integration Testing' and item='Verify wishlist app';
update public.task_items set check_type='auto', auto_key='review_app'
  where category='App & Integration Testing' and item='Test review integrations';
update public.task_items set check_type='auto', auto_key='img_alt'
  where category='SEO & Metadata Testing' and item='Verify image alt text';
update public.task_items set check_type='auto', auto_key='cookie_consent'
  where category='Security & Compliance Testing' and item='Check cookie consent banner';

-- Done. Check results:
-- select category, item, auto_key from public.task_items where check_type='auto' order by category, sort;
