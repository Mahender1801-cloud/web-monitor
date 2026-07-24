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
const SHOPIFY_STORE  = process.env.SHOPIFY_STORE || '';   // e.g. c6c623-3.myshopify.com
const SHOPIFY_TOKEN  = process.env.SHOPIFY_TOKEN || '';   // Admin API access token (read_orders)
const SHOPIFY_BACKFILL_DAYS = +(process.env.SHOPIFY_BACKFILL_DAYS || 0); // one-time deep pull

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
// order server-side, cursor-paginated, and upserts into shop_orders. Incremental
// by default (only orders newer than the latest we have, with a small overlap so
// nothing slips through); set SHOPIFY_BACKFILL_DAYS once for a deep historical pull.
async function pullShopify() {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) { console.log('Shopify not configured (SHOPIFY_STORE / SHOPIFY_TOKEN) — skipping.'); return; }
  const API = '2024-10';
  const base = `https://${SHOPIFY_STORE}/admin/api/${API}`;
  const shH = { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' };

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

  const first = new URL(`${base}/orders.json`);
  first.searchParams.set('status', 'any');
  first.searchParams.set('limit', '250');
  first.searchParams.set('created_at_min', sinceISO);
  first.searchParams.set('fields', 'id,name,created_at,processed_at,current_total_price,total_price,currency,financial_status,line_items,landing_site,referring_site,source_name');

  let url = first.toString(), pages = 0, total = 0;
  try {
    while (url && pages < 200) {
      const r = await fetch(url, { headers: shH, signal: AbortSignal.timeout(60000) });
      if (r.status === 429) { await sleep(2500); continue; }        // throttled — wait and retry same url
      if (!r.ok) { console.error('Shopify orders', r.status, (await r.text()).slice(0, 200)); break; }
      const j = await r.json();
      const orders = j.orders || [];
      if (orders.length) {
        const rows = orders.map(o => ({
          id: o.id,
          order_number: o.name,
          created_at: o.created_at,
          processed_at: o.processed_at,
          total_price: +(o.current_total_price ?? o.total_price ?? 0),
          currency: o.currency,
          items: (o.line_items || []).reduce((a, li) => a + (+li.quantity || 0), 0),
          financial_status: o.financial_status,
          landing_site: (o.landing_site || '').split('?')[0].slice(0, 300),
          referring_site: (o.referring_site || '').slice(0, 300),
          source_name: o.source_name,
          raw: { fetchedAt: new Date().toISOString() }
        }));
        await sbUpsert('shop_orders', rows, 'id');
        total += rows.length;
      }
      pages++;
      // cursor pagination: follow the rel="next" Link header
      const link = r.headers.get('link') || '';
      const next = link.split(',').find(s => s.includes('rel="next"'));
      url = next ? next.slice(next.indexOf('<') + 1, next.indexOf('>')) : null;
      if (url) await sleep(600); // stay under 2 req/s
    }
    console.log(`Shopify: upserted ${total} orders across ${pages} page(s) since ${sinceISO.slice(0, 10)}.`);
  } catch (e) { console.error('Shopify pull failed:', e.message); }
}

// ---- PageSpeed Insights ----------------------------------------------------
async function psi(url, strategy) {
  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', url);
  api.searchParams.set('strategy', strategy);
  api.searchParams.append('category', 'performance');
  if (PSI_KEY) api.searchParams.set('key', PSI_KEY);
  const r = await fetch(api, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`PSI ${strategy} ${r.status}`);
  const j = await r.json();
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
