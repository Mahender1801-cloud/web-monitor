-- ============================================================================
-- GA fix #2 — run ONCE in Supabase → SQL Editor (after ga_setup.sql).
--
-- Fixes two things:
--  1) Adds a `scope` column so device-rows and page-rows can never collide
--     (GA4 returns empty/(not set) device values, which clashed with the
--      empty-string marker previously used for page rows).
--  2) Adds scope='landing' rows: purchases attributed to the page that STARTED
--     the session, which is what actually correlates with page speed.
--     (GA4 credits ecommercePurchases to the thank-you page, not the product
--      page — that is why per-page purchases all read 0.)
--
-- Existing rows are cleared because their scope is ambiguous; the next Action
-- run repopulates the full 28 days in a few seconds.
-- ============================================================================

alter table public.ga_daily add column if not exists scope text not null default 'device';

-- old unique key (date, device, page_path) allowed the collision — replace it
alter table public.ga_daily drop constraint if exists ga_daily_date_device_page_path_key;

delete from public.ga_daily;   -- ambiguous rows; refilled on next run

alter table public.ga_daily drop constraint if exists ga_daily_uniq;
alter table public.ga_daily add constraint ga_daily_uniq unique (date, scope, device, page_path);

create index if not exists ga_daily_scope_idx on public.ga_daily (scope, date desc);

-- ---------------------------------------------------------------------------
-- Link OUR tracked users to Google Analytics.
-- The collector now reads GA4's own cookies and stores them on every RUM row:
--   ga_client_id  <- _ga cookie            (GA4's per-browser user id)
--   ga_session_id <- _ga_NG5J2LV3F5 cookie (GA4's session id for this visit)
-- That gives both systems a shared key, so a slow page view here can be traced
-- to the same user/session in GA4 (and joined directly if you enable BigQuery
-- export, where this value is `user_pseudo_id`).
-- ---------------------------------------------------------------------------
alter table public.rum_events add column if not exists ga_client_id  text;
alter table public.rum_events add column if not exists ga_session_id text;
create index if not exists rum_ga_client_idx on public.rum_events (ga_client_id);

-- After the next Action run:
--   device traffic : select * from ga_daily where scope='device' order by date desc;
--   page traffic   : select * from ga_daily where scope='page'   order by sessions desc;
--   REAL per-page conversion (use this one):
--   select page_path, sum(sessions) s, sum(purchases) p,
--          round(100*sum(purchases)/nullif(sum(sessions),0),2) as cvr_pct
--   from ga_daily where scope='landing' group by 1 order by s desc limit 20;
