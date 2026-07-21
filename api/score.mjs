// ============================================================================
// Web Score — Vercel serverless function.  GET /api/score?url=https://site.com
//
// Scores any page WITHOUT the PageSpeed API and WITHOUT CORS problems (runs
// server-side on Vercel). It fetches the page + a sample of its assets and
// grades what a server can truly measure: response speed, page weight,
// render-blocking, compression, SEO and accessibility signals.
//
// Honest scope: it does NOT run a headless browser, so it cannot measure the
// painted Core Web Vitals (LCP/CLS/INP) — those need a real browser. Your OWN
// store's real LCP/INP/CLS already come from the RUM collector. Web Score is
// for grading/ comparing ANY url (incl. competitors) on server-visible signals.
// ============================================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function clamp(n){ return Math.max(0, Math.min(100, Math.round(n))); }
// piecewise: >=good -> 100, <=bad -> 0, linear between
function grade(v, good, bad){ if(v==null) return null; if(v<=good) return 100; if(v>=bad) return 0; return clamp(100*(bad-v)/(bad-good)); }

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
  'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1'
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function timedFetch(url, opts={}){
  const t0 = Date.now();
  const r = await fetch(url, { redirect:'follow', headers:HEADERS, signal:AbortSignal.timeout(20000), ...opts });
  const ttfb = Date.now() - t0;                 // headers received
  const body = opts.method==='HEAD' ? '' : await r.text();
  const total = Date.now() - t0;                // full download
  return { status:r.status, ttfb, total, body, headers:r.headers, finalUrl:r.url };
}
// retry the page load on 5xx / transient errors so bot-protection blips don't 500 the score
async function fetchMain(url){
  let last;
  for(let i=0;i<3;i++){
    try{ const r = await timedFetch(url); last=r; if(r.status < 500) return r; }
    catch(e){ last={ error:e.message }; }
    await sleep(1200);
  }
  if(last && last.status!=null) return last;
  throw new Error(last?.error || 'unreachable');
}
// median TTFB over several light probes — one volatile sample was swinging the score
async function ttfbMedian(url, n=3){
  const s=[];
  // discarded warm-up: pays DNS + TLS handshake, which is a property of OUR cold
  // connection, not of the site being scored. Without this the first score is unfairly low.
  try{ await fetch(url,{method:'HEAD',headers:HEADERS,redirect:'follow',signal:AbortSignal.timeout(10000)}); }catch{}
  for(let i=0;i<n;i++){
    try{ const t0=Date.now(); await fetch(url,{method:'HEAD',headers:HEADERS,redirect:'follow',signal:AbortSignal.timeout(10000)}); s.push(Date.now()-t0); }
    catch{}
    await sleep(200);
  }
  s.sort((a,b)=>a-b);
  return s.length ? s[Math.floor(s.length/2)] : null;
}

