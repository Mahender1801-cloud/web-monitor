// ============================================================================
// PageSpeed Insights proxy.  GET /api/psi?url=…&strategy=mobile|desktop
//
// WHY: the dashboard used to call Google directly from the browser with a PSI key
// pasted into a visible field and kept in localStorage — anyone looking at the
// screen (or the network tab) could take it, and an abused key costs the owner.
// The key now lives only in the Vercel env var PSI_KEY and never reaches the client.
//
// Vercel env var: PSI_KEY   (same value as the GitHub Actions secret)
// ============================================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  let url = (req.query.url || '').trim();
  const strategy = (req.query.strategy === 'desktop') ? 'desktop' : 'mobile';
  if (!url) return res.status(400).json({ error: { message: 'Missing ?url' } });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { return res.status(400).json({ error: { message: 'Invalid URL' } }); }

  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', url);
  api.searchParams.set('strategy', strategy);
  ['performance', 'accessibility', 'best-practices', 'seo'].forEach(c => api.searchParams.append('category', c));
  const key = process.env.PSI_KEY || '';
  if (key) api.searchParams.set('key', key);

  // Lighthouse intermittently returns "Something went wrong" on heavy pages
  // (this store's homepage is ~2.8MB of HTML). One retry clears most of those.
  const run = async () => {
    const r = await fetch(api, { signal: AbortSignal.timeout(115000) });
    return r.json();
  };
  try {
    let j = await run();
    if (j.error && /something went wrong|internal|timeout/i.test(j.error.message || '')) {
      await new Promise(r => setTimeout(r, 2500));
      try { j = await run(); } catch { /* keep the first error */ }
    }
    // Pass Google's own error shape through so the client can tell quota apart
    // from a genuine audit failure, but never echo the key.
    // `keyed` tells us whether PSI_KEY was actually present on this deployment.
    // A quota error with keyed:false means the Vercel env var is missing (we fell
    // back to the tiny anonymous quota); keyed:true points at the Google project
    // instead — usually the PageSpeed Insights API not enabled on THAT project.
    if (j.error) return res.status(200).json({ error: { message: j.error.message, code: j.error.code }, keyed: !!key });
    if (!key) j._note = 'Running without a PSI key (rate limited). Set PSI_KEY in Vercel.';
    return res.status(200).json(j);
  } catch (e) {
    return res.status(200).json({ error: { message: e.message || 'PageSpeed request failed' } });
  }
}
