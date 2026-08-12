-- ============================================================================
-- Runs once, the first time the volume is created.
--
-- The repo's SQL grants to `anon` because that is the role Supabase's PostgREST
-- authenticates as. Creating the same role names here means those files apply
-- unchanged instead of needing a hand-edited copy that then drifts.
-- ============================================================================

-- PostgREST's unauthenticated role.
create role web_anon nologin;

-- The names the repo's grants refer to.
create role anon           nologin;
create role authenticated  nologin;
create role service_role   nologin bypassrls;

grant usage on schema public to web_anon, anon, authenticated, service_role;

-- Whatever the sync creates later should be readable without re-granting by hand.
alter default privileges in schema public
  grant select on tables to web_anon, anon, authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to web_anon, anon, authenticated, service_role;

grant web_anon, anon, authenticated, service_role to monitor;

-- gen_random_uuid() and the digest functions the repo's SQL expects.
create extension if not exists pgcrypto;
