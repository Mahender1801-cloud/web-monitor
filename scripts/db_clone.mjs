// ============================================================================
// db_clone.mjs — make the Docker database an exact copy of Supabase, once.
//
// db_sync.mjs copies rows through PostgREST and infers column types from them.
// That is right for an archive and wrong for a replacement: it brings no
// functions, no RLS policies, no triggers, no indexes, no defaults. The
// dashboard would come up empty, because everything it calls — dash_stats,
// qa_day, rum_rollup_day, link_orders_by_intent — lives in those functions.
//
// So this uses pg_dump. It reproduces the schema exactly as Supabase holds it,
// including the RLS policies from SECURITY_rls_lockdown.sql, and then the data.
//
// The connection string stays in docker/.env and is read by this process only.
// It is never printed, never committed, and never passed on a command line
// where it would land in shell history or `docker ps` output.
//
//   node scripts/db_clone.mjs --schema-only   # structure first, to check it
//   node scripts/db_clone.mjs                 # structure and data
//
// Needs: docker running, and the stack up (docker-compose.prod.yml).
// ============================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENV  = path.join(ROOT, 'docker', '.env');

if (!fs.existsSync(ENV)) {
  console.error('docker/.env not found. Start from the template:\n  cp docker/.env.example docker/.env');
  process.exit(1);
}
const env = Object.fromEntries(fs.readFileSync(ENV, 'utf8').split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#') && l.includes('='))
  .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

const SRC = env.SUPABASE_DB_URL;
const need = ['SUPABASE_DB_URL', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'].filter(k => !env[k]);
if (need.length) { console.error('docker/.env is missing: ' + need.join(', ')); process.exit(1); }

const CONTAINER = process.env.CONTAINER || 'wm-db';
const SCHEMA_ONLY = process.argv.includes('--schema-only');
const DUMP_DIR = path.join(ROOT, 'docker', 'backups');
fs.mkdirSync(DUMP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dumpFile = path.join(DUMP_DIR, `supabase-${SCHEMA_ONLY ? 'schema' : 'full'}-${stamp}.dump`);

const run = (args, opts = {}) => spawnSync('docker', args, { stdio: 'inherit', ...opts });

console.log(`dumping ${SCHEMA_ONLY ? 'schema' : 'schema + data'} from Supabase…`);
console.log('  (this reads a few hundred MB; it will take a few minutes)');

// pg_dump runs inside a throwaway container so the host needs no Postgres
// client installed, and the version matches the server being restored into.
// The URI goes in through the environment, not argv, so it stays out of
// process listings on a shared host.
const dumpArgs = [
  'run', '--rm', '-i',
  '-e', 'SRC',                       // value comes from this process's env
  '-v', `${DUMP_DIR}:/out`,
  'postgres:16-alpine',
  'sh', '-c',
  `pg_dump "$SRC" --format=custom --no-owner --schema=public ` +
  `${SCHEMA_ONLY ? '--schema-only ' : ''}--file=/out/${path.basename(dumpFile)}`
];
let r = run(dumpArgs, { env: { ...process.env, SRC } });
if (r.status !== 0) {
  console.error('\npg_dump failed. The usual causes, in order of likelihood:');
  console.error('  - the URI is the pooler (port 6543); use the direct one (5432)');
  console.error('  - the password in the URI needs URL-encoding (@ : / become %40 %3A %2F)');
  console.error('  - the project is paused, or your IP is not allowed');
  process.exit(1);
}
const mb = (fs.statSync(dumpFile).size / 1048576).toFixed(1);
console.log(`dump written: ${path.basename(dumpFile)} (${mb} MB)`);

// Restore. --clean drops what it is replacing so a re-run is not additive, and
// errors are not fatal: a dump from Supabase refers to roles and extensions
// that do not exist here, and those specific failures are expected.
console.log('\nrestoring into the container…');
r = spawnSync('docker', [
  'run', '--rm', '-i',
  '--network', 'container:' + CONTAINER,
  '-e', 'PGPASSWORD=' + env.PGPASSWORD,
  '-v', `${DUMP_DIR}:/out`,
  'postgres:16-alpine',
  'pg_restore',
  '--dbname', `postgres://${env.PGUSER}@127.0.0.1:5432/${env.PGDATABASE}`,
  // No --exit-on-error: pg_restore continues past errors by default, which is
  // what we want. A Supabase dump always fails on objects owned by roles that
  // do not exist here, and stopping at the first of those would abandon the
  // restore with most of the schema missing.
  '--no-owner', '--clean', '--if-exists',
  `/out/${path.basename(dumpFile)}`
], { stdio: 'inherit' });

console.log('\nrestore finished' + (r.status === 0 ? '' : ' with warnings (expected — see below)'));
console.log(`
Warnings mentioning roles supabase_admin / authenticator, or the extensions
pg_graphql and pgsodium, are normal: they are Supabase's own furniture and the
dashboard does not use them. What matters is that these all exist afterwards:

  docker exec ${CONTAINER} psql -U ${env.PGUSER} -d ${env.PGDATABASE} -c \\
    "select count(*) filter (where routine_type='FUNCTION') as functions
     from information_schema.routines where routine_schema='public'"

  docker exec ${CONTAINER} psql -U ${env.PGUSER} -d ${env.PGDATABASE} -c \\
    "select relname, relrowsecurity from pg_class c
     join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and relkind='r' and relrowsecurity"

  docker exec ${CONTAINER} psql -U ${env.PGUSER} -d ${env.PGDATABASE} -c \\
    "select public.dash_stats(now() - interval '7 days', now())"

The last one is the real test: if dash_stats returns numbers, the dashboard will
work against this database. Keep the dump file — it is your rollback.
`);
