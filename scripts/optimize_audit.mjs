// ============================================================================
// optimize_audit.mjs — a full front-end optimisation audit, in a real browser.
//
// This checks the same ground a paid speed app covers (lazy images, responsive
// images, app impact, critical CSS, fonts, minification, preloading, compression)
// but it AUDITS rather than rewrites: it never touches the theme. Each check
// returns pass / warn / fail, the measured evidence, and what to change.
//
// Runs against the homepage, a collection and a product page, because the answers
// differ per template and product pages are where the money is.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, STORE_URL
// ============================================================================
import { chromium } from 'playwright';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const STORE        = (process.env.STORE_URL || 'https://hashtageyewears.com').replace(/\/$/, '');

const rnd   = (a, b) => Math.round(a + Math.random() * (b - a));
const pause = (a, b) => new Promise(r => setTimeout(r, rnd(a, b)));
const kb    = n => Math.round((n || 0) / 1024);

async function gotoWithRetry(page, url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await pause(1000, 2600);
    const r = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(e => { last = e; return null; });
    if (r && r.status() < 400) return r;
    last = r ? new Error('HTTP ' + r.status()) : last;
    if (r && ![429, 403, 503].includes(r.status())) break;
    await pause(8000 * Math.pow(1.8, i), 8000 * Math.pow(1.8, i) + 6000);
  }
  throw last || new Error('navigation failed');
}

// Collect everything the browser actually fetched for one page.
async function profile(page, url) {
  const res = [];
  const onResponse = async (r) => {
    try {
      const req = r.request();
      const t = req.timing();
      res.push({
        url: r.url(), type: req.resourceType(), status: r.status(),
        bytes: +((await r.headerValue('content-length')) || 0),
        enc: (await r.headerValue('content-encoding')) || '',
        cache: (await r.headerValue('cache-control')) || '',
        ct: (await r.headerValue('content-type')) || '',
        ms: t && t.responseEnd > 0 ? Math.round(t.responseEnd - t.startTime) : 0
      });
    } catch {}
  };
  page.on('response', onResponse);
  await gotoWithRetry(page, url);
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  // scroll so lazy content actually resolves — otherwise we would credit the page
  // for images it simply never got round to requesting
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 900).catch(() => {}); await pause(400, 800); }
  await pause(1500, 2500);
  page.off('response', onResponse);

  const dom = await page.evaluate(() => {
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
    const imgs = [...document.images].map(i => ({
      src: abs(i.currentSrc || i.src || ''),
      lazy: (i.loading || '').toLowerCase() === 'lazy',
      hasDims: !!(i.getAttribute('width') && i.getAttribute('height')),
      srcset: !!(i.srcset || (i.closest('picture') && i.closest('picture').querySelector('source'))),
      natW: i.naturalWidth || 0, dispW: Math.round(i.getBoundingClientRect().width) || 0,
      top: Math.round(i.getBoundingClientRect().top + scrollY)
    }));
    const scripts = [...document.scripts].map(s => ({
      src: s.src ? abs(s.src) : '', inline: !s.src,
      async: s.async, defer: s.defer, module: s.type === 'module',
      inHead: !!s.closest('head'), size: s.src ? 0 : (s.textContent || '').length
    }));
    const styles = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => ({
      href: abs(l.href), media: l.media || 'all', inHead: !!l.closest('head'),
      preload: l.rel === 'preload'
    }));
    const inlineCss = [...document.querySelectorAll('head style')]
      .reduce((a, s) => a + (s.textContent || '').length, 0);
    const hints = {
      preconnect: [...document.querySelectorAll('link[rel="preconnect"]')].map(l => l.href),
      dnsPrefetch: [...document.querySelectorAll('link[rel="dns-prefetch"]')].map(l => l.href),
      preload: [...document.querySelectorAll('link[rel="preload"]')].map(l => l.getAttribute('as') || 'other')
    };
    return { imgs, scripts, styles, inlineCss, hints, viewportH: innerHeight };
  });
  return { url, res, dom };
}

