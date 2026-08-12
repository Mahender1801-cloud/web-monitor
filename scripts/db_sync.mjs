// ============================================================================
// db_sync.mjs — copy Supabase into the Docker Postgres archive, incrementally.
//
// Why this exists: Supabase is full because it holds every raw event back to
// 10 July. This moves the history somewhere with no ceiling, so Supabase only
// has to carry the recent window. Run it, then prune Supabase with
// storage_retention.sql — in that order, so nothing is deleted before it lands
// here.
//
// It reads through PostgREST with the anon key already in webvitals.js, so no
// database password is involved and there is no new secret to keep anywhere.
//
// Resumable by design. Big tables are walked by ascending id and the last id
// copied is written to _sync_state, so an interrupted run picks up where it
// stopped instead of starting over. Small reference tables are replaced whole
// inside a transaction, because they change in place rather than only growing.
//
//   node scripts/db_sync.mjs             # sync everything
//   node scripts/db_sync.mjs rum_events_all
//   FULL=1 node scripts/db_sync.mjs      # ignore watermarks, re-copy from zero
//
// Env: CONTAINER (default wm-archive-db), PGUSER/PGDATABASE (default monitor)
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const wv  = fs.readFileSync(new URL('../webvitals.js', import.meta.url), 'utf8');
const URL_ = wv.match(/SUPABASE_URL\s*=\s*'([^']+)'/)[1];
const KEY  = wv.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/)[1];
const H    = { apikey: KEY, Authorization: 'Bearer ' + KEY };

const CONTAINER = process.env.CONTAINER || 'wm-archive-db';
const PGUSER    = process.env.PGUSER    || 'monitor';
const PGDB      = process.env.PGDATABASE || 'monitor';
const FULL      = !!process.env.FULL;
const PAGE      = 1000;                    // PostgREST caps a response at 1000

// growing: append-only, walked by id.  replace: small, rewritten whole.
const TABLES = [
  { name: 'rum_events_all', mode: 'growing', key: 'id' },
  { name: 'funnel_events',  mode: 'growing', key: 'id' },
  { name: 'health_events',  mode: 'growing', key: 'id' },
  { name: 'task_checks',    mode: 'growing', key: 'id' },
  { name: 'script_audit',   mode: 'growing', key: 'id' },
  { name: 'shop_orders',    mode: 'growing', key: 'id' },
  { name: 'psi_results',    mode: 'growing', key: 'id' },
  { name: 'optimize_audit', mode: 'growing', key: 'id' },
  { name: 'synthetic_runs', mode: 'growing', key: 'id' },
  { name: 'alerts',         mode: 'growing', key: 'id' },
  { name: 'benchmarks',     mode: 'growing', key: 'id' },
  { name: 'rum_daily',      mode: 'replace' },
  { name: 'monitors',       mode: 'replace' },
  { name: 'task_items',     mode: 'replace' },
];

