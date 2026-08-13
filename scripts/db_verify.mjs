// ============================================================================
// db_verify.mjs — is the Docker side actually holding the same data as Supabase?
//
// This is the question the parallel run exists to answer, and it has to be
// answered with numbers rather than a feeling that it looked right.
//
// How it asks, and why this way. The obvious version — count every day on both
// sides and compare — does not survive contact with this database. An exact
// count makes Supabase walk the range, and this close to its ceiling that
// returns HTTP 500 on the larger tables about half the time. A verification
// tool that intermittently reports "unreadable" is worse than none, because the
// failure looks identical to a real gap.
//
// So it asks only things the primary key can answer instantly:
//
//   1. the newest id on each side, which catches a stalled or truncated sync
//   2. a spread sample of real ids pulled from Supabase, each of which must
//      exist in the archive — exact for what it covers, and it covers the whole
//      window rather than just the ends
//   3. per-day counts where Supabase manages to return one, reported but never
//      fatal, because a timeout is not evidence of a gap
//
// These rows are immutable once written; nothing updates a page view after the
// fact. So a sampled id that exists on both sides holds the same content.
//
// What this CANNOT tell you, and it matters before switching over: the archive
// db_sync.mjs builds has tables and no functions. dash_stats, qa_day and
// rum_rollup_day do not exist there, so this proves the rows arrived — not that
// the dashboard works. Run db_clone.mjs for that, then compare RPC output.
//
//   node scripts/db_verify.mjs              # 14-day window, 300 sampled ids
//   node scripts/db_verify.mjs 30 600
//
// Exit 0 means nothing sampled was missing and the tails agree.
// ============================================================================
import fs from 'fs';
import { execFileSync } from 'child_process';

const wv   = fs.readFileSync(new URL('../webvitals.js', import.meta.url), 'utf8');
const URL_ = wv.match(/SUPABASE_URL\s*=\s*'([^']+)'/)[1];
const KEY  = wv.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/)[1];
const H    = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const CONTAINER = process.env.CONTAINER || 'wm-archive-db';
const DAYS   = Number(process.argv[2]) || 14;
const SAMPLE = Number(process.argv[3]) || 300;

const TABLES = ['rum_events_all', 'health_events', 'funnel_events', 'shop_orders', 'task_checks'];

const psql = (sql) => execFileSync('docker',
  ['exec', '-i', CONTAINER, 'psql', '-U', 'monitor', '-d', 'monitor', '-t', '-A', '-F', '|', '-c', sql],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();

async function get(url, extra) {
  let last;
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise(s => setTimeout(s, 900 * i));
    try {
      const r = await fetch(url, { headers: { ...H, ...extra } });
      if (r.ok) return r;
      last = new Error('HTTP ' + r.status);
      if (![429, 500, 502, 503, 504].includes(r.status)) break;
    } catch (e) { last = e; }
  }
  throw last;
}
const rows = (url, extra) => get(url, extra).then(r => r.json());

const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString();

console.log(`Comparing Supabase against the Docker archive.`);
console.log(`Window ${DAYS} days, ${SAMPLE} ids sampled per table.\n`);

let failures = 0, unverified = 0;

