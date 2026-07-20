-- ============================================================================
-- EMERGENCY DATABASE FIX — paste into Supabase → SQL Editor → Run.
--
-- SYMPTOM: visitor beacon INSERTs returning 504, reads timing out, ~1,100
-- "canceling statement due to statement timeout" errors per half hour.
--
-- CAUSES:
--  1. The dashboard fired ~35 heavy queries per page load (fixed in code, deployed).
--  2. 34,095 rows were bulk-inserted during the backfill, leaving Postgres'
--     planner statistics stale — so it switched to SEQUENTIAL SCANS and started
--     reading all ~95k rows for every query. Statement 1 below fixes that.
--
-- NOTE: this uses ANALYZE, not VACUUM. Supabase's SQL Editor runs inside a
-- transaction and VACUUM is not allowed there ("25001: VACUUM cannot run inside
-- a transaction block"). ANALYZE is what refreshes the planner statistics, which
-- is the actual problem. Only rows were INSERTed (never deleted/updated), so
-- there is little dead space for VACUUM to reclaim anyway — and Supabase's
-- autovacuum will handle that on its own schedule.
-- ============================================================================

-- 1) THE IMPORTANT ONE — refresh planner statistics after the bulk insert.
analyze public.rum_events;

-- 2) Make sure the indexes the dashboard relies on exist.
create index if not exists rum_created_idx      on public.rum_events (created_at desc);
create index if not exists rum_created_path_idx on public.rum_events (created_at desc, path);
create index if not exists rum_ga_client_idx    on public.rum_events (ga_client_id);

-- 3) Stop runaway aggregations from piling up and starving visitor INSERTs.
--    A query that cannot finish in 10s should die rather than hold resources.
alter function public.dash_stats(timestamptz, timestamptz) set statement_timeout = '10s';
alter function public.dash_trend(timestamptz, timestamptz, text, text) set statement_timeout = '10s';

-- 4) VERIFY — after ANALYZE this should say "Index Scan" / "Index Only Scan",
--    NOT "Seq Scan", and finish in well under a second.
explain analyze
select count(*) from public.rum_events
where created_at >= now() - interval '24 hours';