// ---------------------------------------------------------------------------
const psql = (sql) => execFileSync('docker',
  ['exec', '-i', CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const copyFrom = (table, cols, file) => {
  const cmd = `\\copy public.${table} (${cols.map(q).join(',')}) from stdin with (format csv, null '')`;
  const r = spawnSync('docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-v', 'ON_ERROR_STOP=1', '-c', cmd],
    { input: fs.readFileSync(file), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'copy failed').slice(0, 500));
};

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

async function fetchJson(pathq) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${URL_}/rest/v1/${pathq}`, { headers: H });
    if (r.ok) return r.json();
    if (![429, 500, 502, 503, 504].includes(r.status))
      throw new Error(`HTTP ${r.status} on ${pathq.slice(0, 80)}: ${(await r.text()).slice(0, 160)}`);
    await new Promise(s => setTimeout(s, 1500 * (i + 1)));
  }
  throw new Error('gave up after 4 attempts: ' + pathq.slice(0, 80));
}

// ---------------------------------------------------------------------------
// Postgres will not infer types from JSON, so they are decided here. Money is
// numeric rather than double precision on purpose: binary floating point cannot
// hold 1699.00 exactly, and these rows are order totals.
function pgType(col, values) {
  const v = values.filter(x => x !== null && x !== undefined);
  // Primary keys come in both shapes here: the event tables use a bigint
  // identity, monitors and task_items use gen_random_uuid(). Decide by what the
  // values actually are — an unconditional bigint made the uuid branch below
  // unreachable and failed those two tables on their very first row.
  if (col === 'id')
    return v.every(x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(x))
      ? 'uuid' : 'bigint';
  if (col === 'd')                        return 'date';
  if (/_at$|^created$|^updated$/.test(col)) return 'timestamptz';
  if (!v.length)                          return 'text';
  if (v.every(x => typeof x === 'boolean')) return 'boolean';
  if (v.some(x => typeof x === 'object'))   return 'jsonb';
  if (v.every(x => typeof x === 'number')) {
    if (/price|total|amount|revenue|subtotal|discount|refund/i.test(col)) return 'numeric';
    // Never narrow to an integer type from a sample. navigator.deviceMemory
    // reports 0.5 on low-end phones and whole numbers everywhere else, so 400
    // sampled rows can all be integers and row 598 still be 0.5. Guessing
    // integer here buys nothing and fails the copy a hundred thousand rows in.
    return 'double precision';
  }
  // Everything else stays text, uuid-shaped or not. session_id looks like a
  // uuid in most rows and is not one: webvitals.js falls back to
  // `${Date.now()}-${random}` when crypto.randomUUID is unavailable, so a
  // sample can be all uuids and the next page still fail. text cannot be wrong.
  return 'text';
}

function csvCell(v) {
  if (v === null || v === undefined) return '';           // unquoted empty = NULL
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number')  return Number.isFinite(v) ? String(v) : '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return '"' + s.replace(/"/g, '""') + '"';               // quoted, so '' stays ''
}

// ---------------------------------------------------------------------------
function ensureState() {
  psql(`create table if not exists public._sync_state (
          table_name text primary key,
          last_id    bigint,
          rows       bigint not null default 0,
          synced_at  timestamptz not null default now())`);
}

function ensureTable(name, sample) {
  // Union across the sample, not the keys of one row: PostgREST omits nothing,
  // but a column added upstream mid-month is absent from rows written before it
  // and taking row zero's shape would drop it from every copy.
  const cols = [...new Set(sample.flatMap(r => Object.keys(r)))];
  const defs = cols.map(c => `${q(c)} ${pgType(c, sample.map(r => r[c]))}`);
  psql(`create table if not exists public.${q(name)} (${defs.join(', ')})`);

  // Columns added upstream after this table was first created are added here
  // too, rather than silently dropped from every later copy.
  const have = new Set(psql(
    `select column_name from information_schema.columns
     where table_schema='public' and table_name='${name}'`).split('\n').filter(Boolean));
  for (const c of cols) if (!have.has(c))
    psql(`alter table public.${q(name)} add column ${q(c)} ${pgType(c, sample.map(r => r[c]))}`);
  return cols;
}

async function syncGrowing(t) {
  // Sample both ends, not just the head. Columns drift over a month — a field
  // added later is absent from the oldest rows, and a fallback format shows up
  // in a minority of them. A small head-only sample types the table off rows
  // that are not representative of the ones that will actually be copied.
  const [head, tail] = await Promise.all([
    fetchJson(`${t.name}?select=*&order=id.asc&limit=200`),
    fetchJson(`${t.name}?select=*&order=id.desc&limit=200`)
  ]);
  const sample = [...head, ...tail];
  if (!sample.length) { console.log(`  ${t.name}: empty upstream`); return; }
  const cols = ensureTable(t.name, sample);

  let last = 0;
  if (FULL) {
    psql(`truncate public.${q(t.name)}`);
  } else {
    // Resume from what the archive actually holds, never from the bookmark.
    // A copy that fails partway still leaves its earlier batches committed
    // while the bookmark stays where it was, so trusting the bookmark would
    // re-copy those rows and duplicate them. max(id) cannot disagree with
    // reality this way, which also makes an interrupted run safe to just re-run.
    last = Number(psql(`select coalesce(max(id),0) from public.${q(t.name)}`) || 0);
  }

  let copied = 0, pages = 0;
  const tmp = path.join(os.tmpdir(), `sync_${t.name}_${process.pid}.csv`);
  for (;;) {
    const rows = await fetchJson(
      `${t.name}?select=*&id=gt.${last}&order=id.asc&limit=${PAGE}`);
    if (!rows.length) break;
    fs.writeFileSync(tmp, rows.map(r => cols.map(c => csvCell(r[c])).join(',')).join('\n') + '\n');
    copyFrom(t.name, cols, tmp);
    last = rows[rows.length - 1].id;
    copied += rows.length; pages++;
    if (pages % 25 === 0) process.stdout.write(`\r  ${t.name}: ${copied.toLocaleString()} rows…`);
    if (rows.length < PAGE) break;
  }
  fs.existsSync(tmp) && fs.unlinkSync(tmp);

  const total = psql(`select count(*) from public.${q(t.name)}`);
  psql(`insert into public._sync_state (table_name,last_id,rows,synced_at)
        values ('${t.name}',${last},${total},now())
        on conflict (table_name) do update set last_id=excluded.last_id,
          rows=excluded.rows, synced_at=now()`);
  console.log(`\r  ${t.name}: +${copied.toLocaleString()} new, ${Number(total).toLocaleString()} held`);
}

async function syncReplace(t) {
  const rows = await fetchJson(`${t.name}?select=*&limit=10000`);
  if (!rows.length) { console.log(`  ${t.name}: empty upstream`); return; }
  const cols = ensureTable(t.name, rows.slice(0, 50));
  const tmp = path.join(os.tmpdir(), `sync_${t.name}_${process.pid}.csv`);
  fs.writeFileSync(tmp, rows.map(r => cols.map(c => csvCell(r[c])).join(',')).join('\n') + '\n');
  // Swap through a staging table so a failure mid-copy cannot leave the archive
  // holding a half-written reference table.
  psql(`drop table if exists public.${q(t.name + '_stage')}`);
  psql(`create table public.${q(t.name + '_stage')} (like public.${q(t.name)} including all)`);
  copyFrom(t.name + '_stage', cols, tmp);
  psql(`begin;
        drop table public.${q(t.name)};
        alter table public.${q(t.name + '_stage')} rename to ${q(t.name)};
        commit;`);
  fs.unlinkSync(tmp);
  psql(`insert into public._sync_state (table_name,rows,synced_at)
        values ('${t.name}',${rows.length},now())
        on conflict (table_name) do update set rows=excluded.rows, synced_at=now()`);
  console.log(`  ${t.name}: replaced, ${rows.length.toLocaleString()} rows`);
}

// ---------------------------------------------------------------------------
const only = process.argv[2];
const list = only ? TABLES.filter(t => t.name === only) : TABLES;
if (only && !list.length) { console.error(`unknown table: ${only}`); process.exit(1); }

try { psql('select 1'); }
catch { console.error(`cannot reach container "${CONTAINER}". Start it with:\n  docker compose -f docker/docker-compose.yml up -d`); process.exit(1); }

ensureState();
console.log(`syncing ${list.length} table(s) into ${CONTAINER}${FULL ? ' (FULL re-copy)' : ''}\n`);
const t0 = Date.now();
for (const t of list) {
  try { t.mode === 'growing' ? await syncGrowing(t) : await syncReplace(t); }
  catch (e) { console.error(`  ${t.name}: FAILED — ${(e.message || e).slice(0, 200)}`); }
}
console.log(`\ndone in ${Math.round((Date.now() - t0) / 1000)}s`);
console.log(psql(`select table_name, coalesce(rows,0) rows, to_char(synced_at,'HH24:MI:SS') at
                  from public._sync_state order by rows desc`)
  .split('\n').filter(Boolean).map(l => '  ' + l.split('|').join('  ')).join('\n'));
