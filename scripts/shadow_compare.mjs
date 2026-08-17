// ============================================================================
// shadow_compare.mjs — during the parallel run, did Docker receive what
// Supabase received?
//
// db_verify.mjs answers a different question: whether the archive copy matches.
// That copy is pulled by db_sync.mjs, so of course it matches — it cannot prove
// Docker can take a beacon straight from a shopper's browser. This can. It
// compares, hour by hour, what Supabase was sent against what arrived in the
// shadow schema over the same hour.
//
// Read it as a delivery rate, not as a pass or fail. A few percent short is
// normal and expected: the two writes are issued back to back but independently,
// so a page closing mid-flight can land one and drop the other, and keepalive
// only promises the browser will try. A large or growing shortfall is the real
// signal — it means the tunnel dropped, the hostname changed, or CORS is
// rejecting the request, and those are exactly what this run exists to catch
// before anything is switched over.
//
// Hours are bucketed on arrival time at each side, never on a timestamp the
// browser set, so a wrong clock on a shopper's phone cannot move a row into a
// neighbouring hour and look like a gap that is not there.
//
//   node scripts/shadow_compare.mjs          # last 24 hours
//   node scripts/shadow_compare.mjs 6
// ============================================================================
import fs from 'fs';
import { execFileSync } from 'child_process';

const wv   = fs.readFileSync(new URL('../webvitals.js', import.meta.url), 'utf8');
const URL_ = wv.match(/SUPABASE_URL\s*=\s*'([^']+)'/)[1];
const KEY  = wv.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/)[1];
const H    = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const CONTAINER = process.env.CONTAINER || 'wm-archive-db';
const HOURS = Number(process.argv[2]) || 24;

const PAIRS = [
  { label: 'page views', upstream: 'rum_events_all', shadow: 'rum_events' },
  { label: 'funnel',     upstream: 'funnel_events',  shadow: 'funnel_events' },
  { label: 'health',     upstream: 'health_events',  shadow: 'health_events' },
];

const psql = (sql) => execFileSync('docker',
  ['exec', '-i', CONTAINER, 'psql', '-U', 'monitor', '-d', 'monitor', '-t', '-A', '-F', '|', '-c', sql],
  { encoding: 'utf8' }).trim();

async function count(table, fromISO, toISO) {
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise(s => setTimeout(s, 900 * i));
    try {
      const r = await fetch(
        `${URL_}/rest/v1/${table}?select=id&created_at=gte.${fromISO}&created_at=lt.${toISO}&limit=1`,
        { headers: { ...H, Prefer: 'count=exact' } });
      if (!r.ok) continue;
      const n = Number((r.headers.get('content-range') || '/x').split('/')[1]);
      if (Number.isFinite(n)) return n;
    } catch { /* retry */ }
  }
  return null;   // never 0 — a failed count must not look like an empty hour
}

// Nothing to compare until the mirror is switched on in the theme.
//
// The character class matters. A greedy '(.+)' ran past the closing quote and
// swallowed the example URL in the trailing comment, so an empty SHADOW_URL
// read as configured and the run then blamed the tunnel for delivering nothing.
const m = /^const SHADOW_URL = '([^']*)'/m.exec(wv);
const shadowUrl = m ? m[1] : '';
if (!shadowUrl) {
  console.log('SHADOW_URL is empty in webvitals.js — no browser is mirroring yet,');
  console.log('so every percentage below will read zero. That is not a fault in the');
  console.log('tunnel; nothing has been asked to use it.\n');
  console.log('To start the parallel run:');
  console.log('  1. docker compose -f docker/docker-compose.yml --profile parallel up -d tunnel');
  console.log('  2. docker logs wm-tunnel 2>&1 | grep -o "https://.*trycloudflare.com"');
  console.log('  3. put that hostname in SHADOW_URL, upload webvitals.js to the theme');
  console.log('  4. run this again after an hour of traffic\n');
} else {
  console.log(`mirroring to ${shadowUrl}\n`);
}

const total = psql(`select
  (select count(*) from shadow.rum_events) || '|' ||
  (select count(*) from shadow.funnel_events) || '|' ||
  (select count(*) from shadow.health_events)`).split('|');
console.log(`shadow holds: ${(+total[0]).toLocaleString()} page views, ` +
            `${(+total[1]).toLocaleString()} funnel, ${(+total[2]).toLocaleString()} health\n`);

for (const p of PAIRS) {
  console.log(`${p.label}`);
  console.log(`  hour (UTC)          Supabase    Docker   delivered`);
  let sumUp = 0, sumMine = 0, unread = 0;

  for (let h = HOURS; h >= 1; h--) {
    const to   = new Date(Math.floor(Date.now() / 3600000) * 3600000 - (h - 1) * 3600000);
    const from = new Date(to.getTime() - 3600000);
    const up   = await count(p.upstream, from.toISOString(), to.toISOString());
    const mine = Number(psql(
      `select count(*) from shadow.${p.shadow}
       where received_at >= '${from.toISOString()}' and received_at < '${to.toISOString()}'`));

    if (up === null) { unread++; continue; }
    if (up === 0 && mine === 0) continue;
    sumUp += up; sumMine += mine;
    const pct = up ? (100 * mine / up) : 0;
    console.log(`  ${from.toISOString().slice(0, 13)}:00 ` +
                `${String(up).padStart(10)} ${String(mine).padStart(9)} ` +
                `${up ? pct.toFixed(1).padStart(8) + '%' : '        —'}` +
                (up && pct < 90 ? '  <-- short' : ''));
  }

  const rate = sumUp ? (100 * sumMine / sumUp) : null;
  console.log(`  ${'-'.repeat(46)}`);
  console.log(`  total ${String(sumUp).padStart(21)} ${String(sumMine).padStart(9)} ` +
              (rate === null ? '        —' : rate.toFixed(1).padStart(8) + '%') +
              (unread ? `   (${unread} hour(s) Supabase would not count)` : ''));
  console.log(
      !shadowUrl    ? '  mirror is off — nothing was asked to arrive here.\n'
    : rate === null ? '  nothing to compare yet\n'
    : rate >= 97    ? '  Docker is receiving what Supabase receives.\n'
    : rate >= 85    ? '  Mostly arriving. Check the short hours before trusting it.\n'
                    : '  Losing beacons. Do not switch over — check the tunnel and CORS.\n');
}

console.log(`Read this alongside db_verify.mjs. This one proves Docker can RECEIVE
the beacon; that one proves the archive copy is complete. Both have to be right
before the theme is pointed here and Supabase is retired.`);
