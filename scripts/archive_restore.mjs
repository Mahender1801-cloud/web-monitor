// ============================================================================
// archive_restore.mjs — pull the GitHub Release cold store down into Docker.
//
// archive_daily.mjs runs in the cloud: it exports each day that ages out of
// Supabase's keep window to a gzipped NDJSON on the "archive" release, then
// prunes it. That release is the permanent copy, and it is written whether or
// not this laptop is awake.
//
// This is the other half. It reads that release back into the Docker archive,
// so the full history lives here too without the laptop ever having to be
// online at the right moment. Miss a month and the next run catches up.
//
// Order matters and it is deliberate: GitHub first, Docker second. The cloud
// job is the one that cannot be missed, because it is what lets Supabase prune
// and stay inside the free tier. Docker is a follower — it can lag for weeks
// and lose nothing.
//
// Safe to run as often as you like. Each asset is loaded through a staging
// table and merged with ON CONFLICT DO NOTHING, so a re-run of a day already
// held is a no-op rather than a duplicate. What has been loaded is recorded in
// _archive_loaded, keyed by asset name and size, so an asset re-uploaded larger
// upstream is noticed and pulled again.
//
//   node scripts/archive_restore.mjs            # pull everything missing
//   node scripts/archive_restore.mjs --list     # show what is missing, change nothing
//   node scripts/archive_restore.mjs --watch 3600
//
// Needs: docker running, gh authenticated. No Supabase, no database password.
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { execFileSync, spawnSync } from 'child_process';

const CONTAINER = process.env.CONTAINER || 'wm-archive-db';
const PGUSER    = process.env.PGUSER || 'monitor';
const PGDB      = process.env.PGDATABASE || 'monitor';
const TAG       = process.env.RELEASE_TAG || 'archive';
const REPO      = process.env.GH_REPO || 'Mahender1801-cloud/web-monitor';

const argv  = process.argv.slice(2);
const LIST  = argv.includes('--list');
const wi    = argv.indexOf('--watch');
const WATCH = wi > -1;
const EVERY = WATCH ? Math.max(300, Number(argv[wi + 1]) || 3600) : 0;

