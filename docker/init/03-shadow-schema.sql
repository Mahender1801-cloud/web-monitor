-- ============================================================================
-- shadow — where the browser writes during the parallel run.
--
-- The point of the parallel run is to prove Docker can RECEIVE the beacon
-- correctly before anything is switched over. That means the browser posting
-- here at the same time as it posts to Supabase, and the two being compared.
--
-- It is a separate schema and not the same tables for a reason. public.* is the
-- archive, filled by db_sync.mjs with Supabase's rows carrying Supabase's ids.
-- If the browser also inserted there, the same page view would be stored twice —
-- once copied, once received — and the ids would eventually collide. Keeping the
-- two apart means both keep working, and the comparison stays honest because
-- neither side can contaminate the other.
--
-- So during the run:
--   public.*  keeps mirroring Supabase, db_verify.mjs keeps passing
--   shadow.*  holds only what shoppers' browsers sent straight here
--   shadow_compare.mjs puts the two counts side by side, hour by hour
--
-- After the switch, shadow is dropped and public becomes the live database.
-- ============================================================================

create schema if not exists shadow;
grant usage on schema shadow to web_anon, anon;

-- Deliberately not a copy of the upstream table definition. These carry what the
-- beacon actually sends plus a server-side arrival time, so a clock difference
-- on a shopper's phone cannot shift a row into the wrong hour and look like a
-- discrepancy that isn't one.
create table if not exists shadow.rum_events (
  id          bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  payload     jsonb       not null
);
create table if not exists shadow.funnel_events (
  id          bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  payload     jsonb       not null
);
create table if not exists shadow.health_events (
  id          bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  payload     jsonb       not null
);

create index if not exists shadow_rum_at    on shadow.rum_events    (received_at desc);
create index if not exists shadow_funnel_at on shadow.funnel_events (received_at desc);
create index if not exists shadow_health_at on shadow.health_events (received_at desc);

-- Storing the payload whole, rather than as columns, is what makes this a fair
-- test. Columns would need types, types need guesses, and a guess that rejects a
-- field would look like Docker losing data when it was really this schema being
-- wrong. jsonb accepts whatever the beacon sends, so any difference found later
-- is a real difference.

-- INSERT only, to the roles the public can reach. The key that reaches the
-- browser is readable by anyone who opens the network tab; these grants are the
-- only thing standing between that key and the table.
grant insert on shadow.rum_events, shadow.funnel_events, shadow.health_events
  to web_anon, anon;
revoke update, delete, truncate on shadow.rum_events, shadow.funnel_events, shadow.health_events
  from web_anon, anon;

-- Reading stays with the owner, so a scraper cannot pull the store's traffic
-- back out of the endpoint it is allowed to write to.
revoke select on shadow.rum_events, shadow.funnel_events, shadow.health_events
  from web_anon, anon;

-- Confirm what the public roles can do here — a mistake should be visible:
--   select grantee, table_name, string_agg(privilege_type, ', ' order by privilege_type)
--   from information_schema.role_table_grants
--   where grantee in ('web_anon','anon') and table_schema='shadow'
--   group by 1,2 order by 2;
