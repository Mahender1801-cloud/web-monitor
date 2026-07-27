// ============================================================================
// Shopify order receiver — Vercel serverless.  POST /api/shopify-webhook?key=SECRET
//
// The NO-APP way to get every order. Shopify's built-in webhooks
// (Settings -> Notifications -> Webhooks) let the STORE ITSELF POST every new
// order here — no custom app, no Protected-Customer-Data access, no owner
// install. The full order payload (incl. landing_site / referring_site) arrives
// because it's the merchant's own webhook, not a third-party app token.
//
// Also works as the target for a Shopify FLOW "Send HTTP request" action — both
// send order JSON; we authenticate with a shared secret in the ?key= query param.
//
// Vercel env vars needed (set in the Vercel dashboard):
//   SUPABASE_URL          https://ijzudvwhzsnwysucyves.supabase.co
//   SUPABASE_SERVICE_KEY  the service_role key (paste into Vercel only)
//   ORDER_HOOK_SECRET     any long random string; must match ?key= in the webhook URL
//
// Note: fires on NEW orders going forward (no historical backfill).
// ============================================================================

const numId = v => { const m = String(v ?? '').match(/(\d+)/); return m ? +m[1] : null; };
const num   = v => { const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; };
const clip  = (v, n) => v ? String(v).slice(0, n) : null;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
  const SECRET       = process.env.ORDER_HOOK_SECRET;
  if (!SUPABASE_URL || !SERVICE_KEY || !SECRET)
    return res.status(500).json({ error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_KEY / ORDER_HOOK_SECRET on Vercel' });

  const key = req.query.key || req.headers['x-order-key'];
  if (key !== SECRET) return res.status(401).json({ error: 'bad key' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Single order (real Shopify webhook) OR an array of orders (CSV backfill).
  const list = Array.isArray(body) ? body : (Array.isArray(body.orders) ? body.orders : [body]);
  const rows = list.map(toRow).filter(r => r.id != null);
  if (!rows.length) return res.status(400).json({ error: 'no valid order id in payload' });

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/shop_orders?on_conflict=id`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY,
                 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
    if (!r.ok) return res.status(502).json({ error: 'supabase ' + r.status, detail: (await r.text()).slice(0, 300) });
    return res.status(200).json({ ok: true, upserted: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Map one order (REST webhook shape OR flat backfill shape) to a shop_orders row.
function toRow(o) {
  o = o || {};
  const id = numId(o.id ?? o.order_id ?? o.admin_graphql_api_id);
  const items = Array.isArray(o.line_items)
    ? o.line_items.reduce((a, li) => a + (+li.quantity || 0), 0)
    : num(o.subtotalLineItemsQuantity ?? o.items);
  return {
    id,
    order_number: o.name ?? o.order_number ?? null,
    created_at: o.created_at ?? o.createdAt ?? new Date().toISOString(),
    processed_at: o.processed_at ?? o.processedAt ?? null,
    total_price: num(o.current_total_price ?? o.total_price ?? o.totalPrice ?? o.amount),
    currency: o.currency ?? o.currencyCode ?? null,
    items: items || null,
    financial_status: (o.financial_status ?? o.displayFinancialStatus ?? '').toString().toLowerCase() || null,
    landing_site: clip((o.landing_site ?? o.landingPageUrl ?? '').split('?')[0], 300),
    referring_site: clip(o.referring_site ?? o.referrerUrl, 300),
    source_name: o.source_name ?? o.sourceName ?? null,
    raw: { via: o.__src || 'webhook', receivedAt: new Date().toISOString() }
  };
}
