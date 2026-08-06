// ============================================================================
// qa_browser.mjs — the QA checks that a server-side probe could not do.
//
// check.mjs can only read HTML, so every task that depends on JavaScript or on
// layout stayed marked "manual": menus, filters, pagination, variant images, the
// cart drawer, discount codes, payment options, keyboard navigation. A real
// browser can do all of those. This runs them and writes the results into
// task_checks under the SAME category+item names the seed uses, so the QA tab,
// the sidebar dots and the generated reports pick them up with no other change.
//
// Two rules this file keeps:
//
//  1. It never claims more than it measured. Where a control can only be shown
//     to exist and respond — a discount code needs a real code to prove it
//     discounts — the result is a warn with the reason, not a green pass.
//  2. It never places an order and never types a real address into the live
//     checkout. It stops at the moment the checkout hands off. One task stays
//     manual for exactly that reason and says so.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, STORE_URL,
//      QA_DISCOUNT_CODE (optional), RUN_TYPE
// ============================================================================
import { chromium, firefox, webkit } from 'playwright';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const STORE        = (process.env.STORE_URL || 'https://hashtageyewears.com').replace(/\/$/, '');
const CODE         = process.env.QA_DISCOUNT_CODE || '';
const RUN_TYPE     = process.env.RUN_TYPE || 'scheduled';

const HOME = STORE + '/';
const rnd   = (a, b) => Math.round(a + Math.random() * (b - a));
const pause = (a, b) => new Promise(r => setTimeout(r, rnd(a, b)));
const rows  = [];

// A live site can be slow or start throttling, and every retry here is
// deliberately patient. Without a budget a bad day runs past the workflow
// timeout, the job is killed before the save at the end, and a whole run's
// results are lost. Past the deadline the remaining checks are recorded as
// skipped instead — a visible gap beats silently losing everything.
const BUDGET_MIN = +(process.env.QA_BUDGET_MIN || 18);
const DEADLINE = Date.now() + BUDGET_MIN * 60000;
const overBudget = () => Date.now() > DEADLINE;

// The contract with task_items: every check this run owns. Anything here that
// the run does not reach is written out as an explicit error at the end. A
// throttled page or a crash then shows as "did not run" on the dashboard rather
// than as a stale green tick from yesterday.
const EXPECTED = [
  ['Homepage Testing', 'Test mega menu and navigation links'],
  ['Homepage Testing', 'Verify homepage sections alignment'],
  ['Search Page Testing', 'Check search filters / sorting'],
  ['Collection Page Testing', 'Verify filters / sorting working properly'],
  ['Collection Page Testing', 'Check product cards alignment'],
  ['Collection Page Testing', 'Verify wishlist / cart buttons'],
  ['Collection Page Testing', 'Test pagination or infinite scroll'],
  ['Collection Page Testing', 'Check breadcrumb navigation'],
  ['Collection Page Testing', 'Verify "no products found" empty state'],
  ['Collection Page Testing', 'Check out-of-stock product display logic'],
  ['Product Page Testing', 'Check product images & variant images'],
  ['Product Page Testing', 'Verify Add to Cart & Buy Now buttons'],
  ['Product Page Testing', 'Test variant selection'],
  ['Product Page Testing', 'Ensure no broken layout on mobile'],
  ['Product Page Testing', 'Check breadcrumb navigation'],
  ['Product Page Testing', 'Verify stock/inventory status'],
  ['Product Page Testing', 'Check sale price / compare-at price display'],
  ['Product Page Testing', 'Verify related / upsell / cross-sell'],
  ['Product Page Testing', 'Test sticky Add to Cart on scroll (mobile)'],
  ['Cart & Checkout Testing', 'Add product to cart'],
  ['Cart & Checkout Testing', 'Verify corner cart / drawer cart working'],
  ['Cart & Checkout Testing', 'Update quantity / remove item'],
  ['Cart & Checkout Testing', 'Check empty cart state'],
  ['Cart & Checkout Testing', 'Check discount codes'],
  ['Cart & Checkout Testing', 'Verify payment methods visibility'],
  ['Cart & Checkout Testing', 'Test Partial COD / prepaid logic'],
  ['Cart & Checkout Testing', 'Check shipping cost calculation display'],
  ['Cart & Checkout Testing', 'Test Shiprocket checkout redirect'],
  ['Cart & Checkout Testing', 'Verify guest checkout option'],
  ['Cart & Checkout Testing', 'Test address & pincode serviceability'],
  ['Cross-Browser & Accessibility Testing', 'Check keyboard nav / screen reader basics'],
  ['Cross-Browser & Accessibility Testing', 'Test on Chrome / Safari / Firefox / Edge'],
];

function record(category, item, status, value, url) {
  rows.push({ category, item, status, value: String(value).slice(0, 400),
              url: url || STORE, detail: null, run_type: RUN_TYPE });
  console.log(`  ${status.toUpperCase().padEnd(6)} ${item} — ${value}`);
}

// True while the section's page is actually loaded. When a section's navigation
// fails, its checks are skipped rather than run against whatever page happened
// to still be on screen — a breadcrumb check against a throttling page reports
// a confident FAIL that is simply wrong, which is worse than a visible gap.
// Skipped checks are filled in as "did not run" by the reconciliation at the end.
let pageOK = true;

// Every check runs inside this so one broken selector cannot end the run.
async function step(category, item, fn) {
  if (!pageOK) return;
  if (overBudget()) return record(category, item, 'error',
    `skipped — the run hit its ${BUDGET_MIN}-minute budget before reaching this check`);
  try { await fn(); }
  catch (e) { record(category, item, 'error', (e.message || String(e)).slice(0, 140)); }
}

async function goto(page, url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await pause(2000, 4000);
    const r = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(e => { last = e; return null; });
    if (r && r.status() < 400) { await pause(700, 1400); return r; }
    last = r ? new Error('HTTP ' + r.status()) : last;
    if (r && ![429, 403, 503].includes(r.status())) break;
    await pause(9000 * (i + 1), 9000 * (i + 1) + 7000);
  }
  throw last || new Error('navigation failed');
}

// Section-entry navigation. Returns false instead of throwing: one page being
// throttled must not abort the whole run — the checks that page carried are
// reconciled into explicit errors at the end, and every other section still runs.
async function nav(page, url) {
  try { await goto(page, url); pageOK = true; return true; }
  catch (e) {
    pageOK = false;
    console.log(`  (could not open ${url}: ${(e.message || '').slice(0, 60)} — skipping its checks)`);
    return false;
  }
}

const seen = async (loc) => { try { return (await loc.count()) > 0 && await loc.first().isVisible(); } catch { return false; } };