const psql = (sql) => execFileSync('docker',
  ['exec', '-i', CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

// Same typing rules db_sync.mjs settled on, and for the same reasons: never
// narrow a number to an integer from a sample (deviceMemory reports 0.5 on
// low-end phones), and never give session_id the uuid type (webvitals.js falls
// back to a timestamp string when crypto.randomUUID is missing).
function pgType(col, values) {
  const v = values.filter(x => x !== null && x !== undefined);
  if (col === 'id') return 'bigint';
  if (/_at$|^created$|^updated$/.test(col)) return 'timestamptz';
  if (!v.length) return 'text';
  if (v.every(x => typeof x === 'boolean')) return 'boolean';
  if (v.some(x => typeof x === 'object')) return 'jsonb';
  if (v.every(x => typeof x === 'number')) return 'double precision';
  return 'text';
}

function csvCell(v) {
  if (v === null || v === undefined) return '';          // unquoted empty = NULL
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function setup() {
  psql('create table if not exists public._archive_loaded (' +
       'asset text primary key, tbl text not null, day date not null, ' +
       'bytes bigint, rows bigint, loaded_at timestamptz not null default now())');
}

// A unique index on id is what makes a re-run harmless. Without it ON CONFLICT
// has nothing to match and the same day would stack up on every run.
function ensureUnique(table) {
  const has = psql(`select count(*) from pg_indexes where schemaname='public'
                    and tablename='${table}' and indexdef like '%UNIQUE%' and indexdef like '%(id)%'`);
  if (Number(has) > 0) return;
  const dupes = psql(`select count(*)-count(distinct id) from public.${q(table)}`);
  if (Number(dupes) > 0)
    throw new Error(`${table} holds ${dupes} duplicate id(s) — resolve those first, or the merge cannot be made safe`);
  psql(`create unique index if not exists ${table}_id_uniq on public.${q(table)} (id)`);
  console.log(`  created unique index on ${table}.id`);
}

function ensureTable(table, sample) {
  const exists = psql(`select to_regclass('public.${table}') is not null`);
  const cols = [...new Set(sample.flatMap(r => Object.keys(r)))];
  if (exists !== 't') {
    const defs = cols.map(c => `${q(c)} ${pgType(c, sample.map(r => r[c]))}`).join(', ');
    psql(`create table public.${q(table)} (${defs})`);
    console.log(`  created table ${table}`);
  } else {
    const have = new Set(psql(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='${table}'`).split('\n').filter(Boolean));
    for (const c of cols) if (!have.has(c)) {
      psql(`alter table public.${q(table)} add column ${q(c)} ${pgType(c, sample.map(r => r[c]))}`);
      console.log(`  added column ${table}.${c}`);
    }
  }
  ensureUnique(table);
  return psql(`select column_name from information_schema.columns
               where table_schema='public' and table_name='${table}'
               order by ordinal_position`).split('\n').filter(Boolean);
}

function loadRows(table, tableCols, rows) {
  const stage = `_stage_${table}`;
  psql(`drop table if exists public.${q(stage)}`);
  psql(`create table public.${q(stage)} (like public.${q(table)})`);

  const tmp = path.join(os.tmpdir(), `ar_${table}_${process.pid}.csv`);
  fs.writeFileSync(tmp, rows.map(r => tableCols.map(c => csvCell(r[c])).join(',')).join('\n') + '\n');
  const copy = `\\copy public.${stage} (${tableCols.map(q).join(',')}) from stdin with (format csv, null '')`;
  const r = spawnSync('docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', PGUSER, '-d', PGDB, '-v', 'ON_ERROR_STOP=1', '-c', copy],
    { input: fs.readFileSync(tmp), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  fs.unlinkSync(tmp);
  if (r.status !== 0) {
    psql(`drop table if exists public.${q(stage)}`);
    throw new Error((r.stderr || r.stdout || 'copy failed').slice(0, 300));
  }
  const added = psql(
    `with ins as (
       insert into public.${q(table)} select * from public.${q(stage)}
       on conflict (id) do nothing returning 1)
     select count(*) from ins`);
  psql(`drop table if exists public.${q(stage)}`);
  return Number(added);
}

function assets() {
  const out = execFileSync('gh',
    ['release', 'view', TAG, '--repo', REPO, '--json', 'assets', '-q',
     '.assets[] | [.name, .size] | @tsv'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  return out.split('\n').filter(Boolean).map(l => {
    const [name, size] = l.split('\t');
    const m = name.match(/^(.+)_(\d{4}-\d{2}-\d{2})\.ndjson\.gz$/);
    return m ? { name, size: Number(size), table: m[1], day: m[2] } : null;
  }).filter(Boolean);
}

function download(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arx_'));
  try {
    execFileSync('gh', ['release', 'download', TAG, '--repo', REPO, '--pattern', name, '--dir', dir],
      { stdio: 'pipe' });
    const text = zlib.gunzipSync(fs.readFileSync(path.join(dir, name))).toString('utf8');
    return text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function onePass() {
  const all = assets();
  const done = new Map(psql('select asset, coalesce(bytes,0) from public._archive_loaded')
    .split('\n').filter(Boolean).map(l => { const [a, b] = l.split('|'); return [a, Number(b)]; }));

  // Re-pull an asset whose size changed upstream: archive_daily re-uploads a
  // day if it exported it again, and the newer file is the correct one.
  const todo = all.filter(a => done.get(a.name) !== a.size);
  console.log(`release holds ${all.length} asset(s); ${todo.length} not yet in Docker`);

  if (LIST) {
    const byTable = {};
    for (const a of todo) (byTable[a.table] ||= []).push(a.day);
    for (const [t, days] of Object.entries(byTable)) {
      const s = days.sort();
      console.log(`  ${t}: ${s.length} day(s)  ${s[0]} -> ${s[s.length - 1]}`);
    }
    return { pulled: 0, rows: 0, failed: 0 };
  }

  let pulled = 0, rowsAdded = 0, failed = 0;
  for (const a of todo) {
    try {
      const rows = download(a.name);
      if (!rows.length) { console.log(`  ${a.name}: empty, skipped`); continue; }
      const cols = ensureTable(a.table, rows.slice(0, 200));
      const added = loadRows(a.table, cols, rows);
      psql(`insert into public._archive_loaded (asset,tbl,day,bytes,rows,loaded_at)
            values ('${a.name}','${a.table}','${a.day}',${a.size},${rows.length},now())
            on conflict (asset) do update set bytes=excluded.bytes, rows=excluded.rows, loaded_at=now()`);
      pulled++; rowsAdded += added;
      console.log(`  ${a.name}  ${rows.length.toLocaleString()} in file, ${added.toLocaleString()} new`);
    } catch (e) {
      failed++;
      console.error(`  ${a.name}: FAILED — ${(e.message || e).split('\n')[0].slice(0, 180)}`);
    }
  }
  return { pulled, rows: rowsAdded, failed };
}

try { psql('select 1'); }
catch {
  console.error(`archive container "${CONTAINER}" is not running.`);
  console.error('  docker compose -f docker/docker-compose.yml up -d');
  process.exit(1);
}
try { execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' }); }
catch { console.error('gh is not authenticated. Run: gh auth login'); process.exit(1); }

setup();

if (!WATCH) {
  const r = await onePass();
  if (!LIST) console.log(`\npulled ${r.pulled} asset(s), ${r.rows.toLocaleString()} new rows` +
                         (r.failed ? `, ${r.failed} failed` : ''));
  process.exit(r.failed ? 1 : 0);
} else {
  console.log(`watching — checking the release every ${EVERY}s. Ctrl-C to stop.\n`);
  const stop = () => { console.log('\nstopped.'); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (;;) {
    try {
      const r = await onePass();
      if (r.pulled || r.failed)
        console.log(`  ${new Date().toLocaleTimeString('en-IN', { hour12: false })}  ` +
                    `+${r.pulled} asset(s), ${r.rows.toLocaleString()} rows` + (r.failed ? `, ${r.failed} failed` : ''));
    } catch (e) { console.error('  pass failed:', (e.message || e).split('\n')[0].slice(0, 160)); }
    await new Promise(s => setTimeout(s, EVERY * 1000));
  }
}
