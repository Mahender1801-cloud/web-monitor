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

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const PSI_KEY       = process.env.PSI_KEY || '';
const RUN_TYPE      = process.env.RUN_TYPE || 'scheduled';

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
async function timedGet(url, opts = {}) {
  const t0 = Date.now();
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'HashtagMonitor/1.0' },
    signal: AbortSignal.timeout(20000),
    ...opts
  });
  const ms = Date.now() - t0;
  const text = opts.method === 'HEAD' ? '' : await res.text().catch(() => '');
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

  // 1) PageSpeed for every monitor, mobile + desktop
  const psiRows = [];
  for (const mon of monitors) {
    for (const strat of ['mobile', 'desktop']) {
      try { const row = await psi(mon.url, strat); row.label = mon.label; psiRows.push(row); console.log('PSI', strat, mon.label, row.perf_score); }
      catch (e) { console.error('PSI fail', mon.label, strat, e.message); }
    }
  }
  if (psiRows.length) await sbInsert('psi_results', psiRows);

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