// This theme renders the drawer cart and the cart page from the same partial, so
// the first DOM match of any cart selector is usually the hidden drawer copy.
// Acting on it silently does nothing and the check reports a failure that is not
// real. Always reach for the first match a shopper could actually touch.
async function firstVisible(loc, max = 10) {
  const n = Math.min(await loc.count().catch(() => 0), max);
  for (let i = 0; i < n; i++) {
    const c = loc.nth(i);
    if (await c.isVisible().catch(() => false)) return c;
  }
  return null;
}
const nProducts = (page) => page.locator('a[href*="/products/"]').count();
const text = async (page) => (await page.locator('body').innerText().catch(() => '')) || '';

// Elements wider than the viewport are the usual cause of a page that scrolls
// sideways on a phone. Reported by selector so it is actionable, not just a flag.
const overflowers = (page) => page.evaluate(() => {
  const w = document.documentElement.clientWidth, bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > w + 2 || r.left < -2) {
      const s = el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        (el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
      if (!bad.includes(s)) bad.push(s);
    }
    if (bad.length > 6) break;
  }
  return { docWidth: document.documentElement.scrollWidth, viewport: w, bad };
});

const breadcrumb = async (page) => {
  const vis = await page.locator('nav[aria-label*="readcrumb" i], [class*="breadcrumb" i], [id*="breadcrumb" i]').count();
  const ld  = await page.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')]
                 .some(s => /BreadcrumbList/.test(s.textContent || ''))).catch(() => false);
  return { vis, ld };
};

const cartCount = async (page) => {
  try { const r = await page.request.get(STORE + '/cart.js'); return (await r.json()).item_count || 0; }
  catch { return -1; }
};

