/* ============================================================================
   Hashtag Eyewear — purchase tracker (Shopify CUSTOM PIXEL)
   ============================================================================
   WHERE THIS GOES  (this is NOT a theme file):
     Shopify admin → Settings → Customer events → Add custom pixel
       • Name: "Web Monitor purchases"
       • Permission: "Not required" (we store no personal data — no email/name)
       • Paste this whole file → Save → Connect

   WHY A PIXEL, NOT THE THEME:
     Shopify's checkout/thank-you page does not run theme code, so webvitals.js
     never sees the purchase. Custom pixels DO run there.

   WHAT IT DOES:
     On checkout_completed it posts the order to Supabase with GA4's client id,
     so the sale can be joined to the same visitor whose page speed we measured:
       purchases.ga_client_id  <->  rum_events.ga_client_id

   Requires user_tracking.sql to have been run (creates public.purchases).
   ========================================================================== */

const SUPABASE_URL = 'https://ijzudvwhzsnwysucyves.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlqenVkdndoenNud3lzdWN5dmVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5MzA1MDYsImV4cCI6MjA5OTUwNjUwNn0.i59l07obJhiKt-RND4FEsETKpVUsvQiVGYxDYt5K0Cw';

analytics.subscribe('checkout_completed', async (event) => {
  try {
    const c = (event.data && event.data.checkout) || {};

    // Shopify's pixel sandbox has no document.cookie — it exposes browser.cookie.
    let gaClientId = null, gaSessionId = null;
    try {
      const ga = await browser.cookie.get('_ga');                 // GA1.1.<clientId>
      const gs = await browser.cookie.get('_ga_NG5J2LV3F5');      // GS1.1.<sessionId>...
      if (ga) gaClientId = ga.split('.').slice(-2).join('.') || null;
      if (gs) gaSessionId = gs.split('.')[2] || null;
    } catch (e) { /* cookies unavailable — still record the order */ }

    const order = c.order || {};
    const body = {
      // GA4 calls this transaction_id; Shopify's order id is what GA sends.
      transaction_id: String(order.id || c.token || ''),
      order_number: String(order.id || ''),
      value: c.totalPrice ? Number(c.totalPrice.amount) : null,
      currency: c.currencyCode || null,
      items: Array.isArray(c.lineItems) ? c.lineItems.length : null,
      ga_client_id: gaClientId,
      ga_session_id: gaSessionId,
      landing_page: (event.context && event.context.document && event.context.document.referrer) || null,
      // deliberately NO email / name / address — keeps this non-PII
      raw: { at: new Date().toISOString(), src: 'shopify_pixel' }
    };
    if (!body.transaction_id) return;

    fetch(SUPABASE_URL + '/rest/v1/purchases', {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Prefer': 'return=minimal,resolution=ignore-duplicates'
      },
      body: JSON.stringify(body)
    }).catch(() => {});
  } catch (e) { /* never break checkout */ }
});
