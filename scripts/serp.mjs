// ============================================================================
// serp.mjs — who else ranks for the keywords this shop earns from.
//
// Search Console gives your own position for free and forever. It cannot tell
// you who is above you, because it only reports your own property. That needs a
// real search per keyword, and every provider meters it.
//
// So this is built around the meter rather than pretending it isn't there:
//
//   * every call is taken from a monthly ledger in Postgres, and the run stops
//     when the month is spent. Without that, the first run burns the allowance
//     and every later one silently returns nothing — which on a dashboard looks
//     identical to "our rankings collapsed".
//   * keywords are rotated by serp_next_keywords(), weighted toward terms near
//     page one and away from ones checked recently, so a small budget still
//     covers the set over time instead of re-reading the same head terms.
//   * providers are pluggable, because free tiers change. Set whichever key you
//     have; the parsing differences are handled here.
//
//   node scripts/serp.mjs              # spend up to DAILY keywords
//   node scripts/serp.mjs "blue light glasses"    # one keyword, on demand
//
// Env: nothing required — Brave is used free by default.
//      Optional: SERPAPI_KEY / SERPER_KEY / SCRAPINGDOG_KEY for Google results,
//      SUPABASE_URL, SUPABASE_SERVICE_KEY, SERP_DAILY (default 8)
// ============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const DAILY        = Number(process.env.SERP_DAILY || 8);
const OUR_DOMAIN   = (process.env.OUR_DOMAIN || 'hashtageyewears.com').toLowerCase();
const COUNTRY      = process.env.SERP_COUNTRY || 'in';

// Monthly caps are the published free allowances. They are deliberately
// conservative: overshooting a free tier either fails the call or starts
// charging, and neither belongs in a system that has to cost nothing.
const PROVIDERS = [
  {
    name: 'serpapi', key: process.env.SERPAPI_KEY, cap: 250, google: true,
    url: (q) => `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}` +
                `&gl=${COUNTRY}&hl=en&num=10&api_key=${process.env.SERPAPI_KEY}`,
    parse: (j) => (j.organic_results || []).map(r => ({
      position: r.position, url: r.link, title: r.title })),

    // Everything on the page that is not an organic result. One request already
    // paid for returns all of it, so not reading it would waste the call — and
    // paid pressure is the part organic tracking cannot see at all.
    features: (j) => {
      const out = [];
      const push = (kind, o) => out.push({ kind, ...o });

      for (const a of [...(j.ads || []), ...(j.shopping_results || [])])
        push('ad', { position: a.position ?? a.block_position ?? null,
                     title: a.title, url: a.link || a.tracking_link,
                     body: a.description || a.snippet || a.source || null,
                     extra: { price: a.price ?? null, source: a.source ?? null,
                              sitelinks: a.sitelinks ?? null } });

      for (const q of (j.related_questions || []))
        push('paa', { title: q.question, url: q.link || null,
                      body: q.snippet || q.answer || null,
                      extra: { source: q.title ?? null } });

      for (const [i, s] of (j.related_searches || []).entries())
        push('related', { position: i + 1, title: s.query, url: s.link || null });

      if (j.knowledge_graph) {
        const k = j.knowledge_graph;
        push('knowledge', { title: k.title, url: k.website || k.source?.link || null,
                            body: k.description || null,
                            extra: { type: k.type ?? null, rating: k.rating ?? null } });
      }

      if (j.ai_overview)
        push('ai_overview', {
          body: (j.ai_overview.text_blocks || [])
                  .map(b => b.snippet || (b.list || []).map(x => x.snippet).join(' ')).join('\n')
                  .slice(0, 4000) || null,
          extra: { references: (j.ai_overview.references || []).map(r => r.link).slice(0, 20) } });

      for (const [i, l] of (j.local_results?.places || j.local_results || []).entries())
        push('local', { position: l.position ?? i + 1, title: l.title,
                        url: l.links?.website || l.website || null,
                        body: l.address || null,
                        extra: { rating: l.rating ?? null, reviews: l.reviews ?? null } });

      for (const [i, n] of (j.news_results || []).entries())
        push('news', { position: n.position ?? i + 1, title: n.title, url: n.link,
                       body: n.snippet || null, extra: { source: n.source ?? null,
                                                         date: n.date ?? null } });
      return out;
    }
  },
  {
    name: 'serper', key: process.env.SERPER_KEY, cap: 2500,
    url: () => 'https://google.serper.dev/search',
    post: (q) => ({ headers: { 'X-API-KEY': process.env.SERPER_KEY, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ q, gl: COUNTRY, hl: 'en', num: 10 }) }),
    parse: (j) => (j.organic || []).map(r => ({
      position: r.position, url: r.link, title: r.title }))
  },
  {
    name: 'scrapingdog', key: process.env.SCRAPINGDOG_KEY, cap: 1000,
    url: (q) => `https://api.scrapingdog.com/google?api_key=${process.env.SCRAPINGDOG_KEY}` +
                `&query=${encodeURIComponent(q)}&country=${COUNTRY}&results=10`,
    parse: (j) => (j.organic_results || j.organic_data || []).map(r => ({
      position: r.rank || r.position, url: r.link, title: r.title }))
  },
];

