// ============================================================================
// archive_daily.mjs — cold-archive raw rows to a GitHub Release, then prune.
//
// This is the laptop-free version of the retention job. The Docker archive
// needed a machine that was on; a GitHub Release does not — it is always up,
// free, permanent, and it is where the cron already runs. So the whole "the
// laptop must be on or Supabase overflows" dependency goes away.
//
// The order is the same safe one, moved to the cloud:
//   1. for every day older than the keep window, export its raw rows to a
//      gzipped NDJSON file and upload it to the release (skip days already there)
//   2. confirm every such day now has an asset
//   3. only then delete that old raw from Supabase
//
// Nothing is lost. Aggregates (rum_daily and its summaries) stay in Supabase
// forever, so the dashboard keeps working; the raw detail lives on in the
// release and can be pulled back and queried (DuckDB reads the .ndjson.gz
// directly) if a >14-day-old drill-down is ever needed.
//
//   node scripts/archive_daily.mjs            # archive + verify + prune
//   node scripts/archive_daily.mjs --no-prune # archive + verify only
//   node scripts/archive_daily.mjs --one-day 2026-08-24 rum_events_all  # test one
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, and `gh` authenticated
//      (GITHUB_TOKEN in Actions). RELEASE_TAG (default "archive").
// ============================================================================
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { execFileSync } from 'child_process';

const wv = fs.readFileSync(new URL('../webvitals.js', import.meta.url), 'utf8');
const URL_ = process.env.SUPABASE_URL || wv.match(/SUPABASE_URL\s*=\s*'([^']+)'/)[1];
const KEY  = process.env.SUPABASE_SERVICE_KEY || wv.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/)[1];
const H    = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const TAG  = process.env.RELEASE_TAG || 'archive';
const NO_PRUNE = process.argv.includes('--no-prune');
const PAGE = 1000;

// table -> keep window. These MUST match the prune functions, or a day gets
// deleted that was never exported (keep too small) or exported forever without
// ever being pruned (keep too large).
const TABLES = [
  { name: 'rum_events_all', keepDays: 14, pruneRpc: 'rum_prune',    pruneArg: 'p_keep_days' },
  { name: 'health_events',  keepDays: 7,  pruneRpc: 'health_prune', pruneArg: 'p_keep_days' },
];

const day = (d) => d.toISOString().slice(0, 10);
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

async function get(pathq) {
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise(s => setTimeout(s, 1500 * i));
    const r = await fetch(`${URL_}/rest/v1/${pathq}`, { headers: H });
    if (r.ok) return r;
    if (![429, 500, 502, 503, 504].includes(r.status)) throw new Error(`HTTP ${r.status} ${pathq.slice(0, 70)}`);
  }
  throw new Error('gave up: ' + pathq.slice(0, 70));
}

function ghAssets() {
  // Ensure the release exists, then list its assets. `gh` prints nothing fatal
  // if it already exists; a missing release is created empty.
  try { execFileSync('gh', ['release', 'view', TAG], { stdio: 'ignore' }); }
  catch {
    execFileSync('gh', ['release', 'create', TAG, '--title', 'Raw data archive',
      '--notes', 'Cold storage of pruned raw rows. One gzipped NDJSON per table per day.'], { stdio: 'inherit' });
  }
  const out = execFileSync('gh', ['release', 'view', TAG, '--json', 'assets', '-q', '.assets[].name'],
    { encoding: 'utf8' });
  return new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
}

// Export one day of one table to a gzipped NDJSON, return the file path.
async function exportDay(table, d) {
  const from = d + 'T00:00:00Z', to = d + 'T23:59:59.999Z';
  const file = path.join(os.tmpdir(), `${table}_${d}.ndjson.gz`);
  const gz = zlib.createGzip();
  const out = fs.createWriteStream(file);
  gz.pipe(out);
  let last = null, rows = 0;
  for (;;) {
    // keyset by id — stable and index-fast, unlike offset over a big table
    const q = `${table}?select=*&created_at=gte.${from}&created_at=lte.${to}` +
              (last != null ? `&id=gt.${last}` : '') + `&order=id.asc&limit=${PAGE}`;
    const batch = await (await get(q)).json();
    if (!batch.length) break;
    for (const row of batch) gz.write(JSON.stringify(row) + '\n');
    last = batch[batch.length - 1].id;
    rows += batch.length;
    if (batch.length < PAGE) break;
  }
  await new Promise((res, rej) => { gz.end(); out.on('finish', res); out.on('error', rej); });
  return { file, rows };
}

