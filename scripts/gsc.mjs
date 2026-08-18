// ============================================================================
// gsc.mjs — pull Search Console into gsc_keywords.
//
// This is the free half of search visibility, and the more trustworthy half.
// Search Console reports the position Google actually served, aggregated over
// real impressions — a SERP scraper only ever sees one synthetic search from
// one location at one moment, and personalisation makes that a sample of one.
// Where the two disagree, this is right.
//
// No new credentials: it reuses the service account already set up for GA. The
// account does need to be added as a user on the Search Console property, and
// the scope below has to be on the token, which is why it mints its own rather
// than borrowing GA's.
//
// Free, officially, with no monthly cap worth worrying about — 1,200 queries
// per minute and 30,000 a day, against the handful this makes.
//
//   node scripts/gsc.mjs            # yesterday back 3 days (Google backfills)
//   node scripts/gsc.mjs 2026-08-01 2026-08-16
//
// Env: GSC_SITE (e.g. sc-domain:hashtageyewears.com), GA_SA_KEY,
//      SUPABASE_URL, SUPABASE_SERVICE_KEY
// ============================================================================
import crypto from 'crypto';

const SITE  = process.env.GSC_SITE || '';
const SAKEY = process.env.GA_SA_KEY || process.env.GSC_SA_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

if (!SITE || !SAKEY) {
  console.log('Not configured. Needs GSC_SITE and GA_SA_KEY.');
  console.log('GSC_SITE is the property exactly as Search Console names it:');
  console.log('  sc-domain:hashtageyewears.com     (domain property)');
  console.log('  https://hashtageyewears.com/      (URL-prefix property)');
  console.log('\nThe GA service account must also be added under Search Console ->');
  console.log('Settings -> Users and permissions, or every call returns 403.');
  process.exit(0);
}

const b64 = (s) => Buffer.from(s).toString('base64url');

async function token(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head  = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now
  }));
  const unsigned = `${head}.${claim}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`
    })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('auth failed: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

// Search Console pages at 25,000 rows and will not go past 50,000 for one
// request, so a busy day is walked rather than asked for in one go.
async function query(tok, body) {
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`;
  const out = [];
  for (let start = 0; ; start += 25000) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, rowLimit: 25000, startRow: start }),
      signal: AbortSignal.timeout(90000)
    });
    const j = await r.json();
    if (j.error) throw new Error(`${j.error.code} ${j.error.message}`);
    const rows = j.rows || [];
    out.push(...rows);
    if (rows.length < 25000) break;
  }
  return out;
}

async function save(rows) {
  if (!rows.length) return 0;
  // Upsert, because Google revises the last few days as more data lands. Merging
  // on the natural key means a re-run corrects a day instead of duplicating it.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/gsc_keywords?on_conflict=d,query,page,country,device`, {
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(chunk)
    });
    if (!r.ok) throw new Error(`save failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
// Default window starts 3 days back, not 1: Search Console keeps revising a day
// for roughly 48 hours, so only re-reading yesterday would freeze the first,
// incomplete version of every day into the table.
const from = process.argv[2] || day(4);
const to   = process.argv[3] || day(1);

let sa;
try { sa = JSON.parse(SAKEY); }
catch { console.error('GA_SA_KEY is not valid JSON'); process.exit(1); }

try {
  const tok = await token(sa);
  console.log(`${SITE}  ${from} .. ${to}`);

  const rows = await query(tok, {
    startDate: from, endDate: to,
    dimensions: ['date', 'query', 'device', 'country'],
    type: 'web'
  });
  console.log(`  ${rows.length.toLocaleString()} rows from Search Console`);

  const mapped = rows.map(r => ({
    d: r.keys[0], query: r.keys[1], device: r.keys[2], country: r.keys[3],
    page: null,
    clicks: r.clicks || 0, impressions: r.impressions || 0,
    ctr: r.ctr ?? null,
    position: r.position ?? null
  }));

  if (SUPABASE_URL && SERVICE_KEY) {
    await save(mapped);
    console.log(`  saved.`);
  } else {
    console.log('  (no Supabase credentials — not saved)');
  }

  // A quick read of what came back, so a run that "worked" but returned an
  // empty or wrong property is obvious rather than silent.
  const uniq = new Set(mapped.map(r => r.query));
  const imps = mapped.reduce((t, r) => t + r.impressions, 0);
  const clicks = mapped.reduce((t, r) => t + r.clicks, 0);
  console.log(`  ${uniq.size.toLocaleString()} distinct queries · ` +
              `${imps.toLocaleString()} impressions · ${clicks.toLocaleString()} clicks`);
  if (!uniq.size) console.log('  nothing returned — check GSC_SITE names the property exactly.');
} catch (e) {
  const m = String(e.message || e);
  console.error('failed: ' + m.slice(0, 300));
  if (m.includes('403')) console.error(
    '403 usually means the service account is not a user on this property.\n' +
    'Search Console -> Settings -> Users and permissions -> add the client_email\n' +
    'from GA_SA_KEY with Full or Restricted access.');
  if (m.includes('404')) console.error(
    '404 means GSC_SITE does not match a property on this account. A domain\n' +
    'property is "sc-domain:example.com"; a URL-prefix one is "https://example.com/".');
  process.exit(1);
}