// ---------------------------------------------------------------------------
// The no-key option, and the reason this feature can run without a budget.
//
// Google is closed: it answers /sorry/index with a CAPTCHA on the first request
// from this machine, and getting past that is what the paid APIs are selling.
// Brave is not. It runs its own index — not a Google or Bing mirror — and its
// results page answers plain HTTP from here with 20 organic results.
//
// Measured, not assumed: three requests in quick succession earn a 429, and at
// roughly one a minute it alternates between answering and refusing. So this
// treats 429 as "wait longer", never as failure, and hands the keyword back to
// be retried. About one keyword a minute is the sustainable rate, which is a
// few hours for a hundred keywords — fine for something that runs overnight.
//
// This reads their results page rather than their paid API. Keeping the volume
// low and backing off properly is the difference between a courteous client and
// a scraper that deserves to be blocked.
const BRAVE = {
  name: 'brave', key: 'nokey', cap: 100000, free: true, minGapMs: 60000,
  url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}`,
  init: () => ({ headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml'
  } }),
  html: true,
  parse: (h) => {
    const out = [];
    const re = /<div class="snippet[^"]*"\s+data-pos="(\d+)"\s+data-type="web"[\s\S]{0,600}?<a href="(https?:\/\/[^"]+)"/g;
    let m;
    while ((m = re.exec(h))) out.push({ slot: +m[1], url: m[2], title: '' });

    // Rank is the position among organic results, counted here — NOT data-pos.
    // data-pos is Brave's slot index across every block on the page, including
    // clusters and other non-organic panels, so it skips numbers: one page gave
    // web results at slots 1,2,5,6,7,…  Storing those as ranks would have said
    // a site was 5th when it was 3rd, on every keyword, silently.
    return out.map((r, i) => ({ position: i + 1, url: r.url, title: r.title, slot: r.slot }));
  }
};

const provider = PROVIDERS.find(p => p.key) || (process.env.NO_BRAVE ? null : BRAVE);
if (!provider) {
  console.log('No SERP provider key set. This step is optional — Search Console');
  console.log('already gives your own rankings for free, and this only adds who');
  console.log('else is on the page.\n');
  console.log('Free allowances, recurring, no card, as of Aug 2026:');
  console.log('  SERPAPI_KEY      250 searches/month   serpapi.com');
  console.log('  SERPER_KEY       2,500 one-time       serper.dev');
  console.log('  SCRAPINGDOG_KEY  1,000 one-time       scrapingdog.com');
  console.log('\nWith 250/month and SERP_DAILY=8, the budget lasts the month and');
  console.log('covers roughly 250 keyword checks — rotated, not the same 8 daily.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Domain to a name a person recognises. Anything unmapped keeps its domain,
// which is better than guessing — an unknown competitor showing up is a finding,
// and inventing a label for it would hide that.
const BRANDS = [
  [/lenskart\./i, 'Lenskart'], [/titaneyeplus|titan\./i, 'Titan Eye+'],
  [/specsmakers\./i, 'Specsmakers'], [/lensbazaar\./i, 'Lens Bazaar'],
  [/coolwinks\./i, 'Coolwinks'], [/eyemyeye\./i, 'EyeMyEye'],
  [/johnjacobs|johnjacobseyewear\./i, 'John Jacobs'], [/rayban\./i, 'Ray-Ban'],
  [/fastrack\./i, 'Fastrack'], [/vincentchase\./i, 'Vincent Chase'],
  [/amazon\./i, 'Amazon'], [/flipkart\./i, 'Flipkart'], [/myntra\./i, 'Myntra'],
  [/ajio\./i, 'Ajio'], [/nykaa/i, 'Nykaa'], [/tatacliq\./i, 'Tata CLiQ'],
  [/youtube\./i, 'YouTube'], [/wikipedia\./i, 'Wikipedia'],
  [/instagram\./i, 'Instagram'], [/facebook\./i, 'Facebook'],
  [/hashtageyewear/i, 'Hashtag Eyewear'],
];
const brandOf = (domain) => (BRANDS.find(([re]) => re.test(domain)) || [])[1] || domain;
const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); }
                          catch { return ''; } };

const sb = async (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  ...opts,
  headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY,
             'Content-Type': 'application/json', ...(opts.headers || {}) }
});

async function takeBudget() {
  // A free provider has no monthly allowance to protect, so the ledger is
  // skipped rather than filled with meaningless numbers. Its limit is a rate,
  // and that is handled by backing off in fetchSerp.
  if (provider.free || !HAS_DB) return true;
  const r = await sb('rpc/serp_budget_take', {
    method: 'POST',
    body: JSON.stringify({ p_provider: provider.name, p_cap: provider.cap, p_n: 1 })
  });
  if (!r.ok) throw new Error(`budget check failed ${r.status}`);
  return (await r.json()) === true;
}

// 429 means "slow down", not "this keyword failed". Treating the two the same
// would drop keywords that were never actually checked and quietly leave holes
// in the tracking. So a throttle is retried with a growing wait, and only a real
// error gives up.
async function fetchSerp(keyword, attempt = 0) {
  const init = provider.post
    ? { method: 'POST', ...provider.post(keyword) }
    : { method: 'GET', ...(provider.init ? provider.init() : {}) };
  const r = await fetch(provider.url(keyword), { ...init, signal: AbortSignal.timeout(45000) })
    .catch(() => null);

  if (!r || r.status === 429 || r.status === 503) {
    if (attempt >= 4) throw new Error(`${provider.name} kept throttling after 5 attempts`);
    const wait = 45000 * (attempt + 1) + Math.random() * 15000;
    console.log(`     throttled, waiting ${Math.round(wait / 1000)}s`);
    await new Promise(s => setTimeout(s, wait));
    return fetchSerp(keyword, attempt + 1);
  }
  if (!r.ok) throw new Error(`${provider.name} ${r.status}`);

  const body = provider.html ? await r.text() : await r.json();
  lastBody = body;
  const rows = provider.parse(body).filter(x => x && x.url && x.position);
  if (!rows.length) {
    // An empty page from a 200 is usually the markup having moved, which is a
    // parser problem and not a keyword with no results. Say which.
    throw new Error(`${provider.name} returned 200 but nothing parsed — page markup may have changed`);
  }
  return rows.slice(0, 10);
}

const HAS_DB = !!(SUPABASE_URL && SERVICE_KEY);

// The response of the call just made, so the ad / PAA / knowledge blocks can be
// read from the same request the organic results came from. Re-fetching to get
// them would double the cost of every keyword against a 250-a-month allowance.
let lastBody = null;

async function saveFeatures(keyword) {
  if (!provider.features || !lastBody) return null;
  let rows;
  try { rows = provider.features(lastBody); }
  catch (e) { console.error(`     features unreadable: ${(e.message||e).slice(0,80)}`); return null; }
  if (!rows.length) return null;
  const payload = rows.map(r => {
    const d = r.url ? domainOf(r.url) : '';
    return { keyword, kind: r.kind, position: r.position ?? null,
             title: (r.title || '').slice(0, 300), url: r.url || null,
             domain: d || null, brand: d ? brandOf(d) : null,
             body: (r.body || '').slice(0, 4000) || null,
             extra: r.extra ?? null, provider: provider.name };
  });
  const byKind = {};
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  if (HAS_DB) {
    const res = await sb('serp_features', { method: 'POST', headers: { Prefer: 'return=minimal' },
                                            body: JSON.stringify(payload) });
    if (!res.ok) { console.error(`     features save failed ${res.status}`); return null; }
  }
  return byKind;
}

async function save(keyword, rows) {
  const payload = rows.map(r => {
    const domain = domainOf(r.url);
    return {
      keyword, position: r.position, url: r.url, domain,
      brand: brandOf(domain), title: (r.title || '').slice(0, 300),
      is_us: domain.includes(OUR_DOMAIN), provider: provider.name, country: COUNTRY
    };
  });
  // Running without credentials is a legitimate way to try a keyword by hand,
  // so it prints instead of failing.
  if (!HAS_DB) return payload;
  const r = await sb('serp_results', { method: 'POST', headers: { Prefer: 'return=minimal' },
                                       body: JSON.stringify(payload) });
  if (!r.ok) throw new Error(`save failed ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return payload;
}

