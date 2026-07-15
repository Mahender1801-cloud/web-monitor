-- ============================================================================
-- QA automation upgrade — converts the automatable "manual" checks to "auto".
-- Run this ONCE in Supabase → SQL Editor. Idempotent (safe to re-run).
-- After running, the next GitHub Action run (scheduled or "Run workflow")
-- fills these in automatically. Truly-visual checks stay manual on purpose.
-- ============================================================================

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

-- Verify what is now automated:
-- select category, item, auto_key from public.task_items where check_type='auto' order by category, sort;
