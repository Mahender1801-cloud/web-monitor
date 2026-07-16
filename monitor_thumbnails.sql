-- ============================================================================
-- Monitor thumbnails — cached page screenshots per device.
-- Run ONCE in Supabase → SQL Editor. Idempotent.
-- After running, trigger the GitHub Action once (Actions → Site monitor →
-- Run workflow). It captures a Mobile + Desktop screenshot of each monitored
-- page and stores it here, so the dashboard loads thumbnails instantly.
-- ============================================================================

alter table public.monitors add column if not exists screenshot_mobile  text;
alter table public.monitors add column if not exists screenshot_desktop text;
