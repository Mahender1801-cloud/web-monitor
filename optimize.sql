-- ============================================================================
-- Speed pass. Run once in Supabase -> SQL Editor. All idempotent + safe.
--
-- After the big backfills the planner stats were stale (it mis-estimated row
-- counts and picked slow plans). ANALYZE fixes that. We also make sure every
-- index the dashboard relies on exists, so scans stay Index-Only.
-- ============================================================================

-- 1) Refresh planner statistics (the single biggest safe win after large inserts)
analyze public.rum_events;
analyze public.funnel_events;
analyze public.shop_orders;

-- 2) Ensure indexes exist (no-ops if already there)
create index if not exists rum_window_cover_idx on public.rum_events (created_at desc)
  include (lcp, inp, cls, fcp, ttfb, device, os, connection, time_on_page, ga_client_id, referrer, path);
create index if not exists rum_session_cover_idx on public.rum_events (created_at)
  include (session_id, path, ga_client_id, time_on_page, device, referrer);
create index if not exists rum_gaclient_idx  on public.rum_events (ga_client_id, created_at) where ga_client_id is not null;
create index if not exists rum_sessionid_idx on public.rum_events (session_id, created_at)   where session_id  is not null;
create index if not exists shop_orders_created_idx    on public.shop_orders (created_at desc);
create index if not exists shop_orders_rumsession_idx on public.shop_orders (rum_session);

-- 3) Cap the very heavy percentile queries so a huge "All" window degrades
--    gracefully instead of hanging (they already fall back to a partial result).
--    Nothing to change here — just re-analyze after any manual cleanup.
analyze public.rum_events;
