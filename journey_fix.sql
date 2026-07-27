-- ============================================================================
-- Fix: the buyer/visitor JOURNEY lookup times out. showJourney() filters
-- rum_events by ga_client_id (or session_id) ordered by created_at, but neither
-- column was the LEADING key of any index -> full-table scan on 200k+ rows.
-- These two small (2-column) indexes make the lookup an instant index scan.
-- Partial (WHERE ... is not null) keeps them tiny and cheap to maintain.
-- Run once in Supabase -> SQL Editor.
-- ============================================================================

create index if not exists rum_gaclient_idx
  on public.rum_events (ga_client_id, created_at) where ga_client_id is not null;

create index if not exists rum_sessionid_idx
  on public.rum_events (session_id, created_at) where session_id is not null;

analyze public.rum_events;

-- After this, opening any journey is instant. Verify:
--   explain analyze
--   select created_at, path from public.rum_events
--   where ga_client_id = '<some id>' order by created_at limit 200;
