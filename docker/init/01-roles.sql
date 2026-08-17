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

-- web_anon and anon are the roles an unauthenticated request lands on, and the
-- moment this database is reachable from the internet — a Cloudflare tunnel for
-- the parallel run, or a real host later — they are what the public gets.
--
-- They are deliberately given nothing in public. That schema holds the archive:
-- every page view, every order, the whole history. This was originally granted
-- SELECT for convenience, and the first time a tunnel was pointed at PostgREST
-- the entire archive answered 200 to an anonymous GET from the open internet.
-- Convenience is not worth that; the dashboard, when it is pointed here, will
-- authenticate.
grant usage on schema public to authenticated, service_role;

alter default privileges in schema public
  grant all on tables to service_role;
alter default privileges in schema public
  grant select on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated, service_role;

grant web_anon, anon, authenticated, service_role to monitor;

-- gen_random_uuid() and the digest functions the repo's SQL expects.
create extension if not exists pgcrypto;
