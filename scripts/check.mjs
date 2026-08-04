// ============================================================================
// check.mjs — the monitoring engine. Runs on GitHub Actions (Node 20+, no deps).
// For every active monitor it:
//   • runs PageSpeed Insights (mobile + desktop) -> psi_results  (Web Vitals tab)
//   • runs server-side probes (status, SSL, robots, sitemap, canonical, meta,
//     schema, policy pages, sampled broken links) -> task_checks (Tasks tab)
// Reads/writes Supabase over its REST API using the SERVICE key (bypasses RLS).
//
// Env (set as GitHub Actions secrets):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, PSI_KEY (optional but recommended)
// ============================================================================

import crypto from 'node:crypto';

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const PSI_KEY       = process.env.PSI_KEY || '';
const RUN_TYPE      = process.env.RUN_TYPE || 'scheduled';
// Google Analytics (optional — skipped cleanly if not configured)
const GA_PROPERTY_ID = process.env.GA_PROPERTY_ID || '';
const GA_SA_KEY      = process.env.GA_SA_KEY || '';
// Shopify Admin API (optional — the reliable, 100% order feed; skipped if unset)
const SHOPIFY_STORE  = process.env.SHOPIFY_STORE || '';        // e.g. c6c623-3.myshopify.com
const SHOPIFY_TOKEN  = process.env.SHOPIFY_TOKEN || '';        // legacy custom-app token (optional)
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID || '';     // Dev-Dashboard app Client ID
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || ''; // Dev-Dashboard app Secret
const SHOPIFY_BACKFILL_DAYS = +(process.env.SHOPIFY_BACKFILL_DAYS || 0); // one-time deep pull
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || '';  // Slack/Discord/any POST-to-message endpoint

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY'); process.exit(1);
}

const H = {
  'apikey': SERVICE_KEY,
  'Authorization': 'Bearer ' + SERVICE_KEY,
  'Content-Type': 'application/json'
};

async function sbSelect(table, query = '') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: H });
  if (!r.ok) throw new Error(`select ${table}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbInsert(table, rows) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(rows)
  });
  if (!r.ok) console.error(`insert ${table}: ${r.status} ${await r.text()}`);
}
async function sbUpsert(table, rows, onConflict) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows)
  });
  if (!r.ok) console.error(`upsert ${table}: ${r.status} ${await r.text()}`);
}
async function sbPatch(table, idCol, idVal, patch) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${idCol}=eq.${encodeURIComponent(idVal)}`, {
    method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(patch)
  });
  if (!r.ok) console.error(`patch ${table}: ${r.status} ${await r.text()}`);
}