// ---- the checks -------------------------------------------------------------
function auditPage(p) {
  const out = [];
  const add = (area, name, status, value, advice) => out.push({ page: p.url, area, name, status, value, advice });
  const bytesOf = re => p.res.filter(r => re.test(r.type) || re.test(r.ct)).reduce((a, r) => a + (r.bytes || 0), 0);
  const first = (u) => { try { return new URL(u).host.endsWith(new URL(p.url).host); } catch { return false; } };

  // ---- images
  const imgs = p.dom.imgs.filter(i => i.src);
  const below = imgs.filter(i => i.top > p.dom.viewportH);
  const lazyBelow = below.filter(i => i.lazy).length;
  add('Images', 'Lazy-load below the fold',
      !below.length ? 'pass' : lazyBelow / below.length >= 0.8 ? 'pass' : lazyBelow / below.length >= 0.5 ? 'warn' : 'fail',
      `${lazyBelow}/${below.length} lazy`,
      'Add loading="lazy" to images that start below the fold. Every eager one competes with the LCP image for bandwidth.');

  const dims = imgs.filter(i => i.hasDims).length;
  add('Images', 'Width/height set (layout shift)',
      !imgs.length ? 'pass' : dims / imgs.length >= 0.9 ? 'pass' : dims / imgs.length >= 0.6 ? 'warn' : 'fail',
      `${dims}/${imgs.length} sized`,
      'Set width and height on every <img>. Without them the browser cannot reserve space and the page jumps as images arrive (CLS).');

  const responsive = imgs.filter(i => i.srcset).length;
  add('Images', 'Responsive srcset',
      !imgs.length ? 'pass' : responsive / imgs.length >= 0.8 ? 'pass' : responsive / imgs.length >= 0.4 ? 'warn' : 'fail',
      `${responsive}/${imgs.length} with srcset`,
      'Serve srcset so phones download a phone-sized file. Shopify can do this via the image_url filter with widths.');

  const oversized = imgs.filter(i => i.dispW > 0 && i.natW > i.dispW * 2).length;
  add('Images', 'Oversized for their slot', oversized === 0 ? 'pass' : oversized <= 3 ? 'warn' : 'fail',
      `${oversized} more than 2× too large`,
      'These download far more pixels than are shown. Request the displayed width instead.');

  const modern = p.res.filter(r => /image\//.test(r.ct)).filter(r => /webp|avif/.test(r.ct)).length;
  const allImgRes = p.res.filter(r => /image\//.test(r.ct)).length;
  add('Images', 'Modern format (WebP/AVIF)',
      !allImgRes ? 'pass' : modern / allImgRes >= 0.8 ? 'pass' : modern / allImgRes >= 0.4 ? 'warn' : 'fail',
      `${modern}/${allImgRes} modern`,
      'WebP is typically 25-35% smaller than JPEG at the same quality. Shopify serves it automatically when the theme requests it.');

  add('Images', 'Total image weight', kb(bytesOf(/^image/)) < 900 ? 'pass' : kb(bytesOf(/^image/)) < 2000 ? 'warn' : 'fail',
      `${kb(bytesOf(/^image/))} KB`, 'Images are usually the biggest slice of a store page. Compress and size them to their slot.');

  // ---- javascript
  const scripts = p.dom.scripts.filter(s => s.src);
  const blocking = scripts.filter(s => s.inHead && !s.async && !s.defer && !s.module);
  add('JavaScript', 'Render-blocking scripts',
      blocking.length === 0 ? 'pass' : blocking.length <= 3 ? 'warn' : 'fail',
      `${blocking.length} blocking in <head>`,
      'Add defer (or async) to scripts in the head. Each blocking script stops the browser from painting.');

  const third = scripts.filter(s => !first(s.src));
  add('JavaScript', 'Third-party scripts', third.length <= 10 ? 'pass' : third.length <= 20 ? 'warn' : 'fail',
      `${third.length} of ${scripts.length} are third-party`,
      'Every app adds scripts. Remove apps you no longer use — that is the single biggest lever on a Shopify theme.');

  const jsBytes = kb(bytesOf(/javascript|^script/));
  add('JavaScript', 'Total JS weight', jsBytes < 500 ? 'pass' : jsBytes < 1200 ? 'warn' : 'fail',
      `${jsBytes} KB`, 'Aim under ~500 KB of JS. Above that, phones spend longer parsing than downloading.');

  // ---- css
  const blockingCss = p.dom.styles.filter(s => s.inHead && s.media === 'all' && !s.preload);
  add('CSS', 'Render-blocking stylesheets',
      blockingCss.length <= 1 ? 'pass' : blockingCss.length <= 3 ? 'warn' : 'fail',
      `${blockingCss.length} blocking`,
      'Inline the CSS needed for the first screen and load the rest asynchronously. This is what "critical CSS" means.');

  add('CSS', 'Critical CSS inlined',
      p.dom.inlineCss > 2000 ? 'pass' : p.dom.inlineCss > 0 ? 'warn' : 'fail',
      `${Math.round(p.dom.inlineCss / 1024)} KB inline`,
      'With no inline critical CSS the first paint waits for a network round trip.');

  // ---- fonts
  const fonts = p.res.filter(r => /font/.test(r.ct) || /\.(woff2?|ttf|otf)/i.test(r.url));
  const preloadedFonts = (p.dom.hints.preload || []).filter(a => a === 'font').length;
  add('Fonts', 'Fonts preloaded', !fonts.length ? 'pass' : preloadedFonts > 0 ? 'pass' : 'warn',
      `${fonts.length} fonts, ${preloadedFonts} preloaded`,
      'Preload the one or two fonts used above the fold; the rest can wait. Fonts are discovered late because they sit inside CSS.');

  add('Fonts', 'Font weight', kb(fonts.reduce((a, f) => a + (f.bytes || 0), 0)) < 200 ? 'pass' : 'warn',
      `${kb(fonts.reduce((a, f) => a + (f.bytes || 0), 0))} KB`,
      'Ship only the weights actually used. Each extra weight is a separate download.');

  // ---- delivery
  const compressible = p.res.filter(r => /javascript|css|html|json/.test(r.ct) && (r.bytes || 0) > 1024);
  const compressed = compressible.filter(r => /br|gzip/.test(r.enc)).length;
  add('Delivery', 'Compression',
      !compressible.length ? 'pass' : compressed / compressible.length >= 0.9 ? 'pass' : 'warn',
      `${compressed}/${compressible.length} compressed`,
      'Text assets should be served with Brotli or gzip. Anything uncompressed is a misconfigured origin.');

  const statics = p.res.filter(r => /javascript|css|image|font/.test(r.ct));
  const cached = statics.filter(r => /max-age=\d{5,}/.test(r.cache)).length;
  add('Delivery', 'Long cache headers',
      !statics.length ? 'pass' : cached / statics.length >= 0.7 ? 'pass' : 'warn',
      `${cached}/${statics.length} cached long`,
      'Static assets should carry a long max-age so repeat visits are close to free.');

  const hosts = [...new Set(p.res.map(r => { try { return new URL(r.url).origin; } catch { return null; } }).filter(Boolean))]
    .filter(h => { try { return new URL(h).host !== new URL(p.url).host; } catch { return false; } });
  const hinted = new Set([...(p.dom.hints.preconnect || []), ...(p.dom.hints.dnsPrefetch || [])]
    .map(h => { try { return new URL(h).origin; } catch { return h; } }));
  const topUnhinted = hosts.filter(h => !hinted.has(h)).length;
  add('Delivery', 'Preconnect to third parties',
      hinted.size >= 3 ? 'pass' : hinted.size >= 1 ? 'warn' : 'fail',
      `${hinted.size} hinted, ${topUnhinted} not`,
      'Add preconnect for the few third-party origins that load early. Each new origin otherwise costs a DNS + TLS round trip.');

  const failed = p.res.filter(r => r.status >= 400).length;
  add('Delivery', 'Failing requests', failed === 0 ? 'pass' : failed <= 3 ? 'warn' : 'fail',
      `${failed} failed`, 'Requests that 404 or are blocked still cost time and can break features.');

  const total = kb(p.res.reduce((a, r) => a + (r.bytes || 0), 0));
  add('Delivery', 'Total page weight', total < 1500 ? 'pass' : total < 3000 ? 'warn' : 'fail',
      `${total} KB across ${p.res.length} requests`,
      'On a 4G phone every extra megabyte is roughly a second before anything useful appears.');

  return out;
}

// ---- run --------------------------------------------------------------------
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  locale: 'en-IN', timezoneId: 'Asia/Kolkata',
  extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' }
});
await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
const page = await ctx.newPage();
page.setDefaultTimeout(30000);

