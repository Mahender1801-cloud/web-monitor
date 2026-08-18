// ============================================================================
// serp_validate.mjs — how close is Brave to Google, on your own keywords?
//
// Brave supplies the competitor rankings because it is the only engine that
// answers this machine for free. It is a different index and a different
// algorithm, so the honest question is not "is it Google" — it is not — but
// "how far off is it, here, on the terms this shop actually competes for".
//
// That is answerable without paying anyone, because there is one site whose
// true Google position is already known: this one. Search Console reports it
// exactly. So for every keyword tracked in both places, this compares the
// position Google served against the position Brave showed, and reports the
// spread.
//
// Read the output as a confidence level, not a score:
//
//   within 2 places on most keywords   competitor ranks are worth acting on
//   within 5                           directional — trust the order, not the number
//   wider than that                    treat Brave as "who is competing", not "where"
//
// It measures agreement for one site, which is a sample, not a proof about
// every result on the page. It is still the only free evidence available, and
// it beats assuming either way.
//
//   node scripts/serp_validate.mjs           # last 30 days
//   node scripts/serp_validate.mjs 14
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (or the anon key — reads only)
// ============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const DAYS = Number(process.argv[2]) || 30;
const OUR = (process.env.OUR_DOMAIN || 'hashtageyewears.com').toLowerCase();

if (!SUPABASE_URL || !KEY) {
  console.log('Needs SUPABASE_URL and a key. Reads only — the anon key is enough.');
  process.exit(0);
}
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const get = async (p) => {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, { headers: H });
  if (r.status === 404) {
    // A missing table is a setup step, not a crash. Say which step.
    const t = p.split('?')[0];
    console.log(`The table "${t}" does not exist yet.\n`);
    console.log('Run serp.sql in Supabase -> SQL Editor, then:');
    console.log('  node scripts/gsc.mjs      # your own Google positions');
    console.log('  node scripts/serp.mjs     # who else ranks, via Brave');
    console.log('\nCome back to this once both have some data.');
    process.exit(0);
  }
  if (!r.ok) throw new Error(`${p.split('?')[0]}: HTTP ${r.status}`);
  return r.json();
};

const since = new Date(Date.now() - DAYS * 86400000).toISOString();

// Where Brave put us, most recent check per keyword.
const serp = await get(
  `serp_results?select=keyword,position,checked_at,is_us&is_us=eq.true` +
  `&checked_at=gte.${since}&order=checked_at.desc&limit=2000`);
const bravePos = new Map();
for (const r of serp) if (!bravePos.has(r.keyword)) bravePos.set(r.keyword, r.position);

// Where Google actually put us, weighted by impressions — an average position
// over a day with three impressions says much less than one over a thousand.
const gsc = await get(
  `gsc_keywords?select=query,position,impressions&d=gte.${since.slice(0, 10)}&limit=20000`);
const acc = new Map();
for (const r of gsc) {
  if (r.position == null || !r.impressions) continue;
  const a = acc.get(r.query) || { w: 0, n: 0 };
  a.w += r.position * r.impressions; a.n += r.impressions;
  acc.set(r.query, a);
}
const googlePos = new Map([...acc].map(([q, a]) => [q, a.w / a.n]));

const pairs = [];
for (const [kw, bp] of bravePos) {
  const gp = googlePos.get(kw);
  if (gp != null) pairs.push({ kw, brave: bp, google: gp, diff: Math.abs(bp - gp) });
}

if (!pairs.length) {
  console.log('Nothing to compare yet.\n');
  console.log('This needs keywords that appear in BOTH gsc_keywords and serp_results,');
  console.log('with this site inside Brave\'s top 20. Run gsc.mjs and let serp.mjs');
  console.log('work through some keywords first.');
  const b = bravePos.size, g = googlePos.size;
  console.log(`\nRight now: ${b} keyword(s) where Brave shows us, ${g} with Search Console data.`);
  process.exit(0);
}

pairs.sort((a, b) => a.diff - b.diff);
const med = pairs[Math.floor(pairs.length / 2)].diff;
const mean = pairs.reduce((t, p) => t + p.diff, 0) / pairs.length;
const within = (n) => pairs.filter(p => p.diff <= n).length;

console.log(`${pairs.length} keyword(s) where both Google and Brave show this site.\n`);
console.log(`  median gap   ${med.toFixed(1)} places`);
console.log(`  mean gap     ${mean.toFixed(1)} places`);
console.log(`  within 1     ${within(1)}  (${(100 * within(1) / pairs.length).toFixed(0)}%)`);
console.log(`  within 2     ${within(2)}  (${(100 * within(2) / pairs.length).toFixed(0)}%)`);
console.log(`  within 5     ${within(5)}  (${(100 * within(5) / pairs.length).toFixed(0)}%)`);

console.log('\n  closest and furthest:');
const show = (p) => console.log(`    ${p.kw.slice(0, 40).padEnd(42)} Google ${p.google.toFixed(1).padStart(5)}   Brave ${String(p.brave).padStart(3)}`);
pairs.slice(0, 3).forEach(show);
if (pairs.length > 6) console.log('    …');
pairs.slice(-3).forEach(show);

console.log('\n' + (
  med <= 2 ? 'Close enough that competitor ranks are worth acting on directly.'
: med <= 5 ? 'Directional. Trust the order of competitors, not the exact number.'
           : 'Treat Brave as telling you WHO competes, not WHERE they sit.'));
console.log('\nOne caveat that does not go away: this measures agreement for this');
console.log('site only. It is evidence about the index, not proof about every');
console.log('result on the page — but it is the only free evidence there is.');