// Fetch a page screenshot and return it as a base64 data URI (cached in the DB
// so the dashboard loads it instantly instead of hitting a screenshot service).
async function captureShot(url, viewportWidth, width) {
  const src = `https://image.thum.io/get/viewportWidth/${viewportWidth}/width/${width}/${url}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(src, { signal: AbortSignal.timeout(35000) });
      if (!r.ok) { await sleep(2000); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 2000) { await sleep(4000); continue; } // tiny = still generating; retry once
      const ct = r.headers.get('content-type') || 'image/jpeg';
      return `data:${ct};base64,${buf.toString('base64')}`;
    } catch { await sleep(2000); }
  }
  return null;
}

// ---- Google Analytics (GA4 Data API) ---------------------------------------
// Service-account JWT -> access token -> runReport. No external deps: Node's
// crypto signs the RS256 assertion directly.
function b64url(s) { return Buffer.from(s).toString('base64url'); }
async function gaToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now
  }));
  const unsigned = `${head}.${claim}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('GA auth failed: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}
async function gaRun(token, body) {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${GA_PROPERTY_ID}:runReport`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000)
  });
  const j = await r.json();
  if (j.error) throw new Error('GA report: ' + j.error.message);
  return (j.rows || []).map(row => ({ d: row.dimensionValues.map(x => x.value), m: row.metricValues.map(x => +x.value || 0) }));
}
async function pullGA() {
  if (!GA_PROPERTY_ID || !GA_SA_KEY) { console.log('GA not configured (GA_PROPERTY_ID / GA_SA_KEY) — skipping.'); return; }
  let sa; try { sa = JSON.parse(GA_SA_KEY); } catch { console.error('GA_SA_KEY is not valid JSON'); return; }
  try {
    const token = await gaToken(sa);
    const metrics = [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'ecommercePurchases' },
                     { name: 'purchaseRevenue' }, { name: 'addToCarts' }, { name: 'checkouts' }];
    const dateRanges = [{ startDate: '28daysAgo', endDate: 'today' }];
    const byDev  = await gaRun(token, { dateRanges, dimensions: [{ name: 'date' }, { name: 'deviceCategory' }], metrics, limit: 2000 });
    const byPage = await gaRun(token, { dateRanges, dimensions: [{ name: 'date' }, { name: 'pagePath' }], metrics, limit: 5000 });
    // Landing page = the page that STARTED the session. GA4 credits purchases to
    // the thank-you page under pagePath, so this is the only per-page attribution
    // that can be correlated with that page's speed.
    const byLand = await gaRun(token, { dateRanges, dimensions: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }], metrics, limit: 5000 });
    const iso = d => `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
    const clean = v => (!v || v === '(not set)' || v === '(none)') ? '(not set)' : v;
    const mk = (scope, date, device, page, m) => ({
      scope, date: iso(date), device, page_path: page,
      sessions: m[0], users: m[1], purchases: m[2], revenue: m[3], add_to_carts: m[4], checkouts: m[5],
      updated_at: new Date().toISOString()
    });
    const rows = [
      ...byDev.map(r  => mk('device',  r.d[0], clean(r.d[1]), '', r.m)),
      ...byPage.map(r => mk('page',    r.d[0], '', clean(r.d[1]).split('?')[0], r.m)),
      ...byLand.map(r => mk('landing', r.d[0], '', clean(r.d[1]).split('?')[0], r.m)),
    ];
    if (rows.length) { await sbUpsert('ga_daily', rows, 'date,scope,device,page_path'); }
    const orders = byDev.reduce((a, r) => a + r.m[2], 0), rev = byDev.reduce((a, r) => a + r.m[3], 0);
    const landOrders = byLand.reduce((a, r) => a + r.m[2], 0);
    console.log(`GA: ${rows.length} rows · ${orders} purchases · revenue ${rev.toFixed(0)} · ${landOrders} purchases attributed to landing pages (last 28d)`);
  } catch (e) { console.error('GA pull failed:', e.message); }
}

// ---- Shopify Admin API (the reliable order feed) ---------------------------
// The browser checkout_completed pixel captures <1% of orders. This pulls EVERY
// order server-side and upserts into shop_orders. Incremental by default (only
// orders newer than the latest we have, with a small overlap so nothing slips
// through); set SHOPIFY_BACKFILL_DAYS once for a deep historical pull.
//
// Auth: Dev-Dashboard apps use the CLIENT-CREDENTIALS grant — POST the app's
// Client ID + Secret to /admin/oauth/access_token and get a 24h token. We request
// a fresh one each run, so there's no long-lived token to store or rotate. (If a
// legacy SHOPIFY_TOKEN is provided instead, we use it directly.) The app must be
// installed on the store with the read_orders scope.
async function shopifyToken() {
  if (SHOPIFY_TOKEN) return SHOPIFY_TOKEN;                 // legacy custom-app token, if set
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) return null;
  const r = await fetch(`https://${SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(30000)
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('client_credentials failed: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function pullShopify() {
  if (!SHOPIFY_STORE || (!SHOPIFY_TOKEN && !(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET))) {
    console.log('Shopify not configured (SHOPIFY_STORE + SHOPIFY_CLIENT_ID/SECRET, or SHOPIFY_TOKEN) — skipping.'); return;
  }
  let token; try { token = await shopifyToken(); } catch (e) { console.error('Shopify auth failed:', e.message); return; }
  if (!token) { console.log('Shopify: no token — skipping.'); return; }

  const API = '2025-01';
  const gqlUrl = `https://${SHOPIFY_STORE}/admin/api/${API}/graphql.json`;
  const shH = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  // Where to start: the deep backfill window if requested, else just after our newest row.
  let sinceISO;
  if (SHOPIFY_BACKFILL_DAYS > 0) {
    sinceISO = new Date(Date.now() - SHOPIFY_BACKFILL_DAYS * 864e5).toISOString();
  } else {
    let latest = [];
    try { latest = await sbSelect('shop_orders', 'select=created_at&order=created_at.desc&limit=1'); } catch {}
    sinceISO = latest.length
      ? new Date(new Date(latest[0].created_at).getTime() - 6 * 36e5).toISOString()  // 6h overlap
      : new Date(Date.now() - 30 * 864e5).toISOString();                              // first run: 30 days
  }

  // NOTE: landingPageUrl / referrerUrl / sourceName are customer-attribution fields
  // that Shopify gates behind Protected Customer Data access. The core order fields
  // below need only `read_orders` (no PCD), so we omit those three to avoid ACCESS_DENIED.
  const query = `query($cursor: String, $q: String!) {
    orders(first: 100, after: $cursor, query: $q, sortKey: CREATED_AT) {
      edges { node {
        id name createdAt processedAt displayFinancialStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        subtotalLineItemsQuantity
      } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
  const q = `created_at:>='${sinceISO}'`;
  const numId = gid => { const m = String(gid).match(/(\d+)$/); return m ? +m[1] : null; };

  let cursor = null, pages = 0, total = 0;
  try {
    do {
      const r = await fetch(gqlUrl, { method: 'POST', headers: shH, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ query, variables: { cursor, q } }) });
      if (r.status === 429) { await sleep(2500); continue; }      // throttled — retry same cursor
      if (!r.ok) { console.error('Shopify GraphQL', r.status, (await r.text()).slice(0, 200)); break; }
      const j = await r.json();
      if (j.errors) { console.error('Shopify GraphQL errors:', JSON.stringify(j.errors).slice(0, 300)); break; }
      const conn = j.data?.orders;
      const edges = conn?.edges || [];
      if (edges.length) {
        const rows = edges.map(({ node: o }) => ({
          id: numId(o.id),
          order_number: o.name,
          created_at: o.createdAt,
          processed_at: o.processedAt,
          total_price: +(o.currentTotalPriceSet?.shopMoney?.amount ?? 0),
          currency: o.currentTotalPriceSet?.shopMoney?.currencyCode || null,
          items: o.subtotalLineItemsQuantity ?? null,
          financial_status: (o.displayFinancialStatus || '').toLowerCase(),
          landing_site: null,      // omitted — customer-attribution field needs PCD access
          referring_site: null,    // omitted — customer-attribution field needs PCD access
          source_name: null,       // omitted — needs PCD access
          raw: { fetchedAt: new Date().toISOString() }
        })).filter(x => x.id != null);
        await sbUpsert('shop_orders', rows, 'id');
        total += rows.length;
      }
      pages++;
      cursor = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
      if (cursor) await sleep(700);   // GraphQL cost-based throttle — stay comfortable
    } while (cursor && pages < 300);
    console.log(`Shopify: upserted ${total} orders across ${pages} page(s) since ${sinceISO.slice(0, 10)}.`);
  } catch (e) { console.error('Shopify pull failed:', e.message); }
}

// ---- Per-vendor performance budget -----------------------------------------
// The store loads ~86 scripts, a dozen of them third-party. Tracking that as one
// number hides which vendor regressed. This attributes weight and render-blocking
// to each vendor so a bad app update is attributable the day it ships.
const VENDORS = [
  [/judge\.?me|jdgm/i, 'Judge.me'], [/gempages/i, 'GemPages'], [/searchanise/i, 'Searchanise'],
  [/referrush/i, 'ReferRush'], [/ecoreturns/i, 'EcoReturns'], [/instareel/i, 'InstaReel'],
  [/clarity\.ms/i, 'MS Clarity'], [/googletagmanager|google-analytics|gtag/i, 'Google Tag'],
  [/facebook|connect\.facebook/i, 'Meta Pixel'], [/shiprocket/i, 'Shiprocket'],
  [/swym|wishlist/i, 'Wishlist'], [/klaviyo/i, 'Klaviyo'], [/hotjar/i, 'Hotjar'],
  [/shopify|shopifycdn|myshopify/i, 'Shopify']
];
function vendorOf(url) {
  for (const [re, name] of VENDORS) if (re.test(url)) return name;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'other'; }
}
async function scanVendors(url) {
  try {
    const { text } = await timedGet(url);
    const head = (text.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [, ''])[1];
    const srcs = [...text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
    const blocking = new Set([...head.matchAll(/<script\b(?![^>]*\b(async|defer)\b)[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[2]));
    const agg = new Map();
    for (const raw of srcs) {
      let abs; try { abs = new URL(raw, url).href; } catch { continue; }
      const v = vendorOf(abs);
      const e = agg.get(v) || { vendor: v, host: (() => { try { return new URL(abs).hostname; } catch { return null; } })(),
                                scripts: 0, bytes: 0, blocking: 0, url };
      e.scripts++; if (blocking.has(raw)) e.blocking++;
      agg.set(v, e);
    }
    // size the biggest few per vendor so the row means something
    const list = [...agg.values()];
    await Promise.all(list.slice(0, 20).map(async e => {
      const one = srcs.find(x => { try { return vendorOf(new URL(x, url).href) === e.vendor; } catch { return false; } });
      if (!one) return;
      try {
        const r = await fetch(new URL(one, url).href, { method: 'HEAD', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
        const len = +r.headers.get('content-length'); if (len) e.bytes = len * e.scripts;   // approximation, stated as such
      } catch {}
    }));
    if (list.length) await sbInsert('vendor_perf', list);
    console.log(`Vendors: ${list.length} tracked (${list.reduce((a, e) => a + e.scripts, 0)} scripts).`);
  } catch (e) { console.error('Vendor scan failed:', e.message); }
}

// ---- Whole-catalog integrity ------------------------------------------------
// The QA probe samples 8 images on one page. This walks the real catalog via
// products.json and reports every product that is missing an image, has no price,
// or is out of stock — each of those is a page that cannot convert.
async function scanCatalog(origin) {
  try {
    const issues = [];
    let page = 1, seen = 0;
    while (page <= 12) {                       // up to 3000 products
      const r = await fetch(`${origin}/products.json?limit=250&page=${page}`,
                            { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
      if (!r.ok) break;
      const j = await r.json();
      const items = j.products || [];
      if (!items.length) break;
      for (const p of items) {
        seen++;
        const url = `${origin}/products/${p.handle}`;
        if (!p.images || !p.images.length) issues.push({ handle: p.handle, title: p.title, issue: 'no_image', url });
        const vs = p.variants || [];
        if (!vs.length || vs.every(v => !+v.price)) issues.push({ handle: p.handle, title: p.title, issue: 'no_price', url });
        if (vs.length && vs.every(v => v.available === false))
          issues.push({ handle: p.handle, title: p.title, issue: 'out_of_stock',
                        detail: `${vs.length} variants, none available`, url });
        const missingImg = vs.filter(v => v.featured_image === null && (p.images || []).length > 1).length;
        if (missingImg && vs.length > 1)
          issues.push({ handle: p.handle, title: p.title, issue: 'variant_no_image',
                        detail: `${missingImg}/${vs.length} variants without an image`, url });
      }
      page++; await sleep(400);
    }
    if (issues.length) {
      for (let i = 0; i < issues.length; i += 400) await sbInsert('catalog_issues', issues.slice(i, i + 400));
    }
    console.log(`Catalog: ${seen} products scanned, ${issues.length} issues.`);
  } catch (e) { console.error('Catalog scan failed:', e.message); }
}

// ---- Top-brand benchmarking -------------------------------------------------
// "Is 2.2s good?" is unanswerable without the market. PageSpeed returns Chrome UX
// Report data for sites with enough traffic — real visitors on those brands, not a
// lab test — so this is a genuine competitive read rather than a synthetic one.
const BRANDS = [
  ['Lenskart',      'https://www.lenskart.com/',      'India'],
  ['Titan Eyeplus', 'https://www.titaneyeplus.com/',  'India'],
  ['John Jacobs',   'https://www.johnjacobs.com/',    'India'],
  ['Specsmakers',   'https://www.specsmakers.com/',   'India'],
  ['Eyewearlabs',   'https://eyewearlabs.com/',       'India'],
  ['Intellilens',   'https://intellilens.in/',        'India'],
  ['Ray-Ban',       'https://www.ray-ban.com/india',  'Global'],
  ['Oakley',        'https://www.oakley.com/en-in',   'Global'],
  ['Warby Parker',  'https://www.warbyparker.com/',   'Global'],
  ['Zenni Optical', 'https://www.zennioptical.com/',  'Global'],
  ['EyeBuyDirect',  'https://www.eyebuydirect.com/',  'Global'],
  ['GlassesUSA',    'https://www.glassesusa.com/',    'Global'],
  ['Sunglass Hut',  'https://www.sunglasshut.com/',   'Global'],
  ['Glasses.com',   'https://www.glasses.com/',       'Global']
];

async function benchmarkBrands() {
  // Once a day is plenty: CrUX only refreshes daily and each call is a real audit.
  try {
    const recent = await sbSelect('benchmarks', 'select=created_at&order=created_at.desc&limit=1');
    if (recent.length && Date.now() - +new Date(recent[0].created_at) < 20 * 3600 * 1000) {
      console.log('Benchmarks: already run today - skipping.');
      return;
    }
  } catch {}
  const rows = [];
  for (const [brand, url, region] of BRANDS) {
    try {
      const j = await psiRaw(url, 'mobile');
      const lab = (j.lighthouseResult && j.lighthouseResult.audits) || {};
      const crux = (j.loadingExperience && j.loadingExperience.metrics) || {};
      const score = j.lighthouseResult && j.lighthouseResult.categories
        && j.lighthouseResult.categories.performance
        && j.lighthouseResult.categories.performance.score;
      const totalBytes = lab['total-byte-weight'] && lab['total-byte-weight'].numericValue;
      const reqs = lab['network-requests'] && lab['network-requests'].details
        && lab['network-requests'].details.items && lab['network-requests'].details.items.length;
      const cls = crux['CUMULATIVE_LAYOUT_SHIFT_SCORE'];
      rows.push({
        brand, url, region, strategy: 'mobile',
        perf_score: score != null ? Math.round(score * 100) : null,
        lcp_field: crux['LARGEST_CONTENTFUL_PAINT_MS'] ? crux['LARGEST_CONTENTFUL_PAINT_MS'].percentile : null,
        inp_field: crux['INTERACTION_TO_NEXT_PAINT'] ? crux['INTERACTION_TO_NEXT_PAINT'].percentile : null,
        cls_field: cls ? cls.percentile / 100 : null,
        lcp_lab: lab['largest-contentful-paint'] ? Math.round(lab['largest-contentful-paint'].numericValue) : null,
        tbt_lab: lab['total-blocking-time'] ? Math.round(lab['total-blocking-time'].numericValue) : null,
        weight_kb: totalBytes ? Math.round(totalBytes / 1024) : null,
        requests: reqs || null
      });
      const last = rows[rows.length - 1];
      console.log('  bench', brand, 'score', last.perf_score, 'lcp', last.lcp_field);
    } catch (e) {
      console.error('  bench fail', brand, String(e.message).slice(0, 80));
    }
    await sleep(2500);                       // stay well inside the PSI quota
  }
  if (rows.length) await sbInsert('benchmarks', rows);
  console.log('Benchmarks: ' + rows.length + ' brands recorded.');
}

// Thin PSI call returning the raw payload (the existing psi() reshapes it).
async function psiRaw(url, strategy) {
  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', url);
  api.searchParams.set('strategy', strategy);
  api.searchParams.append('category', 'performance');
  if (PSI_KEY) api.searchParams.set('key', PSI_KEY);
  const r = await fetch(api, { signal: AbortSignal.timeout(90000) });
  const j = await r.json();
  if (j.error) throw new Error(String(j.error.message).slice(0, 90));
  return j;
}

// ---- Deploy detection -------------------------------------------------------
// Shopify fingerprints theme assets (theme.js?v=123456). A changed fingerprint
// means something shipped, which is the moment worth comparing metrics around.
async function detectDeploy(homepage) {
  try {
    const { text } = await timedGet(homepage);
    const matches = [...text.matchAll(/\/cdn\/shop\/t\/\d+\/assets\/[\w.-]+\?v=(\d+)/g)].map(x => x[1]);
    if (!matches.length) return;
    const version = matches.sort().slice(-1)[0];
    const seen = await sbSelect('deploys', 'select=id&version=eq.' + encodeURIComponent(version));
    if (seen.length) return;
    await sbInsert('deploys', [{ version, note: 'theme asset fingerprint changed' }]);
    console.log('Deploy detected:', version);
  } catch (e) { console.error('Deploy detection failed:', e.message); }
}

// ---- Alerts -----------------------------------------------------------------
// The rules live in SQL next to the data; this fires them and forwards anything
// new to a webhook if one is configured (Slack, Discord, or any service that turns
// a POST into a WhatsApp/email message).
async function runAlerts() {
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/alert_scan', { method: 'POST', headers: H, body: '{}' });
    const raised = r.ok ? Number(await r.text()) : 0;
    console.log('Alerts: ' + raised + ' raised.');
    if (!raised || !ALERT_WEBHOOK) return;
    const open = await sbSelect('alerts',
      'select=severity,title,detail,value&acknowledged=eq.false&order=created_at.desc&limit=5');
    if (!open.length) return;
    const lines = open.map(a => (a.severity === 'critical' ? 'CRITICAL' : 'WARNING') + ' - ' + a.title + ': ' + (a.detail || ''));
    await fetch(ALERT_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hashtag Eyewear monitor\n' + lines.join('\n') })
    }).catch(e => console.error('webhook:', e.message));
  } catch (e) { console.error('Alert scan failed:', e.message); }
}

// ---- PageSpeed Insights ----------------------------------------------------
async function psi(url, strategy) {
  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', url);
  api.searchParams.set('strategy', strategy);
  api.searchParams.append('category', 'performance');
  if (PSI_KEY) api.searchParams.set('key', PSI_KEY);
  const r = await fetch(api, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`PSI ${strategy} ${r.status}${r.status === 429 ? ' (rate limited — set the PSI_KEY secret)' : ''}`);
  const j = await r.json();
  // A 200 can still carry no audit: keyless quota exhaustion and Lighthouse
  // runtime errors both come back this way, which silently wrote NULL scores.
  if (j.error) throw new Error(`PSI ${strategy}: ${j.error.message}`);
  if (j.lighthouseResult?.runtimeError)
    throw new Error(`PSI ${strategy} runtime: ${j.lighthouseResult.runtimeError.code}`);
  if (j.lighthouseResult?.categories?.performance?.score == null)
    throw new Error(`PSI ${strategy}: no performance score returned (likely keyless quota — set PSI_KEY)`);
  const lab = j.lighthouseResult?.audits || {};
  const crux = j.loadingExperience?.metrics || {};
  const num = a => (lab[a]?.numericValue ?? null);
  const p75 = k => (crux[k]?.percentile ?? null);
  return {
    url, strategy,
    label: null,
    lcp_crux: p75('LARGEST_CONTENTFUL_PAINT_MS'),
    inp_crux: p75('INTERACTION_TO_NEXT_PAINT'),
    cls_crux: crux['CUMULATIVE_LAYOUT_SHIFT_SCORE'] ? crux['CUMULATIVE_LAYOUT_SHIFT_SCORE'].percentile / 100 : null,
    lcp_lab: num('largest-contentful-paint'),
    tbt_lab: num('total-blocking-time'),
    cls_lab: lab['cumulative-layout-shift']?.numericValue ?? null,
    perf_score: j.lighthouseResult?.categories?.performance?.score != null
      ? Math.round(j.lighthouseResult.categories.performance.score * 100) : null,
    run_type: RUN_TYPE,
    raw: { fetchedAt: new Date().toISOString() }
  };
}

// ---- lightweight fetch with timing + status --------------------------------
// Realistic browser headers + polite throttling + one retry on 429/503, so
// Shopify/Cloudflare don't rate-limit us into false failures.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function timedGet(url, opts = {}) {
  const doFetch = () => fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    signal: AbortSignal.timeout(20000),
    ...opts
  });
  const t0 = Date.now();
  let res = await doFetch();
  if ((res.status === 429 || res.status === 503)) { await sleep(2500); res = await doFetch(); } // one polite retry
  const ms = Date.now() - t0;
  const text = opts.method === 'HEAD' ? '' : await res.text().catch(() => '');
  await sleep(350); // space out requests so we don't trip rate limits
  return { status: res.status, ms, text, finalUrl: res.url };
}

function rate(ms, good, poor) { return ms <= good ? 'pass' : ms <= poor ? 'warn' : 'fail'; }
function origin(u) { try { return new URL(u).origin; } catch { return u; } }

// ---- probes ----------------------------------------------------------------
async function probeStatusSpeed(url, category) {
  try {
    const { status, ms } = await timedGet(url);
    const ok = status >= 200 && status < 400;
    return {
      category, item: category.includes('Performance') ? 'Ensure no heavy scripts breaking performance' : null,
      status: ok ? rate(ms, 2500, 5000) : 'fail',
      value: `${status} · ${ms}ms`, detail: url
    };
  } catch (e) { return { category, status: 'error', value: 'unreachable', detail: e.message }; }
}

async function probeSSL(url) {
  // Node https exposes the peer certificate -> compute days remaining.
  const https = await import('node:https');
  const { hostname } = new URL(url);
  return new Promise(resolve => {
    const req = https.request({ host: hostname, port: 443, method: 'HEAD', path: '/', timeout: 15000 },
      res => {
        const cert = res.socket.getPeerCertificate();
        if (!cert || !cert.valid_to) return resolve({ status: 'warn', value: 'no cert info', detail: hostname });
        const days = Math.round((new Date(cert.valid_to) - Date.now()) / 864e5);
        resolve({ status: days > 15 ? 'pass' : days > 0 ? 'warn' : 'fail', value: `${days} days left`, detail: `expires ${cert.valid_to}` });
        res.destroy();
      });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'error', value: 'timeout', detail: hostname }); });
    req.on('error', e => resolve({ status: 'error', value: 'ssl error', detail: e.message }));
    req.end();
  });
}

async function probeRobotsSitemap(url) {
  const base = origin(url);
  const out = [];
  for (const [name, path] of [['robots.txt', '/robots.txt'], ['sitemap.xml', '/sitemap.xml']]) {
    try { const { status } = await timedGet(base + path); out.push(`${name}:${status}`); }
    catch { out.push(`${name}:err`); }
  }
  const ok = out.every(s => s.endsWith(':200'));
  return { status: ok ? 'pass' : 'warn', value: out.join(' · '), detail: base };
}

async function probeMeta(url) {
  try {
    const { text } = await timedGet(url);
    const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || '';
    const desc = (text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
    const ok = title.length > 5 && desc.length > 20;
    return { status: ok ? 'pass' : 'warn', value: `title ${title.length}c · desc ${desc.length}c`, detail: title.slice(0, 80) };
  } catch (e) { return { status: 'error', value: 'fetch failed', detail: e.message }; }
}

async function probeCanonical(url) {
  try {
    const { text } = await timedGet(url);
    const has = /<link[^>]+rel=["']canonical["']/i.test(text);
    return { status: has ? 'pass' : 'warn', value: has ? 'canonical present' : 'missing', detail: url };
  } catch (e) { return { status: 'error', value: 'fetch failed', detail: e.message }; }
}

async function probeSchema(url) {
  try {
    const { text } = await timedGet(url);
    const has = /application\/ld\+json/i.test(text);
    const types = [...text.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map(m => m[1]);
    return { status: has ? 'pass' : 'warn', value: has ? [...new Set(types)].slice(0, 4).join(', ') || 'JSON-LD' : 'none', detail: url };
  } catch (e) { return { status: 'error', value: 'fetch failed', detail: e.message }; }
}

async function probePolicyPages(url) {
  const base = origin(url);
  const paths = ['/policies/privacy-policy', '/policies/terms-of-service', '/policies/refund-policy'];
  const res = [];
  for (const p of paths) { try { const { status } = await timedGet(base + p); res.push(status); } catch { res.push(0); } }
  const ok = res.filter(s => s === 200).length;
  return { status: ok === 3 ? 'pass' : ok > 0 ? 'warn' : 'fail', value: `${ok}/3 pages`, detail: res.join(',') };
}

async function probeBrokenLinks(url) {
  try {
    const { text } = await timedGet(url);
    const base = origin(url);
    const hrefs = [...text.matchAll(/href=["'](\/[^"'#?]+)["']/g)].map(m => base + m[1]);
    const sample = [...new Set(hrefs)].slice(0, 12);
    let broken = 0;
    for (const h of sample) {
      try { const { status } = await timedGet(h, { method: 'HEAD' }); if (status >= 400) broken++; }
      catch { broken++; }
    }
    return { status: broken === 0 ? 'pass' : broken <= 2 ? 'warn' : 'fail', value: `${broken}/${sample.length} broken`, detail: url };
  } catch (e) { return { status: 'error', value: 'fetch failed', detail: e.message }; }
}

async function probeViewportMeta(url) {
  try {
    const { text } = await timedGet(url);
    const has = /<meta[^>]+name=["']viewport["']/i.test(text);
    return { status: has ? 'pass' : 'fail', value: has ? 'viewport meta present' : 'missing viewport meta', detail: url };
  } catch (e) { return { status: 'error', value: 'fetch failed', detail: e.message }; }
}
async function probeImgAlt(url) {
  try {
    const { text } = await timedGet(url);
    const imgs = [...text.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
    if (!imgs.length) return { status: 'warn', value: 'no <img> found', detail: url };
    const withAlt = imgs.filter(t => /\balt\s*=\s*["'][^"']+["']/i.test(t)).length;
    const pct = Math.round(withAlt / imgs.length * 100);
    return { status: pct >= 90 ? 'pass' : pct >= 60 ? 'warn' : 'fail', value: `${withAlt}/${imgs.length} imgs have alt (${pct}%)`, detail: url };
  } catch (e) { return { status: 'error', value: 'fetch failed', detail: e.message }; }
}
async function probeLazyLoad(url) {
  try {
    const { text } = await timedGet(url);
    const lazy = (text.match(/loading\s*=\s*["']lazy["']/gi) || []).length;
    const imgs = (text.match(/<img\b/gi) || []).length;
    return { status: lazy > 0 ? 'pass' : 'warn', value: `${lazy} lazy of ${imgs} imgs`, detail: url };
  } catch (e) { return { status: 'error', value: 'fetch failed', detail: e.message }; }
}
async function probeScriptBloat(url) {
  try {
    const { text } = await timedGet(url);
    const ext = [...text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
    const base = origin(url);
    const third = ext.filter(s => { try { const o = new URL(s, base).origin; return o !== base && !/shopify|shopifycdn|myshopify/.test(o); } catch { return false; } }).length;
    return { status: third <= 12 ? 'pass' : third <= 20 ? 'warn' : 'fail', value: `${ext.length} scripts · ${third} third-party`, detail: url };
  } catch (e) { return { status: 'error', value: 'fetch failed', detail: e.message }; }
}
async function probeSearchPage(url, q) {
  const base = origin(url);
  try {
    const { status } = await timedGet(`${base}/search?q=${encodeURIComponent(q)}`);
    return { status: status >= 400 ? 'fail' : 'pass', value: `search ${status}`, detail: `q=${q}` };
  } catch (e) { return { status: 'error', value: 'fetch failed', detail: e.message }; }
}
async function probeImagesLoad(url) {
  try {
    const { text } = await timedGet(url);
    const base = origin(url);
    const srcs = [...text.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m => m[1]);
    const sample = [...new Set(srcs)].slice(0, 8).map(s => { try { return new URL(s, base).href; } catch { return null; } }).filter(Boolean);
    if (!sample.length) return { status: 'warn', value: 'no images found', detail: url };
    let bad = 0;
    for (const s of sample) { try { const { status } = await timedGet(s, { method: 'HEAD' }); if (status >= 400) bad++; } catch { bad++; } }
    return { status: bad === 0 ? 'pass' : bad <= 1 ? 'warn' : 'fail', value: `${sample.length - bad}/${sample.length} images load`, detail: url };
  } catch (e) { return { status: 'error', value: 'fetch failed', detail: e.message }; }
}
async function probeMarkup(url, patterns, okMsg, missMsg) {
  try {
    const { text } = await timedGet(url);
    const found = patterns.some(p => new RegExp(p, 'i').test(text));
    return { status: found ? 'pass' : 'warn', value: found ? okMsg : missMsg, detail: url };
  } catch (e) { return { status: 'error', value: 'fetch failed', detail: e.message }; }
}

// ---- map auto_key -> probe (site-wide probes run once against homepage) -----
async function runAuto(key, monitor, homepage) {
  const u = monitor.url;
  switch (key) {
    case 'load_speed':      return probeStatusSpeed(u, monitor.label);
    case 'http_status':     return probeStatusSpeed(u, monitor.label);
    case 'ssl':             return probeSSL(homepage);
    case 'robots_sitemap':  return probeRobotsSitemap(homepage);
    case 'meta':            return probeMeta(u);
    case 'canonical':       return probeCanonical(u);
    case 'schema':          return probeSchema(u);
    case 'policy_pages':    return probePolicyPages(homepage);
    case 'broken_links':    return probeBrokenLinks(homepage);
    case 'viewport_meta':   return probeViewportMeta(u);
    case 'img_alt':         return probeImgAlt(u);
    case 'lazyload':        return probeLazyLoad(u);
    case 'script_bloat':    return probeScriptBloat(u);
    case 'images_load':     return probeImagesLoad(u);
    case 'search_page':     return probeSearchPage(homepage, 'sunglasses');
    case 'search_noresults':return probeSearchPage(homepage, 'zzxqveryunlikely123');
    case 'wishlist_app':    return probeMarkup(homepage, ['wishlist', 'swym', 'wishlisthero', 'wishlist-hero'], 'wishlist markup found', 'no wishlist markup');
    case 'review_app':      return probeMarkup(u, ['judge\\.me', 'yotpo', 'loox', 'stamped', 'okendo', 'reviewsio', 'jdgm'], 'review app found', 'no review markup');
    case 'cookie_consent':  return probeMarkup(homepage, ['cookieyes', 'cookiebot', 'consent', 'gdpr', 'cookie-banner', 'cookie-consent'], 'consent banner found', 'no consent markup');
    case 'cwv':             return null; // handled by PSI directly
    default:                return null;
  }
}

// ---- main ------------------------------------------------------------------
(async () => {
  const monitors = await sbSelect('monitors', 'active=eq.true&select=*');
  if (!monitors.length) { console.log('No active monitors.'); return; }
  const homepage = (monitors.find(m => /\/$/.test(m.url)) || monitors[0]).url;
  const items = await sbSelect('task_items', 'check_type=eq.auto&select=*');

  // 0) Google Analytics: sessions / users / purchases / revenue -> ga_daily
  await pullGA();

  // 0b) Shopify: the complete, reliable order feed -> shop_orders
  await pullShopify();

  // 0b2) Link orders to browsing journeys. The cart stamp rarely survives this
  //      store's checkout, so fall back to the session that clicked checkout just
  //      before the order (marked as inferred in the DB).
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/link_orders_by_intent`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ p_from: new Date(Date.now() - 3 * 864e5).toISOString(), p_to: new Date().toISOString() })
    });
    console.log(r.ok ? `Order linking: ${await r.text()} newly linked.` : `Order linking: ${r.status} ${(await r.text()).slice(0,120)}`);
  } catch (e) { console.error('Order linking failed:', e.message); }

  // 0c) Refresh the daily RUM rollup (today + yesterday). The dashboard reads
  //     these pre-aggregated rows instead of scanning ~250k raw events, which is
  //     what keeps Summary/pivots fast as the table grows.
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/rum_rollup_refresh`, {
      method: 'POST', headers: H, body: JSON.stringify({ p_days: 2 })
    });
    console.log(r.ok ? `Rollup refreshed (${await r.text()} days).` : `Rollup refresh: ${r.status} ${(await r.text()).slice(0,150)}`);
  } catch (e) { console.error('Rollup refresh failed:', e.message); }

  // 0d) High-level monitoring: per-vendor budget and whole-catalog integrity
  await scanVendors(homepage);
  await scanCatalog(origin(homepage));

  // 0e) Market benchmark, deploy detection
  await benchmarkBrands();
  await detectDeploy(homepage);

  // 1) PageSpeed for every monitor, mobile + desktop
  const psiRows = [];
  for (const mon of monitors) {
    for (const strat of ['mobile', 'desktop']) {
      try { const row = await psi(mon.url, strat); row.label = mon.label; psiRows.push(row); console.log('PSI', strat, mon.label, row.perf_score); }
      catch (e) { console.error('PSI fail', mon.label, strat, e.message); }
    }
  }
  if (psiRows.length) await sbInsert('psi_results', psiRows);

  // 1b) Cache per-device page thumbnails into the monitors row (data URIs) so the
  //     dashboard loads them instantly instead of generating on-demand each visit.
  for (const mon of monitors) {
    try {
      const [shotM, shotD] = [await captureShot(mon.url, 400, 200), await captureShot(mon.url, 1280, 300)];
      const patch = {};
      if (shotM) patch.screenshot_mobile = shotM;
      if (shotD) patch.screenshot_desktop = shotD;
      if (Object.keys(patch).length) { await sbPatch('monitors', 'id', mon.id, patch); console.log('shot', mon.label, Object.keys(patch).join('+')); }
    } catch (e) { console.error('shot fail', mon.label, e.message); }
  }

  // 2) Auto task checks. Site-wide probes (ssl/robots/policy/broken_links) run
  //    once; page-level probes (speed/meta/canonical/schema) run per relevant page.
  const siteWide = new Set(['ssl', 'robots_sitemap', 'policy_pages', 'broken_links']);
  const checkRows = [];
  const doneSiteWide = new Set();

  for (const it of items) {
    if (it.auto_key === 'cwv') {
      // summarise PSI into a task_check
      const worst = psiRows.map(r => r.perf_score).filter(x => x != null).sort((a, b) => a - b)[0];
      checkRows.push({ category: it.category, item: it.item, url: homepage,
        status: worst == null ? 'error' : worst >= 90 ? 'pass' : worst >= 50 ? 'warn' : 'fail',
        value: worst == null ? 'no data' : `worst perf ${worst}`, detail: 'PageSpeed', run_type: RUN_TYPE });
      continue;
    }
    const monitor = pickMonitor(it, monitors);
    if (siteWide.has(it.auto_key)) {
      if (doneSiteWide.has(it.auto_key)) {
        const prev = checkRows.find(c => c._k === it.auto_key);
        checkRows.push({ ...prev, category: it.category, item: it.item });
        continue;
      }
      doneSiteWide.add(it.auto_key);
    }
    try {
      const r = await runAuto(it.auto_key, monitor, homepage);
      if (r) checkRows.push({ category: it.category, item: it.item, url: monitor.url,
        status: r.status, value: r.value, detail: r.detail, run_type: RUN_TYPE, _k: it.auto_key });
    } catch (e) { checkRows.push({ category: it.category, item: it.item, url: monitor.url, status: 'error', value: e.message, run_type: RUN_TYPE }); }
  }
  checkRows.forEach(r => delete r._k);
  if (checkRows.length) await sbInsert('task_checks', checkRows);
  // Alerts run last so they can see everything this run collected.
  await runAlerts();
  console.log(`Done. ${psiRows.length} PSI rows, ${checkRows.length} task checks.`);
})().catch(e => { console.error(e); process.exit(1); });

// choose which monitored page a page-level check should target
function pickMonitor(item, monitors) {
  const cat = item.category.toLowerCase();
  const find = kw => monitors.find(m => (m.label + ' ' + m.url).toLowerCase().includes(kw));
  if (cat.includes('product'))   return find('product')   || monitors[0];
  if (cat.includes('collection'))return find('collection')|| find('sunglass') || monitors[0];
  if (cat.includes('cart'))      return find('cart')      || monitors[0];
  return monitors.find(m => /\/$/.test(m.url)) || monitors[0];
}
