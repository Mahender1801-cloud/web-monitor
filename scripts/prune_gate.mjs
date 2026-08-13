// ============================================================================
// prune_gate.mjs — answer one question before anything is deleted from Supabase:
// is every row the prune would remove already in the Docker archive?
//
// Run this, read it, and only then run the prune functions in
// storage_retention.sql. Deleting is not reversible and health_events has no
// rollup standing behind it — once those rows are gone from Supabase they exist
// only here.
//
// It compares the prune RANGE, not the tables. Comparing whole tables on a live
// system always fails: rows keep arriving, so the archive is permanently a few
// ids behind and a check written that way would either block forever or teach
// you to ignore it. Rows newer than the cut-off are not being deleted, so
// whether the archive has them yet is beside the point — they are reported
// separately as information.
//
//   node scripts/prune_gate.mjs
//
// Exit code 0 means safe to prune. Anything else means run db_sync.mjs first.
// ============================================================================
import fs from 'fs';
import { execFileSync } from 'child_process';

const wv  = fs.readFileSync(new URL('../webvitals.js', import.meta.url), 'utf8');
const URL_ = wv.match(/SUPABASE_URL\s*=\s*'([^']+)'/)[1];
const KEY  = wv.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/)[1];
const H    = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const CONTAINER = process.env.CONTAINER || 'wm-archive-db';

const psql = (sql) => execFileSync('docker',
  ['exec', '-i', CONTAINER, 'psql', '-U', 'monitor', '-d', 'monitor', '-t', '-A', '-c', sql],
  { encoding: 'utf8' }).trim();

// The windows storage_retention.sql prunes with.
const PLAN = [
  { table: 'health_events',  keepDays: 7  },
  { table: 'rum_events_all', keepDays: 14 },
];

// A dropped connection here must not read as "nothing to worry about", so every
// request retries and a failure propagates rather than returning a number.
async function get(url, extraHeaders) {
  let last;
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise(s => setTimeout(s, 1200 * i));
    try {
      const r = await fetch(url, { headers: { ...H, ...extraHeaders } });
      if (r.ok) return r;
      last = new Error('HTTP ' + r.status);
      if (![429, 500, 502, 503, 504].includes(r.status)) break;
    } catch (e) { last = e; }
  }
  throw last;
}

const countOf = (r) => {
  const n = Number((r.headers.get('content-range') || '/x').split('/')[1]);
  if (!Number.isFinite(n)) throw new Error('no count returned');
  return n;
};

// Count what sits before the cut-off. One query does it when the range is
// index-friendly; the day-by-day fallback exists only for when that times out.
//
// The fallback has to clamp its final slice to the cut-off itself. Counting
// whole days and stopping at the day containing the cut-off swallows the entire
// rest of that day — on this data that alone inflated the figure from 98k to
// 253k, and the gate then refuses a prune that was perfectly safe.
async function countBefore(table, cutISO) {
  try {
    return countOf(await get(
      `${URL_}/rest/v1/${table}?select=id&created_at=lt.${cutISO}&limit=1`,
      { Prefer: 'count=exact' }));
  } catch { /* fall through to the slower, bounded walk */ }

  const j = await (await get(`${URL_}/rest/v1/${table}?select=created_at&order=created_at.asc&limit=1`)).json();
  if (!j[0]) return 0;
  const cut = new Date(cutISO);
  let total = 0;
  for (let d = new Date(j[0].created_at.slice(0, 10) + 'T00:00:00Z'); d < cut; d.setUTCDate(d.getUTCDate() + 1)) {
    const next = new Date(d); next.setUTCDate(next.getUTCDate() + 1);
    const hi = next < cut ? next.toISOString() : cutISO;   // never step past the cut-off
    total += countOf(await get(
      `${URL_}/rest/v1/${table}?select=id&created_at=gte.${d.toISOString()}&created_at=lt.${hi}&limit=1`,
      { Prefer: 'count=exact' }));
  }
  return total;
}

try { psql('select 1'); }
catch { console.error(`archive container "${CONTAINER}" is not running.`); process.exit(2); }

console.log('Checking the archive against what the prune would delete.\n');
let safe = true;

for (const { table, keepDays } of PLAN) {
  const cut = new Date(Date.now() - keepDays * 86400000).toISOString();
  let upstream;
  try { upstream = await countBefore(table, cut); }
  catch (e) { console.error(`${table}: could not count upstream — ${e.message}`); safe = false; continue; }

  const local = Number(psql(`select count(*) from public.${table} where created_at < '${cut}'`));
  const ok = local >= upstream;
  if (!ok) safe = false;

  console.log(`${table}  (keeping ${keepDays} days, cut-off ${cut.slice(0, 10)})`);
  console.log(`  Supabase would delete : ${upstream.toLocaleString()} rows`);
  console.log(`  archive already holds : ${local.toLocaleString()} rows of that range`);
  console.log(`  ${ok ? 'SAFE — nothing would be lost'
                      : `NOT SAFE — ${(upstream - local).toLocaleString()} rows are only in Supabase`}\n`);
}

// Informational only: the live tail is always a little behind, because rows keep
// arriving while the sync runs. None of it is inside the prune range.
for (const { table } of PLAN) {
  try {
    const j = await (await get(`${URL_}/rest/v1/${table}?select=id&order=id.desc&limit=1`)).json();
    const mine = Number(psql(`select coalesce(max(id),0) from public.${table}`));
    console.log(`${table}: archive is ${Math.max(0, (j[0]?.id ?? 0) - mine).toLocaleString()} rows behind ` +
                `the live tail (newer than the cut-off, not pruned, no action needed)`);
  } catch (e) {
    console.log(`${table}: could not read the live tail (${(e.message || e).slice(0, 60)}) — informational only`);
  }
}

console.log(safe
  ? '\nSafe to run the prune functions in storage_retention.sql.'
  : '\nDo NOT prune yet. Run: node scripts/db_sync.mjs');
process.exit(safe ? 0 : 1);
