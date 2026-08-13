-- ============================================================================
-- Let the archive accept live writes, for the parallel run.
--
-- Until now this database only ever received rows from db_sync.mjs, which
-- connects as the owner. For the shadow run webvitals.js posts here directly
-- from shoppers' browsers, arriving as PostgREST's anonymous role, so that role
-- needs INSERT — and nothing else.
--
-- INSERT only, deliberately. The key that reaches the browser is readable by
-- anyone who opens the network tab. On Supabase, RLS is what stops that key
-- deleting the table; here the grants do the same job. No UPDATE, no DELETE, no
-- TRUNCATE, to any role the public can reach.
--
-- DO NOT ENABLE THIS WHILE db_sync.mjs IS COPYING INTO THE SAME TABLES.
--
-- The two write paths do not compose. db_sync inserts Supabase's rows carrying
-- Supabase's ids; a browser insert takes an id from the local sequence created
-- below. Point both at one table and you get the same page view stored twice —
-- once copied, once received — and eventually two rows claiming one id. The
-- archive would then disagree with Supabase in a way db_verify.mjs correctly
-- reports as a gap, and the numbers on the dashboard would quietly inflate.
--
-- So pick one per table:
--
--   Comparing the two databases (what works today, no hosting needed):
--     leave this file unapplied. db_sync.mjs --watch keeps the archive level
--     with Supabase and db_verify.mjs proves they agree.
--
--   Testing that Docker can RECEIVE the beacon (needs the public HTTPS host):
--     apply this, and stop syncing these three tables — run db_sync.mjs with an
--     explicit table name for the others. Then compare per-day counts between
--     what Supabase received and what this received over the same hours.
--
-- Runs automatically on a fresh volume. On an existing one, apply it by hand:
--   docker exec -i wm-archive-db psql -U monitor -d monitor \
--     < docker/init/02-ingest-grants.sql
-- ============================================================================

do $$
declare t text;
begin
  -- Only the tables the beacon actually writes to. Everything else stays
  -- unwritable from the browser even if a payload names it.
  foreach t in array array['rum_events_all', 'funnel_events', 'health_events'] loop
    if to_regclass('public.' || t) is not null then
      execute format('grant insert on public.%I to web_anon, anon', t);
      -- The id column is an identity/sequence on Supabase but a plain bigint
      -- here, because db_sync.mjs created these tables from the data. Inserts
      -- from the browser do not carry an id, so give this copy its own default.
      if not exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name=t
                       and column_name='id' and column_default is not null) then
        execute format('create sequence if not exists public.%I', t || '_id_seq');
        execute format('select setval(%L, coalesce((select max(id) from public.%I), 0) + 1000)',
                       'public.' || t || '_id_seq', t);
        execute format('alter table public.%I alter column id set default nextval(%L)',
                       t, 'public.' || t || '_id_seq');
        execute format('grant usage on sequence public.%I to web_anon, anon', t || '_id_seq');
      end if;
      -- created_at likewise: Supabase defaults it, this copy did not.
      execute format('alter table public.%I alter column created_at set default now()', t);
    end if;
  end loop;
end $$;

-- Reading stays open so the dashboard can be pointed here to compare.
grant select on all tables in schema public to web_anon, anon;

-- Say plainly what the public roles can do, so a mistake here is visible rather
-- than assumed:
--   select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type)
--   from information_schema.role_table_grants
--   where grantee in ('web_anon','anon') and table_schema='public'
--   group by 1,2 order by 2;