// ---------------------------------------------------------------------------
const oneOff = process.argv.slice(2).join(' ').trim();

let keywords;
if (oneOff) {
  keywords = [{ keyword: oneOff }];
} else {
  const r = await sb(`rpc/serp_next_keywords`, {
    method: 'POST', body: JSON.stringify({ p_limit: DAILY })
  });
  if (!r.ok) { console.error(`could not pick keywords (${r.status}). Has serp.sql been run?`); process.exit(1); }
  keywords = await r.json();
  if (!keywords.length) {
    console.log('No keywords to check yet — gsc_keywords is empty.');
    console.log('Run scripts/gsc.mjs first; this picks what to check from what Google');
    console.log('says you already get impressions for.');
    process.exit(0);
  }
}

console.log(`provider ${provider.name} (free cap ${provider.cap}/month), checking ${keywords.length} keyword(s)\n`);

let done = 0, spent = 0;
for (const k of keywords) {
  const kw = k.keyword;
  if (!await takeBudget()) {
    console.log(`\nmonthly budget for ${provider.name} is spent — stopping here.`);
    console.log('Nothing is lost: serp_next_keywords will pick up where this left off.');
    break;
  }
  spent++;
  try {
    const rows = await fetchSerp(kw);
    const saved = await save(kw, rows);
    const nf = await saveFeatures(kw);
    const us = saved.find(x => x.is_us);
    const top = saved.slice(0, 5).map(x => `${x.position}.${x.brand}`).join('  ');
    console.log(`  ${kw}`);
    console.log(`     ${top}`);
    if (nf) console.log(`     page: ${Object.entries(nf).map(([k, n]) => `${n} ${k}`).join(', ')}`);
    console.log(`     us: ${us ? '#' + us.position : 'not in top 10'}` +
                (k.impressions ? `   (${Number(k.impressions).toLocaleString()} impressions/28d` +
                                 `${k.position ? `, GSC avg pos ${k.position}` : ''})` : ''));
    done++;
  } catch (e) {
    console.error(`  ${kw}: ${(e.message || e).slice(0, 140)}`);
  }
  // Metered providers limit to about a call a second; Brave wants about a
  // minute. Going faster earns 429s which, on a paid tier, still spend credit.
  const gap = provider.minGapMs || 1500;
  await new Promise(s => setTimeout(s, gap + Math.random() * gap * 0.4));
}

console.log(`\n${done}/${spent} checked successfully.`);
if (HAS_DB && !provider.free) {
  const b = await sb(`serp_budget?provider=eq.${provider.name}&select=used,monthly_cap&order=month.desc&limit=1`);
  if (b.ok) { const j = await b.json();
    if (j[0]) console.log(`budget this month: ${j[0].used}/${j[0].monthly_cap} used`); }
} else if (!HAS_DB) {
  console.log('(no Supabase credentials — printed only, nothing saved)');
}