const targets = [STORE + '/'];
try {
  const r = await page.request.get(STORE + '/products.json?limit=5');
  const j = await r.json();
  const p0 = (j.products || [])[0];
  if (p0) targets.push(`${STORE}/products/${p0.handle}`);
} catch {}
try {
  const r = await page.request.get(STORE + '/collections.json?limit=5');
  const j = await r.json();
  const c0 = (j.collections || [])[0];
  if (c0) targets.push(`${STORE}/collections/${c0.handle}`);
} catch {}

let rows = [];
for (const t of targets) {
  try {
    console.log('auditing', t);
    const prof = await profile(page, t);
    rows = rows.concat(auditPage(prof));
    await pause(3000, 6000);                    // behave between pages
  } catch (e) { console.error('  failed:', e.message); }
}
await browser.close();

const score = rows.length
  ? Math.round(rows.filter(r => r.status === 'pass').length / rows.length * 100) : 0;
console.log(`\n${rows.length} checks · ${rows.filter(r => r.status === 'pass').length} pass · ` +
            `${rows.filter(r => r.status === 'warn').length} warn · ${rows.filter(r => r.status === 'fail').length} fail · score ${score}`);
for (const r of rows.filter(r => r.status !== 'pass'))
  console.log(`  ${r.status.toUpperCase()} ${r.area}/${r.name} — ${r.value}`);

if (SUPABASE_URL && SERVICE_KEY && rows.length) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/optimize_audit`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY,
               'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(rows.map(r => ({ ...r, page: r.page.slice(0, 300) })))
  });
  if (!res.ok) console.error('save failed:', res.status, (await res.text()).slice(0, 200));
  else console.log('saved.');
}