async function analyze(url){
  const main = await fetchMain(url);
  if(main.status >= 400) throw new Error('Page returned HTTP ' + main.status);
  const html = main.body || '';
  const origin = new URL(main.finalUrl || url).origin;
  const enc = (main.headers.get('content-encoding') || '').toLowerCase();
  const htmlBytes = Buffer.byteLength(html, 'utf8');
  // stable server-response figure (warm-up discarded, median of 3) — see ttfbMedian
  const ttfbStable = await ttfbMedian(main.finalUrl || url);

  // ---- parse signals -------------------------------------------------------
  const head = (html.match(/<head[^>]*>([\s\S]*?)<\/head>/i) || [,''])[1];
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const imgAlt = imgs.filter(t => /\balt\s*=\s*["'][^"']+["']/i.test(t)).length;
  const imgDims = imgs.filter(t => /\bwidth\s*=/i.test(t) && /\bheight\s*=/i.test(t)).length;
  const lazy = (html.match(/loading\s*=\s*["']lazy["']/gi) || []).length;

  const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m=>m[1]);
  const styleHrefs = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)].map(m=>m[0]);
  const isThird = s => { try { const o = new URL(s, origin).origin; return o !== origin; } catch { return false; } };
  const thirdParty = scriptSrcs.filter(isThird).length;

  // render-blocking = sync scripts + stylesheets that appear inside <head>
  const headSyncScripts = [...head.matchAll(/<script\b(?![^>]*\b(async|defer|type=["']module["'])\b)[^>]*\bsrc=/gi)].length;
  const headStyles = [...head.matchAll(/<link[^>]+rel=["']stylesheet["']/gi)].length;
  const renderBlocking = headSyncScripts + headStyles;

  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [,''])[1].trim();
  const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [,''])[1];
  const hasCanonical = /<link[^>]+rel=["']canonical["']/i.test(html);
  const hasViewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const htmlLang = /<html[^>]+lang=/i.test(html);
  const hasCharset = /<meta[^>]+charset/i.test(head);
  const hasDoctype = /^\s*<!doctype html>/i.test(html);
  const isHttps = main.finalUrl.startsWith('https:');
  const jsonLd = /application\/ld\+json/i.test(html);

  // ---- sample real asset weight (first few CSS/JS/img), capped for speed ----
  const assets = [...new Set([...scriptSrcs, ...[...html.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)].map(m=>m[1]),
                              ...[...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(m=>m[1])])]
    .map(s => { try { return new URL(s, origin).href; } catch { return null; } }).filter(Boolean).slice(0, 14);
  let weight = htmlBytes, sampled = 0, sampledOK = 0;
  await Promise.all(assets.map(async a => {
    sampled++;
    try {
      const r = await fetch(a, { method:'HEAD', headers:{'User-Agent':UA}, signal: AbortSignal.timeout(8000) });
      const len = +r.headers.get('content-length');
      if(len) { weight += len; sampledOK++; }
    } catch {}
  }));

  // ---- sub-scores ----------------------------------------------------------
  // Weighting favours STRUCTURAL signals (weight / blocking / third-party), which are
  // a genuine property of the page and identical on every run, over NETWORK timing,
  // which varies with route and load. Timing-heavy weighting made the same page score
  // 14 then 67 then 19 minutes apart, which is useless for tracking a score over time.
  // Structural = 70%, timing = 30%.
  const ttfbUsed = ttfbStable ?? main.ttfb;
  const perf = clamp(
    0.30*grade(weight/1024, 500, 4000) +        // total sampled weight (KB)  — stable
    0.25*grade(renderBlocking, 1, 12) +         // render-blocking resources  — stable
    0.15*grade(thirdParty, 2, 20) +             // third-party scripts        — stable
    0.20*grade(ttfbUsed, 200, 1200) +           // server response (median)   — variable
    0.10*grade(main.total, 400, 3000)           // full HTML delivery         — variable
  );
  const seo = clamp(
    (title.length >= 10 && title.length <= 65 ? 30 : title.length ? 15 : 0) +
    (metaDesc.length >= 50 && metaDesc.length <= 165 ? 25 : metaDesc.length ? 12 : 0) +
    (hasCanonical ? 15 : 0) + (hasViewport ? 15 : 0) + (jsonLd ? 15 : 0)
  );
  const a11y = clamp(
    (imgs.length ? 55*(imgAlt/imgs.length) : 55) +
    (htmlLang ? 25 : 0) + (hasViewport ? 20 : 0)
  );
  const best = clamp(
    (isHttps ? 30 : 0) + ((enc==='gzip'||enc==='br') ? 25 : 0) +
    (hasDoctype ? 15 : 0) + (hasCharset ? 15 : 0) +
    (imgs.length ? 15*(imgDims/imgs.length) : 15)
  );
  const overall = clamp(0.5*perf + 0.2*seo + 0.15*a11y + 0.15*best);

  return {
    url: main.finalUrl, scoredAt: new Date().toISOString(),
    scores: { overall, performance: perf, seo, accessibility: a11y, bestPractices: best },
    metrics: {
      ttfb_ms: ttfbUsed, load_ms: main.total,
      html_kb: Math.round(htmlBytes/1024), weight_kb: Math.round(weight/1024),
      requests_sampled: sampled, compression: enc || 'none', https: isHttps,
      render_blocking: renderBlocking, third_party_scripts: thirdParty,
      images: imgs.length, images_with_alt: imgAlt, lazy_images: lazy,
      title_len: title.length, meta_desc_len: metaDesc.length,
      canonical: hasCanonical, viewport: hasViewport, schema: jsonLd, lang: htmlLang
    }
  };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  let url = (req.query.url || '').trim();
  if(!url) return res.status(400).json({ error: 'Missing ?url' });
  if(!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  try {
    const out = await analyze(url);
    res.status(200).json(out);
  } catch (e) {
    res.status(200).json({ error: e.message || 'Could not score this URL', url });
  }
}