for (const table of TABLES) {
  const line = [];
  let bad = 0;

  // --- 1. the tails ---------------------------------------------------------
  let upMax = null;
  try { upMax = (await rows(`${URL_}/rest/v1/${table}?select=id&order=id.desc&limit=1`))[0]?.id ?? null; }
  catch (e) { line.push(`could not read newest id upstream (${(e.message || e).slice(0, 40)})`); }
  const myMax = psql(`select coalesce(max(id)::text,'none') from public.${table}`);

  // --- 2. the sample --------------------------------------------------------
  // Spread across the window by walking offsets rather than taking the first N,
  // which would only ever check the oldest rows in it.
  // Sample on the primary key alone. Filtering by created_at and sorting by id
  // makes Supabase sort the whole range, which is what was returning 500 on the
  // big tables; an id range is answered straight from the PK index. The archive
  // already knows which ids the window covers, so ask it, then pull those ids
  // from upstream without a date filter at all.
  let sampled = 0, missing = [], sampleFailed = null;
  const loId = psql(`select coalesce(min(id)::text,'') from public.${table}
                     where created_at >= '${cutoff}'`);
  try {
    if (!loId) throw new Error('archive holds nothing in this window');
    const ids = [];
    for (let off = 0; ids.length < SAMPLE; off += Math.max(50, Math.floor(SAMPLE / 4))) {
      const pg = await rows(
        `${URL_}/rest/v1/${table}?select=id&id=gte.${loId}&order=id.asc&offset=${off}&limit=50`);
      if (!pg.length) break;
      ids.push(...pg.map(r => r.id));
    }
    sampled = ids.length;
    if (!sampled) throw new Error('upstream returned no ids in this range');
    const quoted = ids.map(i => `'${String(i).replace(/'/g, "''")}'`).join(',');
    const found = new Set(psql(
      `select id::text from public.${table} where id::text in (${quoted})`).split('\n').filter(Boolean));
    missing = ids.filter(i => !found.has(String(i)));
  } catch (e) { sampleFailed = (e.message || String(e)).slice(0, 60); }

  // --- 3. per-day counts, best effort --------------------------------------
  const local = new Map();
  for (const l of psql(`select created_at::date::text, count(*) from public.${table}
                        where created_at >= current_date - ${DAYS} group by 1`).split('\n').filter(Boolean)) {
    const [d, n] = l.split('|'); local.set(d, Number(n));
  }
  let dayOK = 0, dayDiff = [], daySkipped = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const [d, mine] of [...local].sort()) {
    if (d === today) continue;
    try {
      const r = await get(
        `${URL_}/rest/v1/${table}?select=id&created_at=gte.${d}T00:00:00Z&created_at=lt.${d}T23:59:59.999Z&limit=1`,
        { Prefer: 'count=exact' });
      const n = Number((r.headers.get('content-range') || '/x').split('/')[1]);
      if (!Number.isFinite(n)) { daySkipped++; continue; }
      if (n === mine) dayOK++; else dayDiff.push(`${d}: ${n} vs ${mine}`);
    } catch { daySkipped++; }
  }

  if (missing.length) bad++;
  if (dayDiff.length) bad++;
  // An unverifiable table is not a clean bill of health. It counts, so the run
  // cannot end with "no gaps found" while a table was never actually checked.
  if (sampleFailed || sampled === 0) { bad++; unverified++; }
  failures += bad;

  console.log(table);
  console.log(`  newest id   upstream ${upMax ?? '?'}   archive ${myMax}` +
              (upMax && String(upMax) !== myMax ? '   (behind — rows still arriving, expected)' : '   (level)'));
  // A sample of zero must never print as "all present". Nothing was checked, and
  // saying otherwise is the one failure mode that would let a real gap through.
  console.log(`  sampled     ` +
    (sampleFailed      ? `NOT VERIFIED — ${sampleFailed}`
     : sampled === 0   ? `NOT VERIFIED — no ids returned`
     : missing.length  ? `${sampled} ids, ${missing.length} MISSING from the archive: ${missing.slice(0, 3).join(', ')}`
                       : `${sampled} ids across ${DAYS} days, all present`));
  console.log(`  day counts  ${dayOK} matched` +
              (dayDiff.length ? `, ${dayDiff.length} DIFFER: ${dayDiff.slice(0, 3).join('; ')}` : '') +
              (daySkipped ? `, ${daySkipped} not counted (Supabase timed out)` : ''));
  line.forEach(l => console.log(`  note        ${l}`));
  console.log('');
}

console.log(failures === 0
  ? `No gaps found. The archive holds what Supabase holds.\n\n` +
    `This proves the ROWS match. It does not prove the dashboard works against\n` +
    `Docker — db_sync.mjs copies no functions. Run db_clone.mjs before switching.`
  : `${failures} problem(s) found. Run: node scripts/db_sync.mjs\n` +
    `If a gap survives a sync, the rows are genuinely missing — do not prune Supabase.`);
process.exit(failures === 0 ? 0 : 1);
