-- ============================================================================
-- PERFORMANCE INDEX — paste into Supabase → SQL Editor → Run.
--
-- WHY: a cold dash_stats over a 7-day window takes ~19s. The cost is
-- percentile_cont, which sorts every metric value in the window. Postgres walks
-- the created_at index but then does a HEAP FETCH for each row just to read
-- lcp / inp / cls / fcp / ttfb. On 60k rows that is ~60k random heap reads.
--
-- A COVERING index stores those columns INSIDE the index (INCLUDE), so the scan
-- becomes an Index Only Scan with (near) zero heap access.
--
-- No CONCURRENTLY here: Supabase's SQL Editor runs inside a transaction and
-- CONCURRENTLY is disallowed there. A plain CREATE INDEX briefly locks writes
-- (a few seconds on this table) — acceptable, and the beacon collector retries.
-- ============================================================================

create index if not exists rum_window_cover_idx
  on public.rum_events (created_at desc)
  include (lcp, inp, cls, fcp, ttfb, device, os, connection, time_on_page, ga_client_id, referrer, path);

analyze public.rum_events;

-- VERIFY — expect "Index Only Scan using rum_window_cover_idx" with low Heap Fetches:
explain analyze
select percentile_cont(0.75) within group (order by lcp),
       percentile_cont(0.75) within group (order by inp)
from public.rum_events
where created_at >= now() - interval '7 days';
