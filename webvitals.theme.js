import { onLCP, onCLS, onINP, onFCP, onTTFB }
  from 'https://unpkg.com/web-vitals@4/dist/web-vitals.attribution.js?module';

const SUPABASE_URL      = 'https://ijzudvwhzsnwysucyves.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlqenVkdndoenNud3lzdWN5dmVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5MzA1MDYsImV4cCI6MjA5OTUwNjUwNn0.i59l07obJhiKt-RND4FEsETKpVUsvQiVGYxDYt5K0Cw';
const ENDPOINT      = SUPABASE_URL + '/rest/v1/rum_events';
const FUNNEL_ENDPOINT = SUPABASE_URL + '/rest/v1/funnel_events';

const ua = navigator.userAgent;
const round = n => (typeof n === 'number' ? Math.round(n) : null);
const sessionId = (() => {
  try { let s = sessionStorage.getItem('_rum_sid'); if (!s) { s = (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + '-' + Math.random()); sessionStorage.setItem('_rum_sid', s); } return s; }
  catch { return (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + '-' + Math.random()); }
})();

const qp = new URLSearchParams(location.search);
const utm = k => qp.get('utm_' + k) || null;
const gclid = qp.get('gclid') || null;
const fbclid = qp.get('fbclid') || null;
const screenSize = (screen && screen.width) ? (screen.width + 'x' + screen.height) : null;
const lang = navigator.language || null;

const cookie = n => { const mm = document.cookie.match('(^|;)\\s*' + n + '\\s*=\\s*([^;]+)'); return mm ? mm.pop() : ''; };
const gaClientId = (cookie('_ga').split('.').slice(-2).join('.')) || null;
const gaSessionId = (cookie('_ga_NG5J2LV3F5').split('.')[2]) || null;

const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
  : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
  : /Safari\//.test(ua) ? 'Safari' : 'Other';
const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android'
  : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS'
  : /Linux/.test(ua) ? 'Linux' : 'Other';

const m = {};                 // collected metrics keyed by name
let sent = false;

let engagedMs = 0;
let visStart = (document.visibilityState === 'visible') ? performance.now() : null;
let interacted = false;
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (visStart !== null) { engagedMs += performance.now() - visStart; visStart = null; }
  } else if (visStart === null) { visStart = performance.now(); }
});
['click', 'keydown', 'scroll'].forEach(e =>
  addEventListener(e, () => { interacted = true; }, { once: true, passive: true }));
function timeOnPage() { return Math.round(engagedMs + (visStart !== null ? performance.now() - visStart : 0)); }

function stampCart() {
  try {
    fetch('/cart/update.js', {
      method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributes: { _rum_sid: sessionId, _rum_gid: gaClientId || '' } })
    }).catch(() => {});
  } catch {}
}
function stampOnce() {
  try {
    if (sessionStorage.getItem('_rum_stamped')) return;
    sessionStorage.setItem('_rum_stamped', '1');
  } catch {}
  stampCart();
}
(window.requestIdleCallback || (f => setTimeout(f, 1500)))(stampOnce);

function sendEvent(type) {
  try {
    fetch(FUNNEL_ENDPOINT, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY,
                 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ session_id: sessionId, event_type: type, path: location.pathname,
                             ga_client_id: gaClientId, referrer: document.referrer || '' })
    }).catch(() => {});
  } catch {}
}

const _fetch = window.fetch;
window.fetch = function (...args) {
  try {
    const u = (args[0] && args[0].url) || args[0] || '';
    if (/\/cart\/add(\.js)?/.test(String(u))) { sendEvent('add_to_cart'); stampCart(); }
  } catch {}
  return _fetch.apply(this, args);
};
const _open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url) {
  try { if (/\/cart\/add(\.js)?/.test(String(url))) this.addEventListener('load', () => { sendEvent('add_to_cart'); stampCart(); }); } catch {}
  return _open.apply(this, arguments);
};
addEventListener('submit', (e) => {
  try {
    const f = e.target; if (!f) return;
    const action = f.action || '';
    if (/\/cart\/add/.test(action)) { sendEvent('add_to_cart'); stampCart(); return; }
    const sub = e.submitter;
    if (/\/cart(\?|$|\/)/.test(action) &&
        ((sub && (sub.name === 'checkout' || /checkout/i.test(sub.value || ''))) || f.querySelector('[name="checkout"]'))) {
      sendEvent('checkout_click'); stampCart();
    }
  } catch {}
}, { capture: true, passive: true });

