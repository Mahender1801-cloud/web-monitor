// ============================================================================
// synthetic.mjs — walks the REAL purchase path in a real browser.
//
// Every other probe in this project fetches HTML server-side. That can tell you a
// page returned 200; it cannot tell you the Add-to-Cart button works, because the
// button is JavaScript. This drives Chromium through the actual journey:
//
//   homepage -> collection -> product -> add to cart -> cart -> checkout hand-off
//
// and records how long each step took. If a theme deploy breaks add-to-cart, this
// fails within the hour instead of showing up as a quiet drop in orders.
//
// It stops at the checkout hand-off — it never submits payment or places an order.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, STORE_URL (default hashtageyewears.com)
// ============================================================================
import { chromium } from 'playwright';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const STORE        = (process.env.STORE_URL || 'https://hashtageyewears.com').replace(/\/$/, '');

const steps = [];
let failed = null;
const t0 = Date.now();

async function step(name, fn) {
  if (failed) { steps.push({ step: name, ms: 0, ok: false, note: 'skipped' }); return null; }
  const s = Date.now();
  try {
    const note = await fn();
    steps.push({ step: name, ms: Date.now() - s, ok: true, note: note || '' });
    console.log(`  ✓ ${name} (${Date.now() - s}ms) ${note || ''}`);
    return note;
  } catch (e) {
    failed = name;
    steps.push({ step: name, ms: Date.now() - s, ok: false, note: e.message.slice(0, 200) });
    console.error(`  ✕ ${name}: ${e.message}`);
    return null;
  }
}

const run = async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  // A real mobile profile: 87% of this store's traffic is mobile, so testing
  // desktop only would miss the journey most customers actually take.
  const ctx = await browser.newContext({
    ...require_device(),
    locale: 'en-IN',
    extraHTTPHeaders: { 'Accept-Language': 'en-IN,en;q=0.9' }
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);

  await step('homepage', async () => {
    // Shopify/Cloudflare bot protection returns 429 to datacentre IPs, and GitHub
    // runners are datacentre IPs. A 429 here is the CDN turning us away, not the
    // store being down — so back off and retry before calling it a failure.
    const r = await gotoWithRetry(page, STORE + '/');
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    return 'HTTP ' + r.status();
  });

  let productUrl = null;
  await step('find a product', async () => {
    // products.json is the store's own catalog feed — deterministic, and it means
    // the test does not depend on a particular collection layout.
    const res = await page.request.get(STORE + '/products.json?limit=30');
    const j = await res.json();
    const live = (j.products || []).find(p =>
      (p.variants || []).some(v => v.available) && (p.images || []).length);
    if (!live) throw new Error('no in-stock product with an image found');
    productUrl = `${STORE}/products/${live.handle}`;
    return live.handle;
  });

  await step('open product page', async () => {
    const r = await gotoWithRetry(page, productUrl);
    await page.waitForSelector('form[action*="/cart/add"], button[name="add"], [data-add-to-cart]', { timeout: 20000 });
    return 'HTTP ' + r.status();
  });

  await step('add to cart', async () => {
    const before = await cartCount(page);
    const btn = page.locator('form[action*="/cart/add"] button[type="submit"], button[name="add"], [data-add-to-cart]').first();
    await btn.scrollIntoViewIfNeeded();
    await btn.click({ timeout: 15000 });
    // the drawer/ajax cart needs a moment; poll the cart rather than guess
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      if ((await cartCount(page)) > before) return 'cart went ' + before + ' -> ' + (await cartCount(page));
    }
    throw new Error('cart count did not increase after clicking add-to-cart');
  });

  await step('cart page', async () => {
    const r = await gotoWithRetry(page, STORE + '/cart');
    const n = await cartCount(page);
    if (!n) throw new Error('cart is empty on /cart');
    return n + ' item(s)';
  });

  await step('checkout hand-off', async () => {
    // We only verify the hand-off starts and where it goes — this store checks out
    // on a third party, which is exactly the leg that is invisible today.
    // This store checks out on a third party (Snapmint / Shiprocket), so Shopify's
    // standard [name=checkout] control is not present. Match the same broad set the
    // collector uses, and fall back to any control whose label reads like checkout.
    const SEL = '[name="checkout"], button[name="checkout"], a[href*="/checkout"], '
      + '[class*="checkout" i], [id*="checkout" i], [class*="buy-now" i], '
      + '.shopify-payment-button__button, [data-shopify="payment-button"]';
    let btn = page.locator(SEL).first();
    if (!(await btn.count())) {
      btn = page.getByRole('button', { name: /check\s*out|place order|buy now|proceed/i }).first();
    }
    if (!(await btn.count())) {
      btn = page.locator('button, a').filter({ hasText: /check\s*out|proceed to pay|place order/i }).first();
    }
    if (!(await btn.count())) throw new Error('no checkout control found on /cart');
    await Promise.all([
      page.waitForURL(/checkout|shiprocket|gokwik|razorpay|payment/i, { timeout: 30000 }).catch(() => {}),
      btn.click({ timeout: 15000 })
    ]);
    await page.waitForTimeout(3000);
    const u = page.url();
    if (/\/cart\/?$/.test(u)) throw new Error('checkout click did not navigate (still on /cart)');
    return new URL(u).host;
  });

  await browser.close();
};

// Retry navigation on the CDN's throttle/blocking responses with growing backoff.
async function gotoWithRetry(page, url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(e => { last = e; return null; });
    if (r && r.status() < 400) return r;
    last = r ? new Error('HTTP ' + r.status()) : last;
    if (r && ![429, 403, 503].includes(r.status())) break;   // a real error, not throttling
    await page.waitForTimeout(4000 * (i + 1));
  }
  throw last || new Error('navigation failed');
}

async function cartCount(page) {
  try {
    const r = await page.request.get(STORE + '/cart.js');
    const j = await r.json();
    return j.item_count || 0;
  } catch { return 0; }
}

// Playwright's device registry, without importing the whole devices map by name
function require_device() {
  return {
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3, isMobile: true, hasTouch: true
  };
}

try {
  await run();
} catch (e) {
  failed = failed || 'launch';
  steps.push({ step: 'fatal', ms: 0, ok: false, note: e.message.slice(0, 200) });
  console.error('fatal:', e.message);
}

const ok = !failed;
const payload = {
  ok, failed_step: failed, steps, total_ms: Date.now() - t0,
  error: failed ? (steps.find(s => !s.ok) || {}).note : null
};
console.log(ok ? `PASS in ${payload.total_ms}ms` : `FAIL at "${failed}" after ${payload.total_ms}ms`);

if (SUPABASE_URL && SERVICE_KEY) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/synthetic_runs`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY,
               'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(payload)
  });
  if (!r.ok) console.error('save failed:', r.status, (await r.text()).slice(0, 200));
}

// Fail the workflow so the run is visibly red when the money path is broken.
if (!ok) process.exit(1);
