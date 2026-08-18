// ============================================================================
// keywords_expand.mjs — discover keywords from Google, free and unmetered.
//
// This is the one Google surface that answers this machine without a CAPTCHA.
// Scraping google.com/search from here returns a 302 to /sorry/index on the
// very first request — not after fifty, on the first — and getting past that is
// what SerpApi and Ahrefs are actually charging for: residential proxies and
// CAPTCHA handling, not the data itself.
//
// Suggest is different. It is the endpoint the search box itself calls, it is
// not rate-limited in any way that matters at this volume, and it returns what
// people actually type — which is where "related searches" comes from.
//
// What it gives you, per seed keyword:
//   * the completions Google offers (what people search next)
//   * alphabet expansion — seed + each letter — which surfaces the long tail
//   * question forms, the same set Google draws People Also Ask from
//
// What it cannot give you: positions. Nothing here says who ranks where. Pair
// it with gsc.mjs for your own rank and serp.mjs for everyone else's.
//
//   node scripts/keywords_expand.mjs                 # expand top GSC queries
//   node scripts/keywords_expand.mjs "blue light glasses"
//   DEEP=1 node scripts/keywords_expand.mjs          # add alphabet expansion
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SEEDS (default 20)
// ============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const SEEDS        = Number(process.env.SEEDS || 20);
const DEEP         = !!process.env.DEEP;
const GL           = process.env.SERP_COUNTRY || 'in';

const QUESTIONS = ['how', 'what', 'which', 'why', 'best', 'is', 'are', 'can'];
const LETTERS   = 'abcdefghijklmnopqrstuvwxyz'.split('');

const sleep = (ms) => new Promise(s => setTimeout(s, ms));

async function suggest(q) {
  const u = `https://suggestqueries.google.com/complete/search` +
            `?client=firefox&hl=en&gl=${GL}&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) && Array.isArray(j[1]) ? j[1] : [];
  } catch { return []; }
}

async function expand(seed) {
  const found = new Map();          // keyword -> how it was reached
  const add = (list, how) => list.forEach(k => {
    const s = String(k).trim().toLowerCase();
    if (s && s !== seed.toLowerCase() && !found.has(s)) found.set(s, how);
  });

  add(await suggest(seed), 'completion');
  await sleep(350);

  for (const w of QUESTIONS) {
    add(await suggest(`${w} ${seed}`), 'question');
    await sleep(300);
  }

  // Alphabet expansion is 26 more calls per seed. Worth it for a handful of
  // money terms, wasteful across a whole keyword set, so it is opt-in.
  if (DEEP) {
    for (const c of LETTERS) {
      add(await suggest(`${seed} ${c}`), 'long-tail');
      await sleep(250);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
const oneOff = process.argv.slice(2).join(' ').trim();
let seeds = [];

if (oneOff) {
  seeds = [oneOff];
} else {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.log('Give it a keyword, or set SUPABASE_URL/SUPABASE_SERVICE_KEY to expand');
    console.log('the queries Search Console already reports.\n');
    console.log('  node scripts/keywords_expand.mjs "blue light glasses"');
    process.exit(0);
  }
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/gsc_keywords?select=query,impressions&d=gte.${
      new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10)
    }&order=impressions.desc&limit=400`,
    { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
  if (!r.ok) { console.error(`could not read gsc_keywords (${r.status}) — run serp.sql and gsc.mjs first`); process.exit(1); }
  const rows = await r.json();
  const byQ = new Map();
  for (const x of rows) byQ.set(x.query, (byQ.get(x.query) || 0) + (x.impressions || 0));
  seeds = [...byQ.entries()].sort((a, b) => b[1] - a[1]).slice(0, SEEDS).map(x => x[0]);
  if (!seeds.length) { console.log('gsc_keywords is empty — run scripts/gsc.mjs first.'); process.exit(0); }
}

console.log(`expanding ${seeds.length} seed(s)${DEEP ? ' with alphabet expansion' : ''}\n`);

const all = new Map();
for (const seed of seeds) {
  const got = await expand(seed);
  for (const [k, how] of got) if (!all.has(k)) all.set(k, { how, seed });
  console.log(`  ${seed.padEnd(42).slice(0, 42)} +${got.size}`);
}

console.log(`\n${all.size} distinct keywords discovered.`);

// Which of these does the shop already get impressions for? The ones it does
// not are the actual finding — a demand Google sees and this site does not answer.
if (SUPABASE_URL && SERVICE_KEY) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/gsc_keywords?select=query&limit=10000`,
    { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
  if (r.ok) {
    const known = new Set((await r.json()).map(x => x.query.toLowerCase()));
    const gaps = [...all.keys()].filter(k => !known.has(k));
    console.log(`${all.size - gaps.length} already appear in Search Console; ${gaps.length} do not.\n`);
    console.log('Not currently ranking for these — the gap list:');
    gaps.slice(0, 25).forEach(k => console.log(`  ${k}`));
    if (gaps.length > 25) console.log(`  …and ${gaps.length - 25} more`);
  }
} else {
  [...all.keys()].slice(0, 40).forEach(k => console.log(`  ${k}`));
}
