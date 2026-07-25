// ============================================================================
// One-time Shopify OAuth for the Dev-Dashboard app — Vercel serverless function.
//
// WHY: stores migrated to Shopify's Dev Dashboard no longer expose a `shpat_`
// custom-app token. The only way to get an Admin API token is the OAuth
// authorization-code grant with the app's Client ID + Secret. This endpoint runs
// that grant end-to-end so you never write an OAuth server yourself:
//
//   1. Visit  https://<your-vercel>/api/shopify-oauth
//   2. It redirects you to Shopify's approve screen → click Install/Approve
//   3. Shopify redirects back here with a code; we verify it and swap it for a
//      permanent (offline) Admin API access token
//   4. The token is shown once — paste it into the GitHub secret SHOPIFY_TOKEN
//
// Vercel env vars needed (set in the Vercel dashboard — the Secret never touches
// chat or git):
//   SHOPIFY_CLIENT_ID      the app's Client ID  (from the Dev Dashboard)
//   SHOPIFY_CLIENT_SECRET  the app's Secret     (paste into Vercel only)
//   SHOPIFY_SHOP           c6c623-3.myshopify.com   (your .myshopify.com handle)
//   SHOPIFY_SCOPES         optional, defaults to read_orders
//
// In the Dev Dashboard, add this exact URL to the app's Redirect URLs:
//   https://<your-vercel>/api/shopify-oauth
// ============================================================================

import crypto from 'node:crypto';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const page = (title, bodyHtml) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#1a1a1a}
code,.tok{font-family:ui-monospace,Menlo,monospace}
.tok{display:block;word-break:break-all;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:14px;margin:14px 0;font-size:13px}
.ok{color:#15803d}.err{color:#b91c1c}h1{font-size:20px}</style>${bodyHtml}`;

export default async function handler(req, res) {
  const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
  const SHOP          = process.env.SHOPIFY_SHOP;            // c6c623-3.myshopify.com
  const SCOPES        = process.env.SHOPIFY_SCOPES || 'read_orders';

  res.setHeader('Cache-Control', 'no-store');
  if (!CLIENT_ID || !CLIENT_SECRET || !SHOP) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(500).send(page('Setup needed', `<h1 class="err">Missing Vercel env vars</h1>
      <p>Set <code>SHOPIFY_CLIENT_ID</code>, <code>SHOPIFY_CLIENT_SECRET</code> and <code>SHOPIFY_SHOP</code>
      in your Vercel project settings, then reload.</p>`));
  }

  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/shopify-oauth`;
  const q = req.query || {};

  // ---- Step 1: no code yet → send the user to Shopify's approval screen -------
  if (!q.code) {
    const state = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie', `sh_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    const auth = new URL(`https://${SHOP}/admin/oauth/authorize`);
    auth.searchParams.set('client_id', CLIENT_ID);
    auth.searchParams.set('scope', SCOPES);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('state', state);       // offline (permanent) token by default
    res.writeHead(302, { Location: auth.toString() });
    return res.end();
  }

  // ---- Step 2: callback → verify state + HMAC, then exchange code for token ----
  res.setHeader('Content-Type', 'text/html');
  try {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(s => {
      const i = s.indexOf('='); return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
    }));
    if (!q.state || q.state !== cookies.sh_state)
      return res.status(400).send(page('Error', `<h1 class="err">State mismatch</h1><p>Reload <code>/api/shopify-oauth</code> and try again.</p>`));

    // HMAC: sha256 of the sorted query string (minus hmac/signature) keyed by the Secret
    const msg = Object.keys(q).filter(k => k !== 'hmac' && k !== 'signature').sort()
      .map(k => `${k}=${Array.isArray(q[k]) ? q[k].join(',') : q[k]}`).join('&');
    const digest = crypto.createHmac('sha256', CLIENT_SECRET).update(msg).digest('hex');
    const a = Buffer.from(digest), b = Buffer.from(String(q.hmac || ''));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return res.status(400).send(page('Error', `<h1 class="err">HMAC verification failed</h1><p>The callback could not be verified. Check that <code>SHOPIFY_CLIENT_SECRET</code> matches the app.</p>`));

    const shop = String(q.shop || SHOP);
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop))
      return res.status(400).send(page('Error', `<h1 class="err">Bad shop domain</h1>`));

    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: q.code })
    });
    const j = await r.json();
    if (!j.access_token)
      return res.status(500).send(page('Error', `<h1 class="err">Token exchange failed</h1><pre>${esc(JSON.stringify(j).slice(0, 400))}</pre>`));

    return res.status(200).send(page('Token ready', `<h1 class="ok">✓ Access token created</h1>
      <p>Copy this and paste it into the GitHub secret <code>SHOPIFY_TOKEN</code>
      (repo → Settings → Secrets and variables → Actions). It's shown only once.</p>
      <div class="tok">${esc(j.access_token)}</div>
      <p style="color:#666;font-size:13px">Scopes granted: <code>${esc(j.scope || SCOPES)}</code> · shop <code>${esc(shop)}</code>.
      This is a permanent offline token — it keeps working until the app is uninstalled.</p>`));
  } catch (e) {
    return res.status(500).send(page('Error', `<h1 class="err">Unexpected error</h1><pre>${esc(e.message)}</pre>`));
  }
}