// ---------------------------------------------------------------------------
async function main() {
  // Catalogue facts, so the page is checked against the truth rather than
  // against another part of the page.
  let products = [], collHandle = 'all';
  try {
    const r = await fetch(STORE + '/products.json?limit=250');
    products = (await r.json()).products || [];
  } catch {}
  try {
    const r = await fetch(STORE + '/collections.json?limit=30');
    const c = ((await r.json()).collections || []).filter(x => (x.products_count || 0) > 12)
                .sort((a, b) => b.products_count - a.products_count)[0];
    if (c) collHandle = c.handle;
  } catch {}
  console.log(`catalogue: ${products.length} products · collection: ${collHandle}`);

  const pick = (f) => products.find(f);
  // Prefer a product that can actually exercise the variant checks. If the
  // catalogue has none, that is a fact about the shop, not a fault in the page,
  // and the checks below say so instead of reporting a missing control.
  const multiVariant = products.some(p => (p.variants || []).length > 1);
  const richProd = pick(p => (p.variants || []).length > 1 && (p.images || []).length > 1)
                || pick(p => (p.variants || []).length > 1)
                || pick(p => (p.images || []).length > 1)
                || products[0];
  const saleProd = pick(p => (p.variants || []).some(v => v.compare_at_price && +v.compare_at_price > +v.price));
  const oosProd  = pick(p => (p.variants || []).length && (p.variants || []).every(v => v.available === false));
  const inStock  = pick(p => (p.variants || []).some(v => v.available)) || richProd;

  const collUrl = `${STORE}/collections/${collHandle}`;
  const prodUrl = richProd ? `${STORE}/products/${richProd.handle}` : null;

  // PW_CHANNEL lets a local run borrow the installed Chrome instead of waiting
  // on Playwright's own 200 MB download. CI leaves it unset and uses the
  // bundled Chromium, which is the build the results should come from.
  const browser = await chromium.launch({
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    locale: 'en-IN', timezoneId: 'Asia/Kolkata',
    extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' }
  });
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  // ======================= HOMEPAGE ========================================
  console.log('\nHomepage');
  await nav(page, HOME);

  await step('Homepage Testing', 'Test mega menu and navigation links', async () => {
    const cat = 'Homepage Testing', item = 'Test mega menu and navigation links';
    const burger = page.locator('[class*="menu-toggle" i], [class*="hamburger" i], button[aria-label*="menu" i], [class*="nav-toggle" i], summary[aria-label*="menu" i]').first();
    let opened = false;
    if (await seen(burger)) { await burger.click({ force: true }).catch(() => {}); await pause(1200, 2200); opened = true; }
    // expand collapsed submenus so nested links are counted too
    const subs = page.locator('nav summary, nav [aria-expanded="false"]');
    for (let i = 0; i < Math.min(await subs.count(), 4); i++) {
      await subs.nth(i).click({ force: true }).catch(() => {});
      await pause(300, 600);
    }

    const hrefs = await page.evaluate(() => [...document.querySelectorAll('header a[href], nav a[href]')]
      .map(a => a.getAttribute('href')).filter(Boolean));
    const urls = [...new Set(hrefs)]
      .filter(h => !/^(#|mailto:|tel:|javascript:)/i.test(h))
      .map(h => { try { return new URL(h, HOME).toString(); } catch { return null; } })
      .filter(u => u && u.startsWith(STORE))
      .slice(0, 8);

    if (!urls.length) return record(cat, item, 'fail',
      opened ? 'menu opened but it contains no links' : 'no navigation links found in header or nav', HOME);

    const broken = [];
    for (const u of urls) {
      const r = await page.request.get(u, { maxRedirects: 5 }).catch(() => null);
      if (!r || r.status() >= 400) broken.push(`${u.replace(STORE, '')} ${r ? r.status() : 'no response'}`);
      await pause(250, 550);
    }
    record(cat, item, broken.length ? 'fail' : 'pass',
      broken.length ? `${broken.length} of ${urls.length} nav links broken: ${broken.slice(0, 3).join(', ')}`
                    : `${urls.length} nav links checked${opened ? ' (menu opened first)' : ''}, all responded OK`, HOME);
  });

  await step('Homepage Testing', 'Verify homepage sections alignment', async () => {
    const cat = 'Homepage Testing', item = 'Verify homepage sections alignment';
    const o = await overflowers(page);
    const empty = await page.evaluate(() => [...document.querySelectorAll('section, [class*="section" i]')]
      .filter(s => s.getBoundingClientRect().height < 4 && s.children.length > 0).length);
    const side = o.docWidth > o.viewport + 2;
    record(cat, item, side ? 'fail' : (empty ? 'warn' : 'pass'),
      side ? `page is ${o.docWidth}px wide in a ${o.viewport}px viewport — sideways scroll caused by ${o.bad.slice(0, 3).join(', ')}`
      : empty ? `no sideways scroll, but ${empty} section(s) render at zero height`
              : `no sideways scroll at ${o.viewport}px and no collapsed sections`, HOME);
  });

  // ======================= SEARCH ==========================================
  console.log('\nSearch');
  await step('Search Page Testing', 'Check search filters / sorting', async () => {
    const cat = 'Search Page Testing', item = 'Check search filters / sorting';
    const url = `${STORE}/search?q=sunglasses`;
    await goto(page, url);
    const before = await nProducts(page);
    const sort = page.locator('select[name="sort_by"], select#SortBy, [name="sort_by"]').first();
    const filt = page.locator('[class*="filter" i] input, [class*="facet" i] input').first();
    if (await seen(sort)) {
      const n = await sort.locator('option').count();
      if (n > 1) { await sort.selectOption({ index: 1 }).catch(() => {}); await pause(2500, 4000); }
      const after = await nProducts(page);
      record(cat, item, after > 0 ? 'pass' : 'fail',
        `sort control with ${n} options · ${before} → ${after} results after sorting`, url);
    } else if (await seen(filt)) {
      await filt.click({ force: true }).catch(() => {});
      await pause(2500, 4000);
      record(cat, item, 'pass', `filter control present · ${before} → ${await nProducts(page)} results`, url);
    } else {
      record(cat, item, 'warn', `search returns ${before} results but offers no sort or filter control`, url);
    }
  });

  // ======================= COLLECTION ======================================
  console.log('\nCollection');
  await nav(page, collUrl);

  await step('Collection Page Testing', 'Verify filters / sorting working properly', async () => {
    const cat = 'Collection Page Testing', item = 'Verify filters / sorting working properly';
    const before = await nProducts(page);
    const firstBefore = await page.locator('a[href*="/products/"]').first().getAttribute('href').catch(() => '');
    const sort = page.locator('select[name="sort_by"], select#SortBy, [name="sort_by"]').first();
    const filt = page.locator('[class*="filter" i] input[type="checkbox"], [class*="facet" i] input[type="checkbox"]').first();
    if (await seen(sort)) {
      const n = await sort.locator('option').count();
      await sort.selectOption({ index: Math.min(2, n - 1) }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await pause(2000, 3200);
      const after = await nProducts(page);
      const firstAfter = await page.locator('a[href*="/products/"]').first().getAttribute('href').catch(() => '');
      record(cat, item, after > 0 ? 'pass' : 'fail',
        `sort applied (${n} options) · ${before} → ${after} products · first product ${firstAfter !== firstBefore ? 'changed' : 'unchanged'}`, collUrl);
    } else if (await seen(filt)) {
      await filt.click({ force: true }).catch(() => {});
      await pause(2800, 4200);
      const after = await nProducts(page);
      record(cat, item, after > 0 ? 'pass' : 'warn', `filter applied · ${before} → ${after} products`, collUrl);
    } else {
      record(cat, item, 'warn', 'no sort or filter control on the collection page', collUrl);
    }
  });

  await step('Collection Page Testing', 'Check product cards alignment', async () => {
    const cat = 'Collection Page Testing', item = 'Check product cards alignment';
    const m = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[class*="product-card" i], [class*="card-wrapper" i], [class*="grid__item" i], li[class*="product" i]')]
        .map(e => e.getBoundingClientRect()).filter(r => r.width > 60 && r.height > 60);
      if (cards.length < 4) return { n: cards.length, checked: 0 };
      const rows = {};
      for (const r of cards) { const k = Math.round(r.top / 10) * 10; (rows[k] ||= []).push(r); }
      let wMismatch = 0, hMismatch = 0, checked = 0;
      for (const k in rows) {
        const g = rows[k]; if (g.length < 2) continue;
        checked += g.length;
        const w = g.map(r => r.width), h = g.map(r => r.height);
        if (Math.max(...w) - Math.min(...w) > 2) wMismatch++;
        if (Math.max(...h) - Math.min(...h) > 8) hMismatch++;
      }
      return { n: cards.length, checked, wMismatch, hMismatch, rows: Object.keys(rows).length };
    });
    if (!m.checked) return record(cat, item, 'warn',
      `only ${m.n} product cards detected — not enough to compare alignment`, collUrl);
    const bad = m.wMismatch + m.hMismatch;
    record(cat, item, bad ? 'warn' : 'pass',
      bad ? `${m.n} cards over ${m.rows} rows · ${m.wMismatch} row(s) with uneven width, ${m.hMismatch} with uneven height`
          : `${m.n} cards over ${m.rows} rows, all aligned to equal width and height`, collUrl);
  });

  await step('Collection Page Testing', 'Verify wishlist / cart buttons', async () => {
    const cat = 'Collection Page Testing', item = 'Verify wishlist / cart buttons';
    const wish = await page.locator('[class*="wishlist" i], [class*="swym" i], [aria-label*="wishlist" i]').count();
    const quick = await page.locator('[class*="quick-add" i], [class*="quickadd" i], form[action*="/cart/add"] button, [class*="add-to-cart" i]').count();
    record(cat, item, (wish || quick) ? 'pass' : 'warn',
      `${wish} wishlist control(s) · ${quick} add-to-cart control(s) on the collection grid` +
      (wish ? '' : ' — no wishlist button found on the cards'), collUrl);
  });

  await step('Collection Page Testing', 'Test pagination or infinite scroll', async () => {
    const cat = 'Collection Page Testing', item = 'Test pagination or infinite scroll';
    const before = await nProducts(page);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 1800).catch(() => {}); await pause(300, 500); }
    await pause(2500, 4000);
    const after = await nProducts(page);
    const pager = await page.locator('a[href*="page="], [class*="pagination" i] a, [class*="load-more" i], [class*="loadmore" i]').count();
    if (after > before)  record(cat, item, 'pass', `infinite scroll loaded more products: ${before} → ${after}`, collUrl);
    else if (pager)      record(cat, item, 'pass', `pagination present (${pager} control(s), ${before} products per page)`, collUrl);
    else                 record(cat, item, 'warn', `no extra products after scrolling and no pagination control — all ${before} products may fit on one page`, collUrl);
  });

  await step('Collection Page Testing', 'Check breadcrumb navigation', async () => {
    const cat = 'Collection Page Testing', item = 'Check breadcrumb navigation';
    const b = await breadcrumb(page);
    record(cat, item, b.vis ? 'pass' : (b.ld ? 'warn' : 'fail'),
      b.vis ? `breadcrumb present${b.ld ? ' with BreadcrumbList schema' : ' (no BreadcrumbList schema)'}`
            : b.ld ? 'BreadcrumbList schema exists but no breadcrumb is rendered for shoppers'
                   : 'no breadcrumb and no BreadcrumbList schema on the collection page', collUrl);
  });

  await step('Collection Page Testing', 'Verify "no products found" empty state', async () => {
    const cat = 'Collection Page Testing', item = 'Verify "no products found" empty state';
    const url = `${collUrl}?filter.v.price.gte=9999999`;
    await goto(page, url);
    const n = await nProducts(page);
    const msg = /no product|not found|nothing here|no result|no item|0 product|empty/i.test(await text(page));
    record(cat, item, n === 0 && msg ? 'pass' : (n === 0 ? 'fail' : 'warn'),
      n === 0 && msg ? 'an impossible filter returns no products and shows an empty-state message'
      : n === 0 ? 'no products returned but no empty-state message is shown — shoppers see a blank grid'
                : `the filter did not empty the grid (${n} products still listed) — this theme may not support price filters`, url);
  });

  await step('Collection Page Testing', 'Check out-of-stock product display logic', async () => {
    const cat = 'Collection Page Testing', item = 'Check out-of-stock product display logic';
    if (!oosProd) return record(cat, item, 'warn',
      `no fully out-of-stock product among the ${products.length} in the catalogue feed — nothing to verify against`, collUrl);
    const u = `${STORE}/products/${oosProd.handle}`;
    await goto(page, u);
    const flagged = /sold out|out of stock|unavailable|notify me/i.test(await text(page));
    const disabled = await page.locator('button[name="add"][disabled], form[action*="/cart/add"] button[disabled]').count();
    record(cat, item, (flagged || disabled) ? 'pass' : 'fail',
      (flagged || disabled)
        ? `"${oosProd.title}" is marked unavailable${disabled ? ' and add-to-cart is disabled' : ''}`
        : `"${oosProd.title}" is out of stock in the catalogue but the page shows no sold-out label and add-to-cart is still enabled`, u);
  });

  // ======================= PRODUCT =========================================
  console.log('\nProduct');
  if (prodUrl) {
    await nav(page, prodUrl);

    await step('Product Page Testing', 'Check product images & variant images', async () => {
      const cat = 'Product Page Testing', item = 'Check product images & variant images';
      // Judge images by what actually rendered, not by a URL pattern: Shopify
      // serves media from /cdn/shop/..., which contains no "/products/", and
      // lazy images have no src at all until they scroll into view.
      // Give the images on screen a fair chance to arrive first. Judging the
      // instant after navigation calls a page broken when it was merely still
      // downloading — and "broken" and "slow" want different fixes, so they are
      // counted separately.
      const survey = () => page.evaluate(() => {
        const h = window.innerHeight;
        // Only images the shopper can currently see. A lazy image further down
        // the page has deliberately not loaded yet — counting it as broken would
        // punish the site for doing the right thing.
        const im = [...document.images].filter(i => {
          const r = i.getBoundingClientRect();
          return r.width > 50 && r.height > 50 && r.top < h && r.bottom > 0;
        });
        return {
          total: im.length,
          ok: im.filter(i => i.complete && i.naturalWidth > 0).length,
          broken: im.filter(i => i.complete && i.naturalWidth === 0).length,
          pending: im.filter(i => !i.complete).length
        };
      });
      let loaded = await survey();
      for (let i = 0; i < 8 && loaded.pending; i++) { await pause(700, 1000); loaded = await survey(); }
      // The gallery image is the biggest one on screen. Taking the first <img>
      // instead would watch the header logo, which never changes, and report
      // that variant images are broken on a page where they work.
      const mainSrc = () => page.evaluate(() => {
        let best = null, area = 0;
        for (const i of document.images) {
          const r = i.getBoundingClientRect();
          if (r.width * r.height > area) { area = r.width * r.height; best = i; }
        }
        return best ? (best.currentSrc || best.src || '') : '';
      }).catch(() => '');

      const src0 = await mainSrc();
      const sw = page.locator('[class*="swatch" i] input, [class*="swatch" i] label, fieldset input[type="radio"], select[name*="option" i], [data-option-value], [name^="options"]');
      const n = await sw.count();
      let changed = false;
      for (let i = 1; i < Math.min(n, 5) && !changed; i++) {
        await sw.nth(i).click({ force: true }).catch(() => {});
        await pause(1500, 2600);
        const s = await mainSrc();
        if (s && s !== src0) changed = true;
      }
      const imgStatus = loaded.broken ? 'fail' : (loaded.pending ? 'warn' : 'pass');
      const varStatus = multiVariant && !n ? 'fail' : ((n && !changed) ? 'warn' : 'pass');
      const worst = [imgStatus, varStatus].includes('fail') ? 'fail'
                  : [imgStatus, varStatus].includes('warn') ? 'warn' : 'pass';
      record(cat, item, worst,
        `${loaded.ok}/${loaded.total} on-screen images loaded` +
        (loaded.broken ? ` — ${loaded.broken} broken` : '') +
        (loaded.pending ? ` — ${loaded.pending} still downloading after 6s` : '') + ' · ' +
        (n ? `${n} variant option(s), main image ${changed ? 'updates' : 'does not update'} on switch`
           : multiVariant ? 'no variant selector rendered even though this product has several variants'
                          : 'no variant selector — no product in the catalogue has more than one variant'), prodUrl);
    });

    await step('Product Page Testing', 'Verify Add to Cart & Buy Now buttons', async () => {
      const cat = 'Product Page Testing', item = 'Verify Add to Cart & Buy Now buttons';
      const atc = page.locator('form[action*="/cart/add"] button[type="submit"], button[name="add"], [data-add-to-cart]').first();
      const buy = page.locator('[class*="buy-now" i], [class*="buynow" i], .shopify-payment-button button, [name="checkout"]').first();
      const atcOK = await seen(atc), buyOK = await seen(buy);
      const atcOn = atcOK ? await atc.isEnabled().catch(() => false) : false;
      record(cat, item, (atcOK && atcOn) ? (buyOK ? 'pass' : 'warn') : 'fail',
        `add to cart ${atcOK ? (atcOn ? 'visible and enabled' : 'visible but disabled') : 'not found'} · ` +
        `buy now ${buyOK ? 'visible' : 'not found'}`, prodUrl);
    });

    await step('Product Page Testing', 'Test variant selection', async () => {
      const cat = 'Product Page Testing', item = 'Test variant selection';
      const sw = page.locator('[class*="swatch" i] input, fieldset input[type="radio"], select[name*="option" i], [data-option-value]');
      const n = await sw.count();
      if (!n) return record(cat, item, multiVariant ? 'fail' : 'pass',
        multiVariant
          ? 'products with several variants render no selector — shoppers cannot choose one'
          : 'nothing to select: every product in the catalogue is single-variant, so no selector is expected', prodUrl);
      const url0 = page.url();
      const price0 = (await page.locator('[class*="price" i]').first().innerText().catch(() => '')).trim();
      let via = null;
      for (let i = 1; i < Math.min(n, 5); i++) {
        await sw.nth(i).click({ force: true }).catch(() => {});
        await pause(1600, 2600);
        const url1 = page.url();
        const price1 = (await page.locator('[class*="price" i]').first().innerText().catch(() => '')).trim();
        if (url1 !== url0) { via = 'variant id appears in the URL'; break; }
        if (price1 !== price0) { via = 'the price updates'; break; }
      }
      const param = /[?&]variant=\d+/.test(page.url());
      record(cat, item, (via || param) ? 'pass' : 'warn',
        via ? `selecting a variant updates the page — ${via}`
            : param ? 'the selected variant is tracked in the URL'
                    : `${n} options present but neither the URL nor the price changed on selection`, prodUrl);
    });

    await step('Product Page Testing', 'Ensure no broken layout on mobile', async () => {
      const cat = 'Product Page Testing', item = 'Ensure no broken layout on mobile';
      const o = await overflowers(page);
      const tiny = await page.evaluate(() => [...document.querySelectorAll('p, li, span, a, button')]
        .filter(e => (e.textContent || '').trim().length > 8 && parseFloat(getComputedStyle(e).fontSize) < 11).length);
      const side = o.docWidth > o.viewport + 2;
      record(cat, item, side ? 'fail' : (tiny > 6 ? 'warn' : 'pass'),
        side ? `page scrolls sideways at ${o.viewport}px (content is ${o.docWidth}px) — caused by ${o.bad.slice(0, 3).join(', ')}`
        : tiny > 6 ? `layout fits the viewport but ${tiny} text elements render below 11px`
                   : `fits the ${o.viewport}px viewport with no sideways scroll`, prodUrl);
    });

    await step('Product Page Testing', 'Check breadcrumb navigation', async () => {
      const cat = 'Product Page Testing', item = 'Check breadcrumb navigation';
      const b = await breadcrumb(page);
      record(cat, item, b.vis ? 'pass' : (b.ld ? 'warn' : 'fail'),
        b.vis ? `breadcrumb present${b.ld ? ' with BreadcrumbList schema' : ' (no BreadcrumbList schema)'}`
              : b.ld ? 'BreadcrumbList schema exists but nothing is rendered for shoppers'
                     : 'no breadcrumb and no BreadcrumbList schema on the product page', prodUrl);
    });

    await step('Product Page Testing', 'Verify stock/inventory status', async () => {
      const cat = 'Product Page Testing', item = 'Verify stock/inventory status';
      const u = `${STORE}/products/${inStock.handle}`;
      await goto(page, u);
      const saysOut = /sold out|out of stock|unavailable/i.test(await text(page));
      const available = (inStock.variants || []).some(v => v.available);
      const atcOn = await page.locator('form[action*="/cart/add"] button:not([disabled]), button[name="add"]:not([disabled])').count();
      const ok = available ? (!saysOut && atcOn > 0) : saysOut;
      record(cat, item, ok ? 'pass' : 'fail',
        available
          ? (saysOut ? `catalogue says "${inStock.title}" is in stock but the page shows a sold-out label`
                     : atcOn ? 'in stock in the catalogue and the page allows adding to cart'
                             : 'in stock in the catalogue but add-to-cart is disabled on the page')
          : (saysOut ? 'out of stock and clearly labelled as such'
                     : 'out of stock in the catalogue but the page does not say so'), u);
    });

    await step('Product Page Testing', 'Check sale price / compare-at price display', async () => {
      const cat = 'Product Page Testing', item = 'Check sale price / compare-at price display';
      if (!saleProd) return record(cat, item, 'warn',
        `no product among the ${products.length} in the catalogue feed carries a compare-at price — nothing on sale to verify`, prodUrl);
      const u = `${STORE}/products/${saleProd.handle}`;
      await goto(page, u);
      const v = (saleProd.variants || []).find(x => x.compare_at_price && +x.compare_at_price > +x.price);
      const struck = await page.locator('s, del, [class*="compare" i], [class*="was-price" i], [class*="price--on-sale" i]').count();
      const t = (await text(page)).replace(/[,\s]/g, '');
      const both = t.includes(String(Math.round(+v.price))) && t.includes(String(Math.round(+v.compare_at_price)));
      record(cat, item, (struck && both) ? 'pass' : ((struck || both) ? 'warn' : 'fail'),
        `"${saleProd.title}" is ${v.price} against ${v.compare_at_price} — ` +
        `${struck ? `${struck} struck-through/sale element(s)` : 'no struck-through price'}, ` +
        `${both ? 'both prices appear on the page' : 'both prices were not found on the page'}`, u);
      await nav(page, prodUrl);
    });

    await step('Product Page Testing', 'Verify related / upsell / cross-sell', async () => {
      const cat = 'Product Page Testing', item = 'Verify related / upsell / cross-sell';
      for (let i = 0; i < 9; i++) { await page.mouse.wheel(0, 1800).catch(() => {}); await pause(280, 460); }
      await pause(2500, 4000);
      const blocks = await page.locator('[class*="related" i], [class*="recommend" i], [class*="upsell" i], [class*="cross-sell" i], [class*="you-may" i], [class*="complementary" i]').count();
      const links = await page.locator('[class*="related" i] a[href*="/products/"], [class*="recommend" i] a[href*="/products/"], [class*="upsell" i] a[href*="/products/"]').count();
      const heading = /you may also like|related|recommended|customers also|complete the look|pairs well/i.test(await text(page));
      record(cat, item, links > 0 ? 'pass' : ((blocks || heading) ? 'warn' : 'fail'),
        links > 0 ? `${blocks} recommendation block(s) holding ${links} product links`
        : (blocks || heading) ? 'a recommendation section exists but holds no product links — the widget may not be loading'
                              : 'no related, upsell or cross-sell section found on the product page', prodUrl);
    });

    await step('Product Page Testing', 'Test sticky Add to Cart on scroll (mobile)', async () => {
      const cat = 'Product Page Testing', item = 'Test sticky Add to Cart on scroll (mobile)';
      await page.evaluate(() => window.scrollTo(0, 0));
      await pause(800, 1400);
      for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 1800).catch(() => {}); await pause(280, 460); }
      await pause(1800, 3000);
      const r = await page.evaluate(() => {
        const h = window.innerHeight;
        for (const el of document.querySelectorAll('button, a, form[action*="/cart/add"], [class*="sticky" i], [class*="atc" i]')) {
          const t = (el.innerText || '').toLowerCase();
          if (!/add to cart|add to bag|buy now|\badd\b/.test(t)) continue;
          const s = getComputedStyle(el), b = el.getBoundingClientRect();
          if ((s.position === 'fixed' || s.position === 'sticky') && b.height > 10 &&
              b.top < h && b.bottom > 0 && s.visibility !== 'hidden' && s.display !== 'none')
            return { found: true, pos: s.position, label: (el.innerText || '').trim().slice(0, 30) };
        }
        return { found: false };
      });
      record(cat, item, r.found ? 'pass' : 'warn',
        r.found ? `sticky add-to-cart stays on screen after scrolling (position: ${r.pos}, "${r.label}")`
                : 'no add-to-cart stays on screen after scrolling — shoppers must scroll back up to buy', prodUrl);
    });

    // ===================== CART ============================================
    console.log('\nCart & checkout');
    await nav(page, prodUrl);

    await step('Cart & Checkout Testing', 'Add product to cart', async () => {
      const cat = 'Cart & Checkout Testing', item = 'Add product to cart';
      await page.request.post(STORE + '/cart/clear.js').catch(() => {});
      const before = await cartCount(page);
      const btn = page.locator('form[action*="/cart/add"] button[type="submit"], button[name="add"], [data-add-to-cart]').first();
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 15000 });
      let after = before;
      for (let i = 0; i < 18; i++) { await pause(450, 700); after = await cartCount(page); if (after > before) break; }
      record(cat, item, after > before ? 'pass' : 'fail',
        after > before ? `cart went from ${before} to ${after} item(s)`
                       : 'clicking add to cart did not change the cart', prodUrl);
    });

    await step('Cart & Checkout Testing', 'Verify corner cart / drawer cart working', async () => {
      const cat = 'Cart & Checkout Testing', item = 'Verify corner cart / drawer cart working';
      const icon = await firstVisible(page.locator('a[href="/cart"], a[href$="/cart"], [class*="cart-icon" i], [class*="cart-toggle" i], [data-cart-drawer], [aria-controls*="cart" i], [class*="corner-cart" i]'));
      if (!icon) return record(cat, item, 'fail', 'no cart control found in the header', prodUrl);
      const url0 = page.url();
      await icon.click({ force: true }).catch(() => {});
      await pause(2000, 3400);
      const drawer = await page.locator('[class*="drawer" i]:visible, [class*="mini-cart" i]:visible, [class*="cart-popup" i]:visible, [role="dialog"]:visible, [class*="corner-cart" i]:visible').count();
      const navigated = page.url() !== url0;
      record(cat, item, drawer ? 'pass' : (navigated ? 'warn' : 'fail'),
        drawer ? 'the cart drawer opens over the page'
        : navigated ? 'no drawer — the cart icon navigates to the full /cart page instead'
                    : 'cart icon clicked but neither a drawer opened nor the page navigated', prodUrl);
    });
  }

  const cartUrl = STORE + '/cart';
  // Filled by the checkout-redirect step, read by the guest-checkout step.
  let checkoutText = '';
  await nav(page, cartUrl);

  await step('Cart & Checkout Testing', 'Update quantity / remove item', async () => {
    const cat = 'Cart & Checkout Testing', item = 'Update quantity / remove item';
    const start = await cartCount(page);
    if (start < 1) return record(cat, item, 'warn', 'cart is empty — no line item to change', cartUrl);
    let raised = 0;
    // Only controls that unambiguously mean "increase" — a bare
    // `[class*=quantity] button` would just as happily click the minus. This
    // theme uses an <a> labelled "Increase quantity", so match on text too.
    const plus = await firstVisible(page.locator(
      '[name="plus"], [aria-label*="increase" i], [aria-label*="add one" i], ' +
      '[data-action="increase"], [class*="qty-plus" i], [class*="quantity-up" i], ' +
      '[class*="quantity-selector" i] a:has-text("Increase"), [class*="quantity" i] button:has-text("+")'));
    const qty = await firstVisible(page.locator(
      'input[name="updates[]"], input[class*="quantity" i], input[type="number"]'));
    if (plus) await plus.click({ force: true }).catch(() => {});
    else if (qty) { await qty.fill('2').catch(() => {}); await page.keyboard.press('Enter').catch(() => {}); }
    for (let i = 0; i < 16; i++) { await pause(500, 800); const c = await cartCount(page); if (c > start) { raised = c; break; } }

    // Shopify's remove link is /cart/change?id=... — it carries no quantity=0.
    const rm = await firstVisible(page.locator(
      '[class*="line-item__remove" i], a[href*="/cart/change"], [aria-label*="remove" i], ' +
      'cart-remove-button, [class*="remove" i]'));
    const hasRm = !!rm;
    const beforeRemove = await cartCount(page);
    let removed = false, afterRemove = beforeRemove;
    if (hasRm) {
      await rm.click({ force: true }).catch(() => {});
      for (let i = 0; i < 16; i++) {
        await pause(500, 800);
        afterRemove = await cartCount(page);
        if (afterRemove < beforeRemove) { removed = true; break; }
      }
    }
    record(cat, item, (raised && removed) ? 'pass' : ((raised || removed) ? 'warn' : 'fail'),
      `quantity ${raised ? `updated ${start} → ${raised}` : (plus || qty ? 'control found but the cart did not change' : 'no visible control')} · ` +
      `remove ${removed ? `took the cart ${beforeRemove} → ${afterRemove}` : (hasRm ? 'clicked but the cart did not change' : 'no visible control')}`, cartUrl);
  });

  await step('Cart & Checkout Testing', 'Check empty cart state', async () => {
    const cat = 'Cart & Checkout Testing', item = 'Check empty cart state';
    await page.request.post(STORE + '/cart/clear.js').catch(() => {});
    await nav(page, cartUrl);
    const msg = /empty|nothing in your (cart|bag)|no items/i.test(await text(page));
    const cta = await page.locator('a[href*="/collections"], a[href="/"], [class*="continue" i]').count();
    record(cat, item, (msg && cta) ? 'pass' : (msg ? 'warn' : 'fail'),
      msg ? `empty-cart message shown${cta ? ' with a link back to shopping' : ' but with no link back to shopping'}`
          : 'an empty cart shows no "your cart is empty" message', cartUrl);
  });

  // Refill for the checkout-side checks. products.json can be stale about
  // availability, so try several variants rather than letting one bad id turn
  // the checkout result into a meaningless "cart is empty".
  const buyable = [];
  for (const p of products) for (const v of (p.variants || [])) if (v.available) buyable.push(v.id);
  for (const id of buyable.slice(0, 6)) {
    await page.request.post(STORE + '/cart/add.js', { data: { id, quantity: 1 } }).catch(() => {});
    if ((await cartCount(page)) > 0) break;
  }
  await nav(page, cartUrl);
  if ((await cartCount(page)) < 1) console.log('  (could not refill the cart — checkout-side checks will report that)');

  await step('Cart & Checkout Testing', 'Check discount codes', async () => {
    const cat = 'Cart & Checkout Testing', item = 'Check discount codes';
    const field = page.locator('input[name*="discount" i], input[id*="discount" i], input[placeholder*="coupon" i], input[placeholder*="promo" i], input[placeholder*="code" i]').first();
    if (!(await seen(field))) return record(cat, item, 'warn',
      'no discount field on the cart page — codes are entered inside the third-party checkout, which this run deliberately does not complete', cartUrl);
    if (!CODE) {
      await field.fill('QATESTINVALID000').catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
      await pause(2500, 4000);
      const rejected = /not valid|isn.t valid|invalid|expired|does ?n.t exist|unable/i.test(await text(page));
      return record(cat, item, rejected ? 'pass' : 'warn',
        rejected ? 'the discount field accepts input and correctly rejects an invalid code — set QA_DISCOUNT_CODE to also prove a real code discounts'
                 : 'the discount field exists but an invalid code produced no error — set QA_DISCOUNT_CODE to verify a real code end to end', cartUrl);
    }
    await field.fill(CODE).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await pause(3000, 4500);
    const t = await text(page);
    const bad = /not valid|isn.t valid|invalid|expired/i.test(t);
    record(cat, item, (!bad && /discount|saved|off/i.test(t)) ? 'pass' : 'fail',
      bad ? `code ${CODE} was rejected by the cart` : `code ${CODE} applied and a discount is shown`, cartUrl);
  });

  await step('Cart & Checkout Testing', 'Verify payment methods visibility', async () => {
    const cat = 'Cart & Checkout Testing', item = 'Verify payment methods visibility';
    const blob = (await text(page)) + ' ' + (await page.content().catch(() => ''));
    const brands = { UPI: /\bupi\b/i, Visa: /visa/i, Mastercard: /mastercard/i, RuPay: /rupay/i,
                     Paytm: /paytm/i, 'Google Pay': /google\s*pay|gpay/i, PhonePe: /phonepe/i,
                     Razorpay: /razorpay/i, COD: /cash on delivery|\bcod\b/i,
                     'Net banking': /net\s*banking/i, EMI: /\bemi\b/i, Amex: /amex|american express/i };
    const found = Object.keys(brands).filter(k => brands[k].test(blob));
    const icons = await page.locator('[class*="payment" i] img, img[alt*="pay" i], [class*="payment-icon" i], [class*="trust" i] img').count();
    record(cat, item, (found.length >= 2 || icons >= 2) ? 'pass' : ((found.length || icons) ? 'warn' : 'fail'),
      (found.length || icons)
        ? `${found.slice(0, 7).join(', ') || 'none named'}${icons ? ` · ${icons} payment/trust icon(s)` : ''} shown before checkout`
        : 'no payment methods or trust icons on the cart — shoppers cannot see how they can pay until they reach checkout', cartUrl);
  });

  await step('Cart & Checkout Testing', 'Test Partial COD / prepaid logic', async () => {
    const cat = 'Cart & Checkout Testing', item = 'Test Partial COD / prepaid logic';
    const blob = (await text(page)) + ' ' + (await page.content().catch(() => ''));
    const cod     = /cash on delivery|\bcod\b/i.test(blob);
    const partial = /partial\s*cod|advance|token amount|part payment/i.test(blob);
    const prepaid = /prepaid|pay online|pay now|pay full/i.test(blob);
    record(cat, item, (cod && (partial || prepaid)) ? 'pass' : ((cod || prepaid) ? 'warn' : 'fail'),
      `before checkout the cart mentions ${cod ? 'COD' : 'no COD'}, ${partial ? 'partial/advance' : 'no partial'}, ${prepaid ? 'prepaid' : 'no prepaid'}` +
      ' — the amount split itself is decided inside the Shiprocket checkout, which this run does not complete', cartUrl);
  });

  await step('Cart & Checkout Testing', 'Check shipping cost calculation display', async () => {
    const cat = 'Cart & Checkout Testing', item = 'Check shipping cost calculation display';
    const stated = /free shipping|shipping calculated|shipping & taxes|shipping and taxes|delivery charge|shipping charge/i.test(await text(page));
    const calc = await page.locator('[class*="shipping-calculator" i], [name*="zip" i], [name*="postal" i], [placeholder*="pincode" i]').count();
    record(cat, item, calc ? 'pass' : (stated ? 'warn' : 'fail'),
      calc ? 'the cart offers a shipping estimator before checkout'
      : stated ? 'the cart states the shipping policy but shows no amount — the real figure only appears inside the third-party checkout'
               : 'the cart says nothing about shipping cost before checkout', cartUrl);
  });

  await step('Cart & Checkout Testing', 'Test Shiprocket checkout redirect', async () => {
    const cat = 'Cart & Checkout Testing', item = 'Test Shiprocket checkout redirect';
    if ((await cartCount(page)) < 1) return record(cat, item, 'warn', 'cart is empty — checkout cannot be reached', cartUrl);
    const btns = page.locator('[name="checkout"], button[name="checkout"], a[href*="/checkout"], [class*="checkout" i], [class*="buy-now" i]');
    let target = null;
    for (let i = 0; i < Math.min(await btns.count(), 8); i++) {
      const c = btns.nth(i);
      if (await c.isVisible().catch(() => false)) { target = c; break; }
    }
    if (!target) return record(cat, item, 'fail', 'no visible checkout control on the cart page', cartUrl);
    const url0 = page.url();
    const popupP = ctx.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await target.click({ timeout: 15000 }).catch(() => {});
    await pause(5000, 7000);
    const popup = await popupP;
    const frame = page.frames().find(f => /checkout|shiprocket|sr-cdn|snapmint|razorpay|gokwik|payment/i.test(f.url()));
    const host = (u) => { try { return new URL(u).host; } catch { return String(u).slice(0, 40); } };
    let where = null;
    if (popup)                      where = 'new tab → ' + host(popup.url());
    else if (page.url() !== url0)   where = 'redirect → ' + host(page.url());
    else if (frame)                 where = 'embedded frame → ' + host(frame.url());
    else if (await page.locator('iframe[src*="checkout" i], [class*="checkout" i][class*="open" i]').count())
                                    where = 'checkout overlay opened in place';
    record(cat, item, where ? 'pass' : 'fail',
      where ? `checkout hands off: ${where}`
            : 'the checkout control was clicked but nothing opened — the purchase path is broken', cartUrl);

    // Keep what the checkout actually said while we can still read it. The
    // guest-checkout question is about this screen, and a popup is closed below.
    const grab = async (t) => { try { return await t.locator('body').innerText(); } catch { return ''; } };
    if (popup) { await popup.waitForLoadState('domcontentloaded').catch(() => {}); checkoutText = await grab(popup); }
    else if (frame) checkoutText = await frame.locator('body').innerText().catch(() => '');
    else checkoutText = (await Promise.all(page.frames().map(f => f.locator('body').innerText().catch(() => '')))).join(' ');

    if (popup) await popup.close().catch(() => {});
  });

  await step('Cart & Checkout Testing', 'Verify guest checkout option', async () => {
    const cat = 'Cart & Checkout Testing', item = 'Verify guest checkout option';
    // Checkout was reached above without ever signing in. The only question left
    // is whether it demands an account before it will take the order — judged on
    // the checkout's own text, captured during the redirect step.
    if (!checkoutText) return record(cat, item, 'warn',
      'checkout screen could not be read, so whether it allows guests is unproven', cartUrl);
    const wall = /sign in to continue|log in to continue|create an account to|account required|must be logged in|login required/i.test(checkoutText);
    const guest = /continue as guest|guest checkout|mobile number|phone number|\botp\b/i.test(checkoutText);
    record(cat, item, wall ? 'fail' : 'pass',
      wall ? 'checkout demands an account before it will proceed — guest buyers are blocked'
           : `checkout was reached without signing in${guest ? ' and asks only for guest details such as a phone number' : ''}`, cartUrl);
  });

  await step('Cart & Checkout Testing', 'Test address & pincode serviceability', async () => {
    record('Cart & Checkout Testing', 'Test address & pincode serviceability', 'manual',
      'left manual on purpose — verifying this means typing a real address into the live Shiprocket checkout, which risks creating a real order and real customer data. Automated up to the checkout handoff only.', cartUrl);
  });

  // ======================= ACCESSIBILITY ===================================
  console.log('\nAccessibility');
  await nav(page, HOME);

  await step('Cross-Browser & Accessibility Testing', 'Check keyboard nav / screen reader basics', async () => {
    const cat = 'Cross-Browser & Accessibility Testing', item = 'Check keyboard nav / screen reader basics';
    let reached = 0, focusRing = 0;
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      await pause(90, 180);
      const f = await page.evaluate(() => {
        const e = document.activeElement;
        if (!e || e === document.body) return null;
        const s = getComputedStyle(e);
        const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth || '0') > 0;
        return { ring: outline || (s.boxShadow && s.boxShadow !== 'none') };
      }).catch(() => null);
      if (f) { reached++; if (f.ring) focusRing++; }
    }
    const a = await page.evaluate(() => {
      const imgs = [...document.images];
      return {
        landmarks: document.querySelectorAll('header,nav,main,footer,[role="banner"],[role="navigation"],[role="main"],[role="contentinfo"]').length,
        main: !!document.querySelector('main, [role="main"]'),
        h1: document.querySelectorAll('h1').length,
        lang: document.documentElement.lang || '',
        skip: !!document.querySelector('a[href^="#"][class*="skip" i], a[class*="skip-to" i], a[href="#MainContent"]'),
        imgs: imgs.length,
        noAlt: imgs.filter(i => !i.hasAttribute('alt')).length,
        btnNoName: [...document.querySelectorAll('button, [role="button"]')]
          .filter(b => !(b.innerText || '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')).length
      };
    });
    const bad = [];
    if (!reached)                bad.push('nothing receives keyboard focus');
    if (reached && !focusRing)   bad.push('focused elements show no visible focus ring');
    if (!a.main)                 bad.push('no <main> landmark');
    if (a.h1 !== 1)              bad.push(`${a.h1} <h1> headings`);
    if (!a.lang)                 bad.push('no lang attribute on <html>');
    if (!a.skip)                 bad.push('no skip-to-content link');
    if (a.noAlt > 0)             bad.push(`${a.noAlt} images without alt`);
    if (a.btnNoName > 0)         bad.push(`${a.btnNoName} buttons with no accessible name`);
    record(cat, item, bad.length > 3 ? 'fail' : (bad.length ? 'warn' : 'pass'),
      bad.length ? `${reached} elements reachable by Tab · ${bad.join('; ')}`
                 : `${reached} elements reachable by Tab with a visible focus ring, ${a.landmarks} landmarks, one h1, alt text on all ${a.imgs} images`, HOME);
  });

  await browser.close();

  // ======================= CROSS-BROWSER ===================================
  // Chromium is the engine behind both Chrome and Edge, WebKit is Safari,
  // Gecko is Firefox — between them that is every browser the task names.
  console.log('\nCross-browser');
  await step('Cross-Browser & Accessibility Testing', 'Test on Chrome / Safari / Firefox / Edge', async () => {
    const cat = 'Cross-Browser & Accessibility Testing', item = 'Test on Chrome / Safari / Firefox / Edge';
    const engines = [['Chrome/Edge (Chromium)', chromium], ['Safari (WebKit)', webkit], ['Firefox (Gecko)', firefox]];
    const ok = [], failed = [], skipped = [];
    for (const [name, launcher] of engines) {
      let b = null;
      try {
        b = await launcher.launch({
          ...(launcher === chromium && process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
          args: launcher === chromium ? ['--no-sandbox'] : []
        });
        const c = await b.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-IN' });
        const p = await c.newPage();
        const errs = [];
        p.on('pageerror', e => errs.push((e.message || '').slice(0, 60)));
        const t0 = Date.now();
        const resp = await p.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await p.waitForTimeout(3500);
        const m = await p.evaluate(() => ({
          w: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
          broken: [...document.images].filter(i => i.complete && i.naturalWidth === 0).length,
          txt: (document.body.innerText || '').length
        }));
        const bad = [];
        if (!resp || resp.status() >= 400) bad.push('HTTP ' + (resp ? resp.status() : '?'));
        if (m.txt < 400)      bad.push('rendered almost no text');
        if (m.broken > 0)     bad.push(`${m.broken} broken image(s)`);
        if (m.w > m.vw + 2)   bad.push(`scrolls sideways (${m.w}px in ${m.vw}px)`);
        if (errs.length)      bad.push(`${errs.length} JS error(s): ${errs[0]}`);
        if (bad.length) failed.push(`${name}: ${bad.join(', ')}`);
        else ok.push(`${name} ${Date.now() - t0}ms`);
        await b.close(); b = null;
      } catch (e) {
        if (b) await b.close().catch(() => {});
        skipped.push(`${name} (${(e.message || '').split('\n')[0].slice(0, 50)})`);
      }
    }
    if (!ok.length && !failed.length) return record(cat, item, 'error',
      `no browser engine could be launched: ${skipped.join('; ')}`, HOME);
    record(cat, item, failed.length ? 'fail' : (skipped.length ? 'warn' : 'pass'),
      failed.length ? `${failed.join(' | ')}${ok.length ? ` · rendered cleanly on ${ok.join(', ')}` : ''}`
      : skipped.length ? `rendered cleanly on ${ok.join(' · ')} · not run: ${skipped.join(', ')}`
                       : `homepage renders cleanly on all three engines — ${ok.join(' · ')}`, HOME);
  });
}