async function rpc(fn, body) {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

// ---------------------------------------------------------------------------
// one-day test mode: export a single day and report, no upload, no prune
const oneIdx = process.argv.indexOf('--one-day');
if (oneIdx > -1) {
  const d = process.argv[oneIdx + 1], t = process.argv[oneIdx + 2] || 'rum_events_all';
  const { file, rows } = await exportDay(t, d);
  const kb = (fs.statSync(file).size / 1024).toFixed(0);
  log(`exported ${rows.toLocaleString()} rows of ${t} for ${d} -> ${file} (${kb} KB gz)`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
const cutoffOf = (keep) => { const c = new Date(); c.setUTCHours(0, 0, 0, 0); c.setUTCDate(c.getUTCDate() - keep); return c; };
const assets = ghAssets();
let allSafe = true;

for (const t of TABLES) {
  const cutoff = cutoffOf(t.keepDays);
  // which days older than the cutoff still hold rows? Ask rum_daily for the day
  // list (cheap) and intersect with what the table still has.
  const days = (await (await get(
    `rum_daily?select=d&d=lt.${day(cutoff)}&order=d.asc`)).json()).map(r => r.d);
  // health has no rum_daily coupling; derive its old days from its own min date
  if (t.name === 'health_events') {
    const lo = (await (await get(`${t.name}?select=created_at&order=created_at.asc&limit=1`)).json())[0];
    days.length = 0;
    if (lo) for (let x = new Date(lo.created_at.slice(0, 10) + 'T00:00:00Z'); x < cutoff; x.setUTCDate(x.getUTCDate() + 1)) days.push(day(x));
  }

  log(`${t.name}: ${days.length} day(s) older than ${t.keepDays}d to archive`);
  for (const d of days) {
    const asset = `${t.name}_${d}.ndjson.gz`;
    if (assets.has(asset)) continue;                     // already archived
    const { file, rows } = await exportDay(t.name, d);
    if (!rows) { fs.unlinkSync(file); continue; }        // nothing that day
    execFileSync('gh', ['release', 'upload', TAG, file, '--clobber'], { stdio: 'inherit' });
    // verify it landed before it can be counted as safe
    const after = execFileSync('gh', ['release', 'view', TAG, '--json', 'assets', '-q', '.assets[].name'], { encoding: 'utf8' });
    if (!after.includes(asset)) { allSafe = false; log(`   !! upload of ${asset} not confirmed — will not prune`); }
    else log(`   archived ${asset} (${rows.toLocaleString()} rows)`);
    fs.unlinkSync(file);
  }
}

if (NO_PRUNE) { log('--no-prune: archived only, Supabase untouched.'); process.exit(0); }
if (!allSafe) { console.error('some uploads unconfirmed — not pruning.'); process.exit(1); }
if (!process.env.SUPABASE_SERVICE_KEY) {
  console.error('archived, but pruning needs SUPABASE_SERVICE_KEY (delete is service-only). Skipped.');
  process.exit(0);
}

log('every old day is archived — pruning Supabase…');
for (const t of TABLES) {
  const r = await rpc(t.pruneRpc, { [t.pruneArg]: t.keepDays });
  const n = Array.isArray(r) ? r.reduce((a, x) => a + (x.deleted > 0 ? +x.deleted : 0), 0) : (+r || 0);
  log(`   ${t.name}: pruned ${n.toLocaleString()} rows`);
}
try { await rpc('alerts_autoresolve', {}); await rpc('alerts_expire', { p_days: 3 }); } catch {}
log('done — raw safe in the release, Supabase trimmed, no laptop involved.');
