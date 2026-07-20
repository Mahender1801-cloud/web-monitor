-- ============================================================================
-- EMERGENCY DATABASE FIX — run this in Supabase → SQL Editor, top to bottom.
--
-- SYMPTOM: visitor beacon INSERTs taking 5-21s (should be <0.5s), reads timing
-- out, ~50% error rate on the Supabase dashboard.
--
-- TWO CAUSES:
--  1. The dashboard was firing ~35 heavy queries per page load (already fixed
--     in code and deployed).
--  2. 34,095 rows were bulk-inserted during the backfill. Postgres' planner
--     statistics went stale, so it started choosing SEQUENTIAL SCANS over the
--     index — every query then read all ~95k rows. That is what this fixes.
-- ============================================================================

-- 1) Refresh planner statistics + reclaim space after the bulk insert.
--    This is the single most important statement here.
vacuum analyze public.rum_events;

-- 2) Make sure the indexes the dashboard relies on actually exist.
create index if not exists rum_created_idx      on public.rum_events (created_at desc);
create index if not exists rum_created_path_idx on public.rum_events (created_at desc, path);
create index if not exists rum_ga_client_idx    on public.rum_events (ga_client_id);

-- 3) Stop runaway aggregations from piling up and starving the INSERTs.
--    A query that cannot finish in 10s should die rather than hold resources.
alter function public.dash_stats(timestamptz, timestamptz) set statement_timeout = '10s';
alter function public.dash_trend(timestamptz, timestamptz, text, text) set statement_timeout = '10s';

-- 4) Verify the fix — after VACUUM ANALYZE this should use an Index Scan,
--    NOT a Seq Scan, and complete in well under a second.
explain analyze
select count(*) from public.rum_events
where created_at >= now() - interval '24 hours';

-- 5) Confirm the indexes are present and being used.
select indexrelname as index_name, idx_scan as times_used, idx_tup_read as rows_read
from pg_stat_user_indexes
where relname = 'rum_events'
order by idx_scan desc;

-- 6) Table size / bloat check (informational).
select pg_size_pretty(pg_total_relation_size('public.rum_events')) as total_size,
       (select count(*) from public.rum_events) as row_count;
