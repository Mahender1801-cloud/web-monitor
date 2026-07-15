-- ============================================================================
-- Extra RUM columns — marketing attribution + device context.
-- Run this in Supabase → SQL Editor BEFORE pasting the updated collector into
-- Shopify. (If the collector sends a column that doesn't exist yet, the whole
-- insert is rejected and you lose that event — so run this first.)
-- Idempotent: safe to re-run.
-- ============================================================================

alter table public.rum_events add column if not exists utm_source   text;
alter table public.rum_events add column if not exists utm_medium   text;
alter table public.rum_events add column if not exists utm_campaign text;
alter table public.rum_events add column if not exists screen       text;
alter table public.rum_events add column if not exists lang         text;

-- These are captured by the updated collector-snippet.html:
--   utm_source / utm_medium / utm_campaign  → campaign attribution (from ?utm_* params)
--   screen                                  → full screen resolution (vs viewport)
--   lang                                    → browser language
--   raw.utm_term / raw.utm_content / raw.title / raw.pixelRatio also stored in the raw JSON.
