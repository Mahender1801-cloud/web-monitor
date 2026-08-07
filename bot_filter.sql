-- ============================================================================
-- Keep crawler traffic out of the real-user numbers.  Run ONCE in Supabase.
--
-- WHAT HAPPENED
-- On 6 Aug 2026 the dashboard showed FCP +112% (1.43s -> 3.02s) and TTFB +344%
-- (538ms -> 2.39s), while LCP was unchanged and CLS was 0. That combination is
-- impossible for real traffic: LCP is measured after TTFB, so an LCP p75 of
-- 2.02s cannot sit below a TTFB p75 of 2.39s unless the two percentiles are
-- being computed over different rows.
--
-- They were. That day 3,458 of 8,460 recorded pageviews — 41% — came from one
-- client reporting a viewport of exactly 1366x1366: a square window, which no
-- real screen is. It hit /pages/search-results-page and /search in bursts of
-- six pageviews per second, with a TTFB p75 of 3,083ms, and it never once
-- reported an LCP. So it dragged FCP and TTFB up while contributing nothing to
-- LCP, which is exactly the shape of the anomaly.
--
-- Excluding it, the same day reads FCP 1,392ms and TTFB 460ms, against 1,420ms
-- and 540ms the day before. The site did not get slower. It got marginally
-- faster, and a crawler landed on top of the measurement.
--
-- The store's own code is not involved: webvitals.js has not changed since
-- 4 Aug, and TTFB is the server's response time — no client script can move it.
--
-- WHAT ELSE TURNED UP
-- Looking for that one crawler found four, together 14,319 of 56,810 pageviews
-- over five days — 25% of everything the beacon recorded:
--
--     square 1366x1366 crawler   8,237
--     meta-externalads           5,717   Facebook's ad crawler
--     bingbot                      356
--     HeadlessChrome                10
--     one UA containing "spider"      2
--
-- Not one of those 14,319 reported an LCP. Zero. A pageview that never painted
-- a largest contentful element was never rendered for a person, so that is as
-- clean a confirmation as this data can give.
--
-- With them out, the last five days read LCP p75 2,092ms, FCP p75 1,396ms,
-- TTFB p75 357ms — an ordering that is finally physically possible.
--
-- The funnel is unaffected: 0 of 1,881 add-to-cart / checkout / buy-now events
-- in two days came from a bot session, because crawlers load pages and never
-- click. Orders and checkout health were never wrong.
--
-- Visitor and session counts were: they carried roughly 25% traffic that was
-- never a person. Conversion rate is orders over sessions, so it has been
-- understated. Expect it to RISE after this runs. That is the correction
-- landing, not a new change in behaviour.
--
-- WHY A VIEW RATHER THAN A FILTER IN EVERY QUERY
-- 42 places across this project read rum_events. Editing each one is a promise
-- to never forget the next one. Instead the table is renamed and a filtered
-- view takes its name, so every existing function, RPC and rollup starts seeing
-- humans only, with no change to any of them. The beacon keeps POSTing to
-- /rest/v1/rum_events; the view is auto-updatable, so writes still land, and
-- rows that look automated simply do not appear on the other side.
--
-- Nothing is deleted. Bot rows stay in rum_events_all and can be inspected.
-- ============================================================================

begin;

-- 1. The rule. Kept as a function so it can be tightened later without
--    rewriting the table, and so the reasoning lives in one readable place.
create or replace function public.rum_is_bot(p_viewport text, p_ua text)
returns boolean language sql immutable as $$
  select coalesce(
       -- A square viewport at four digits is not a device. Real screens are
       -- wider than they are tall, or taller than wide; none are 1366x1366.
       -- Written with split_part rather than a back-reference so the intent is
       -- readable and there is no doubt about how the engine treats it.
       (    p_viewport ~ '^[0-9]+x[0-9]+$'
        and split_part(p_viewport, 'x', 1) = split_part(p_viewport, 'x', 2)
        and length(split_part(p_viewport, 'x', 1)) >= 4 )
       -- Engines that say what they are.
    or p_ua ~* '(headless|puppeteer|playwright|phantomjs|selenium|bot/|crawler|spider)',
    false);
$$;

-- 2. Mark rows as they arrive. A trigger rather than a generated column: the
--    rule will need adjusting as crawlers change, and altering a generated
--    column rewrites the whole table.
alter table public.rum_events add column if not exists is_bot boolean not null default false;

create or replace function public.rum_mark_bot() returns trigger language plpgsql as $$
begin
  new.is_bot := public.rum_is_bot(new.viewport, new.raw->>'ua');
  return new;
end $$;

drop trigger if exists trg_rum_mark_bot on public.rum_events;
create trigger trg_rum_mark_bot before insert on public.rum_events
for each row execute function public.rum_mark_bot();

-- 3. Label what is already stored.
set local statement_timeout = '120s';
update public.rum_events
   set is_bot = true
 where is_bot = false
   and public.rum_is_bot(viewport, raw->>'ua');

-- 4. Swap the name. Everything that reads rum_events now reads humans only.
alter table public.rum_events rename to rum_events_all;

-- security_invoker matters: without it the view would run as its owner and
-- quietly bypass the row level security added in SECURITY_rls_lockdown.sql.
create view public.rum_events with (security_invoker = true) as
  select * from public.rum_events_all where is_bot = false;

-- The old table's grants do not follow to the view. Match what anon had:
-- read and insert only. Update and delete stay revoked, as before.
grant select, insert on public.rum_events to anon, authenticated;

notify pgrst, 'reload schema';

commit;

-- Every dashboard query now carries "is_bot = false"; give it an index that
-- already knows the answer. Built after the commit so the index build does not
-- sit inside the window where the table is exclusively locked.
create index if not exists rum_events_all_created_human
  on public.rum_events_all (created_at) where is_bot = false;

-- 5. Rebuild the daily rollup so the stored histograms drop the crawler too.
--    Without this the tiles keep reading yesterday's polluted aggregates.
select public.rum_rollup_refresh(4);

-- ---------------------------------------------------------------------------
-- Verify.
--
-- a) the anomaly should be gone — LCP p75 must now sit above TTFB p75:
--      select public.hist_pct(public.hist_sum(h_lcp), 50)  as lcp,
--             public.hist_pct(public.hist_sum(h_fcp), 50)  as fcp,
--             public.hist_pct(public.hist_sum(h_ttfb), 25) as ttfb
--      from public.rum_daily where d > current_date - 2;
--
-- b) how much was filtered, and what it was:
--      select date_trunc('day', created_at)::date d, count(*)
--      from public.rum_events_all where is_bot group by 1 order by 1 desc limit 7;
--
--      select viewport, path, count(*) from public.rum_events_all
--      where is_bot and created_at > now() - interval '2 days'
--      group by 1,2 order by 3 desc limit 10;
--
-- c) real traffic must be untouched — this should equal your usual daily count:
--      select count(*) from public.rum_events where created_at > current_date;
-- ---------------------------------------------------------------------------