// ---------------------------------------------------------------------------
let fatal = '';
try { await main(); }
catch (e) { fatal = (e.message || String(e)).split('\n')[0].slice(0, 90); console.error('fatal:', fatal); }

// Reconcile against the contract. A check that never ran is written out as an
// error naming why, so the dashboard shows a gap instead of keeping yesterday's
// green tick — the quiet failure mode that makes a monitor worth nothing.
for (const [category, item] of EXPECTED) {
  if (rows.some(r => r.category === category && r.item === item)) continue;
  record(category, item, 'error',
    fatal ? `did not run — the suite stopped early: ${fatal}`
          : `did not run — its page could not be reached this cycle`);
}

const n = (s) => rows.filter(r => r.status === s).length;
console.log(`\n${rows.length} browser QA checks · ${n('pass')} pass · ${n('warn')} warn · ` +
            `${n('fail')} fail · ${n('error')} error · ${n('manual')} left manual`);

if (SUPABASE_URL && SERVICE_KEY && rows.length) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/task_checks`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY,
               'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(rows)
  });
  if (!r.ok) { console.error('save failed:', r.status, (await r.text()).slice(0, 200)); process.exitCode = 1; }
  else console.log('saved to task_checks.');
} else if (!SUPABASE_URL || !SERVICE_KEY) {
  console.log('(no Supabase credentials — results printed only)');
}
