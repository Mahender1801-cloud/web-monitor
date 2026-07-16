# Which file goes where (read this before pasting)

There is exactly ONE file for the storefront collector:

## `webvitals.js`  → Shopify → Online Store → Themes → Edit code → **Assets → webvitals.js**
Copy from the RAW url (never the GitHub preview page):
https://raw.githubusercontent.com/Mahender1801-cloud/web-monitor/main/webvitals.js

✅ Correct paste starts with:   `import { onLCP, onCLS, onINP, onFCP, onTTFB }`
❌ If it starts with `<script`  → WRONG. That breaks tracking completely
   (Shopify reports: "The JSX syntax extension is not currently enabled").

Keep this one line in `theme.liquid` (before `</body>`), and re-add it after any dev deploy:
```
<script type="module" src="{{ 'webvitals.js' | asset_url }}"></script>
```

## `shopify-purchase-pixel.js` → Shopify → Settings → **Customer events → custom pixel**
NOT a theme file. The checkout/thank-you page doesn't run theme code.

## SQL files → Supabase → SQL Editor
- `apply_all.sql`    (already run)
- `apply_all_2.sql`  (already run)

---
### How to verify the collector is healthy
Open: https://hashtageyewears.com/cdn/shop/t/41/assets/webvitals.js
- Must NOT contain "Minification failed"
- Must contain `timeOnPage` and `gaClientId`
- Timer line should read `setTimeout(flush, 600000)`