const CHECKOUT_SEL = '[name="checkout"],[href*="/checkout"],button[value="Checkout"],'
  + '[class*="checkout" i],[class*="buy-now" i],[onclick*="checkout" i],[onclick*="buyCart" i],'
  + '.shopify-payment-button__button,[data-shopify="payment-button"]';
function isCheckoutTarget(t) {
  try {
    if (!t) return false;
    if (t.closest && t.closest(CHECKOUT_SEL)) return true;
    const el = t.closest && t.closest('button,a,input');
    return !!el && /check\s*out|buy it now|buy now|place order/i.test((el.textContent || el.value || '').trim());
  } catch { return false; }
}
const BUYNOW_SEL = '.shopify-payment-button__button,[data-shopify="payment-button"],'
  + '[class*="buy-now" i],[class*="buy_now" i],[id*="buy-now" i],[data-testid*="Checkout-button" i]';
addEventListener('click', (e) => {
  try {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest(BUYNOW_SEL)) { sendEvent('buy_now'); stampCart(); return; }
    if (isCheckoutTarget(t)) { sendEvent('checkout_click'); stampCart(); }
  } catch {}
}, { capture: true, passive: true });

addEventListener('click', (e) => {
  try {
    const t = e.target;
    if (t.closest && t.closest('a[href="/cart"],[href^="/cart"],[class*="cart-icon" i],[class*="cart-toggle" i],[data-cart-drawer],[aria-controls*="cart" i]'))
      sendEvent('view_cart');
  } catch {}
}, { capture: true, passive: true });

const HEALTH_ENDPOINT = SUPABASE_URL + '/rest/v1/health_events';
let healthSent = 0;

const HEALTH_SEEN_KEY = '_hs_seen';
let healthSeen = new Set();
try { healthSeen = new Set(JSON.parse(sessionStorage.getItem(HEALTH_SEEN_KEY) || '[]')); } catch {}

function healthIsNew(sig) {
  if (healthSeen.has(sig)) return false;
  healthSeen.add(sig);
  if (healthSeen.size > 40) return true;    // stop growing the key on a hostile page
  try { sessionStorage.setItem(HEALTH_SEEN_KEY, JSON.stringify([...healthSeen])); } catch {}
  return true;
}

function sendHealth(kind, detail, extra) {
  if (healthSent > 25) return;              // never let a broken page flood the DB
  if (!healthIsNew(kind + '|' + String(detail || '').replace(/[?#].*$/, '').slice(0, 80))) return;
  healthSent++;
  try {
    fetch(HEALTH_ENDPOINT, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY,
                 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Prefer': 'return=minimal' },
      body: JSON.stringify(Object.assign({
        session_id: sessionId, kind, path: location.pathname,
        detail: String(detail || '').slice(0, 300),
        browser, os, device: /Mobi/i.test(ua) ? 'mobile' : 'desktop'
      }, extra || {}))
    }).catch(() => {});
  } catch {}
}

addEventListener('error', (e) => {
  if (e.target && e.target !== window && (e.target.src || e.target.href)) {
    sendHealth('js_error', 'failed to load: ' + (e.target.src || e.target.href),
               { source: (e.target.src || e.target.href || '').slice(0, 300) });
    return;
  }
  sendHealth('js_error', e.message, { source: (e.filename || '').slice(0, 300), line: e.lineno || null });
}, true);
addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  sendHealth('js_error', 'unhandled promise: ' + (r && (r.message || r)) );
});

let lastSel = '', lastAt = 0, hits = 0, deadChecks = 0;
const selOf = el => { try {
  if (!el || !el.tagName) return '';
  return el.tagName.toLowerCase()
    + (el.id ? '#' + el.id : '')
    + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0,2).join('.') : '');
} catch { return ''; } };
addEventListener('click', (e) => {
  try {
    const sel = selOf(e.target), now = Date.now();
    if (sel && sel === lastSel && now - lastAt < 1000) {
      if (++hits === 3) sendHealth('rage_click', sel);
    } else { hits = 1; }
    lastSel = sel; lastAt = now;

    if (deadChecks >= 3) return;
    if (!e.target.closest('a,button,input,select,textarea,[role="button"],[onclick]')) return;
    deadChecks++;
    const urlBefore = location.href;
    let changed = false;
    const mo = new MutationObserver(() => { changed = true; mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      mo.disconnect();
      if (!changed && location.href === urlBefore) sendHealth('dead_click', sel);
    }, 400);
  } catch {}
}, { capture: true, passive: true });

