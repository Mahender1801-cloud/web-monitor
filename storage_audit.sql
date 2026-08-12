-- ============================================================================
-- READ ONLY. Changes nothing. Run this first, in Supabase -> SQL Editor.
--
-- My estimate from outside the database was ~606 MB in rum_events_all, worked
-- out from row counts and average JSON size. That method cannot see TOAST
-- compression or index overhead, so it is an estimate, not a measurement.
-- These queries give the real figures. Decide what to delete from these, not
-- from my numbers.
-- ============================================================================

-- 1) Every table, largest first: data, indexes, and the total.
select
  c.relname                                             as table,
  pg_size_pretty(pg_total_relation_size(c.oid))         as total,
  pg_size_pretty(pg_relation_size(c.oid))               as data,
  pg_size_pretty(pg_indexes_size(c.oid))                as indexes,
  to_char(c.reltuples::bigint, 'FM999,999,999')         as approx_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc;

-- 2) The whole database, one number. Compare against the 500 MB free tier.
select pg_size_pretty(pg_database_size(current_database())) as database_total;

-- 3) Column-level: which columns of rum_events_all are actually heavy.
--    'raw' is the one I expect to dominate — it is the per-event jsonb blob.
select
  pg_size_pretty(sum(pg_column_size(raw))::bigint)        as raw_jsonb,
  pg_size_pretty(sum(pg_column_size(url))::bigint)        as url,
  pg_size_pretty(sum(pg_column_size(referrer))::bigint)   as referrer,
  pg_size_pretty(sum(pg_column_size(path))::bigint)       as path,
  pg_size_pretty(sum(pg_column_size(session_id))::bigint) as session_id,
  count(*)                                               as rows
from public.rum_events_all;

-- 4) How that weight is spread over time — this is what decides the cut-off.
select
  created_at::date                                       as day,
  count(*)                                               as rows,
  count(*) filter (where is_bot)                         as bot_rows,
  pg_size_pretty(sum(pg_column_size(raw))::bigint)       as raw_on_this_day
from public.rum_events_all
group by 1 order by 1 desc;

-- ---------------------------------------------------------------------------
-- Read the output of 1 and 3 before running storage_retention.sql. If
-- rum_events_all is not the biggest table, or 'raw' is not the biggest column
-- in it, then the plan in that file is aimed at the wrong thing and should be
-- re-pointed rather than run.
-- ---------------------------------------------------------------------------
