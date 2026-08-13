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
//   node scripts/db_sync.mjs                 # sync everything, once
//   node scripts/db_sync.mjs rum_events_all
//   node scripts/db_sync.mjs --watch 60      # parallel mode: keep both sides level
//   FULL=1 node scripts/db_sync.mjs          # ignore watermarks, re-copy from zero
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
  // Replace, not growing. shop_orders.id is the Shopify order id, not a
  // sequential insert id, so it does not only ever increase: a CSV backfill or
  // an out-of-order webhook lands below the current maximum, and a keyset walk
  // of id > last would skip that row permanently. Caught by db_verify, which
  // found 12 Aug holding ids up to 7021213909240 upstream and 7020221694200
  // here. 37,000 rows is cheap to re-copy and cannot drift.
  { name: 'shop_orders',    mode: 'replace' },
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
// The archive is meant to be queried, not just held. Without these every
// dashboard query is a sequential scan of the whole table — measured at 95ms
// for a bare count over 7 days, and far worse once percentiles and group-bys
// are involved. These mirror what the upstream database already carries, so a
// query that is fast there is fast here.
//
// Created after the first copy rather than before it: maintaining an index
// during a bulk COPY of 900,000 rows costs more than building it once at the end.
const INDEXES = {
  rum_events_all: [
    // Covering index — the dashboard's window queries are answered from the
    // index alone, without touching the table.
    `create index if not exists ar_rum_window on public.rum_events_all (created_at desc)
       include (lcp, inp, cls, fcp, ttfb, device, os, connection, time_on_page, ga_client_id, referrer, path)`,
    `create index if not exists ar_rum_session on public.rum_events_all (session_id)`,
    `create index if not exists ar_rum_gaclient on public.rum_events_all (ga_client_id)`,
    `create index if not exists ar_rum_bot on public.rum_events_all (created_at desc) where is_bot`,
  ],
  health_events: [
    `create index if not exists ar_health_created on public.health_events (created_at desc)`,
    `create index if not exists ar_health_kind on public.health_events (kind, created_at desc)`,
    `create index if not exists ar_health_session on public.health_events (session_id)`,
  ],
  funnel_events: [
    `create index if not exists ar_funnel_created on public.funnel_events (created_at desc)`,
    `create index if not exists ar_funnel_type on public.funnel_events (event_type, created_at desc)`,
    `create index if not exists ar_funnel_session on public.funnel_events (session_id)`,
  ],
  shop_orders:    [`create index if not exists ar_orders_created on public.shop_orders (created_at desc)`],
  task_checks:    [`create index if not exists ar_checks_created on public.task_checks (created_at desc)`],
  script_audit:   [`create index if not exists ar_script_created on public.script_audit (created_at desc)`],
  psi_results:    [`create index if not exists ar_psi_created on public.psi_results (created_at desc)`],
  optimize_audit: [`create index if not exists ar_opt_created on public.optimize_audit (created_at desc)`],
  benchmarks:     [`create index if not exists ar_bench_created on public.benchmarks (created_at desc)`],
};

function ensureIndexes(name) {
  for (const sql of INDEXES[name] || []) {
    try { psql(sql); }
    catch (e) { console.error(`  (index skipped on ${name}: ${(e.message || '').split('\n')[0].slice(0, 90)})`); }
  }
}

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

  ensureIndexes(t.name);
  const total = psql(`select count(*) from public.${q(t.name)}`);
  psql(`insert into public._sync_state (table_name,last_id,rows,synced_at)
        values ('${t.name}',${last},${total},now())
        on conflict (table_name) do update set last_id=excluded.last_id,
          rows=excluded.rows, synced_at=now()`);
  console.log(`\r  ${t.name}: +${copied.toLocaleString()} new, ${Number(total).toLocaleString()} held`);
}

async function syncReplace(t) {
  // Paginate. PostgREST caps a response at 1000 rows whatever limit is asked
  // for, so the old single request with limit=10000 silently returned 1000 and
  // called it the whole table. It went unnoticed only because every table using
  // this path had fewer than 1000 rows — shop_orders has 37,000.
  const rows = [];
  for (let off = 0; ; off += PAGE) {
    const pg = await fetchJson(`${t.name}?select=*&order=id.asc&offset=${off}&limit=${PAGE}`);
    rows.push(...pg);
    if (pg.length < PAGE) break;
  }
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
  ensureIndexes(t.name);
  psql(`insert into public._sync_state (table_name,rows,synced_at)
        values ('${t.name}',${rows.length},now())
        on conflict (table_name) do update set rows=excluded.rows, synced_at=now()`);
  console.log(`  ${t.name}: replaced, ${rows.length.toLocaleString()} rows`);
}

// ---------------------------------------------------------------------------
// --watch keeps the archive alongside Supabase instead of behind it, which is
// what the parallel run needs: both sides holding the same rows, in the same
// order, so any divergence shows up within a minute instead of a day.
const argv = process.argv.slice(2);
const wi = argv.indexOf('--watch');
const WATCH = wi > -1;
const EVERY = WATCH ? Math.max(30, Number(argv[wi + 1]) || 60) : 0;

const only = argv.filter(a => !a.startsWith('--') && a !== String(EVERY))[0];
const list = only ? TABLES.filter(t => t.name === only) : TABLES;
if (only && !list.length) { console.error(`unknown table: ${only}`); process.exit(1); }

try { psql('select 1'); }
catch { console.error(`cannot reach container "${CONTAINER}". Start it with:\n  docker compose -f docker/docker-compose.yml up -d`); process.exit(1); }

ensureState();

async function onePass(quiet) {
  const t0 = Date.now();
  let added = 0, failed = 0;
  for (const t of list) {
    const before = quiet ? Number(psql(`select count(*) from public.${q(t.name)}`) || 0) : 0;
    try {
      t.mode === 'growing' ? await syncGrowing(t) : await syncReplace(t);
      if (quiet) added += Number(psql(`select count(*) from public.${q(t.name)}`) || 0) - before;
    } catch (e) {
      failed++;
      console.error(`  ${t.name}: FAILED — ${(e.message || e).slice(0, 200)}`);
    }
  }
  return { secs: Math.round((Date.now() - t0) / 1000), added, failed };
}

if (!WATCH) {
  console.log(`syncing ${list.length} table(s) into ${CONTAINER}${FULL ? ' (FULL re-copy)' : ''}\n`);
  const r = await onePass(false);
  console.log(`\ndone in ${r.secs}s`);
  console.log(psql(`select table_name, coalesce(rows,0) rows, to_char(synced_at,'HH24:MI:SS') at
                    from public._sync_state order by rows desc`)
    .split('\n').filter(Boolean).map(l => '  ' + l.split('|').join('  ')).join('\n'));
} else {
  // Parallel mode. A failure is logged and the loop continues: a blip upstream
  // must not end a run that is meant to last a day, and because each pass
  // resumes from max(id), nothing is skipped by having failed once.
  console.log(`watching — syncing ${list.length} table(s) every ${EVERY}s. Ctrl-C to stop.\n`);
  let passes = 0, totalFailed = 0;
  const stop = () => {
    console.log(`\nstopped after ${passes} passes, ${totalFailed} failed table-syncs.`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (;;) {
    const r = await onePass(true);
    passes++; totalFailed += r.failed;
    console.log(`  ${new Date().toLocaleTimeString('en-IN', { hour12: false })}  ` +
                `pass ${passes}: +${r.added.toLocaleString()} rows in ${r.secs}s` +
                (r.failed ? `  (${r.failed} table(s) failed)` : ''));
    await new Promise(s => setTimeout(s, EVERY * 1000));
  }
}