addEventListener('pagehide', () => {
  if (timeOnPage() < 2000 && !interacted) sendHealth('rapid_back', 'left in ' + timeOnPage() + 'ms');
});

function record(metric) {
  const a = metric.attribution || {};
  const e = { value: round(metric.value), rating: metric.rating };
  if (metric.name === 'LCP')  e.element = a.element || '';
  if (metric.name === 'CLS')  e.element = a.largestShiftTarget || '';
  if (metric.name === 'INP') { e.target = a.interactionTarget || ''; e.type = a.interactionType || ''; }
  if (metric.name === 'TTFB') {
    e.waiting = round(a.waitingDuration);
    e.dns     = round(a.dnsDuration);
    e.connect = round(a.connectionDuration);
    e.request = round(a.requestDuration);
  }
  m[metric.name] = e;
}

function payload() {
  const c = navigator.connection || {};
  return {
    session_id: sessionId,
    url: location.href,
    path: location.pathname,
    referrer: document.referrer || '',
    device: /Mobi/i.test(ua) ? 'mobile' : 'desktop',
    os, browser,
    viewport: innerWidth + 'x' + innerHeight,
    connection: c.effectiveType || 'unknown',
    save_data: c.saveData ?? null,
    device_memory: navigator.deviceMemory ?? null,
    cpu_cores: navigator.hardwareConcurrency ?? null,
    nav_type: (performance.getEntriesByType('navigation')[0] || {}).type || '',
    lcp: m.LCP?.value ?? null,  lcp_rating: m.LCP?.rating ?? null,  lcp_element: m.LCP?.element ?? null,
    cls: m.CLS?.value ?? null,  cls_rating: m.CLS?.rating ?? null,  cls_element: m.CLS?.element ?? null,
    inp: m.INP?.value ?? null,  inp_rating: m.INP?.rating ?? null,  inp_target: m.INP?.target ?? null, inp_type: m.INP?.type ?? null,
    fcp: m.FCP?.value ?? null,  fcp_rating: m.FCP?.rating ?? null,
    ttfb: m.TTFB?.value ?? null, ttfb_rating: m.TTFB?.rating ?? null,
    ttfb_waiting: m.TTFB?.waiting ?? null, ttfb_dns: m.TTFB?.dns ?? null,
    ttfb_connect: m.TTFB?.connect ?? null, ttfb_request: m.TTFB?.request ?? null,
    utm_source: utm('source'), utm_medium: utm('medium'), utm_campaign: utm('campaign'),
    gclid, fbclid,
    screen: screenSize, lang,
    ga_client_id: gaClientId, ga_session_id: gaSessionId,
    time_on_page: timeOnPage(),
    is_bounce: (timeOnPage() < 5000 && !interacted),
    raw: { metrics: m, ua, utm_term: utm('term'), utm_content: utm('content'), title: document.title, pixelRatio: devicePixelRatio || null }
  };
}

function flush() {
  if (sent) return;
  sent = true;
  const body = JSON.stringify(payload());
  fetch(ENDPOINT, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'Prefer': 'return=minimal'
    },
    body
  }).catch(() => {});
}

onLCP(record); onCLS(record); onINP(record); onFCP(record); onTTFB(record);

addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
addEventListener('pagehide', flush);
setTimeout(flush, 600000);   // 10 min long-stop
