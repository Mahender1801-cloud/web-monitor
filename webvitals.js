import { onLCP, onCLS, onINP, onFCP, onTTFB }
  from 'https://unpkg.com/web-vitals@4/dist/web-vitals.attribution.js?module';

const SUPABASE_URL      = 'https://ijzudvwhzsnwysucyves.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlqenVkdndoenNud3lzdWN5dmVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5MzA1MDYsImV4cCI6MjA5OTUwNjUwNn0.i59l07obJhiKt-RND4FEsETKpVUsvQiVGYxDYt5K0Cw';
const ENDPOINT = SUPABASE_URL + '/rest/v1/rum_events';

const ua = navigator.userAgent;
const round = n => (typeof n === 'number' ? Math.round(n) : null);
const sessionId = (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + '-' + Math.random());

// marketing attribution + device context (needs the extra columns from apply_all.sql)
const qp = new URLSearchParams(location.search);
const utm = k => qp.get('utm_' + k) || null;
const screenSize = (screen && screen.width) ? (screen.width + 'x' + screen.height) : null;
const lang = navigator.language || null;

const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
  : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
  : /Safari\//.test(ua) ? 'Safari' : 'Other';
const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android'
  : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS'
  : /Linux/.test(ua) ? 'Linux' : 'Other';

const m = {};                 // collected metrics keyed by name
let sent = false;

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
    screen: screenSize, lang,
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
setTimeout(flush, 8000);   // safety flush for visitors who linger
