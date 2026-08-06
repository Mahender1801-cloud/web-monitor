-- ============================================================================
-- The last 32 manual QA tasks: 31 automated.  Run ONCE in Supabase -> SQL Editor.
-- Idempotent: safe to re-run.
--
-- qa_automation.sql automated everything that could be judged by reading HTML.
-- What was left needed a browser: menus that only exist after JavaScript runs,
-- filters, infinite scroll, variant images, the cart drawer, discount codes,
-- keyboard focus, layout that only breaks at a real viewport width. 31 of the
-- 32 are now driven by scripts/qa_browser.mjs in a real Chromium (plus WebKit
-- and Firefox for the cross-browser task), so they are marked auto here.
--
-- auto_key is 'browser' for every one of them. check.mjs deliberately returns
-- nothing for that key — it cannot answer these questions, and a guess would be
-- worse than a gap. The browser run fills them in instead, writing to the same
-- task_checks table under the same category+item names.
-- ============================================================================

update public.task_items set check_type = 'auto', auto_key = 'browser'
where (category, item) in (
  -- Homepage: menu links resolved and clicked, layout measured at 390px
  ('Homepage Testing',                     'Test mega menu and navigation links'),
  ('Homepage Testing',                     'Verify homepage sections alignment'),

  -- Search: sort/filter controls actually applied, results re-counted
  ('Search Page Testing',                  'Check search filters / sorting'),

  -- Collection: every one of these needs the grid to have rendered
  ('Collection Page Testing',              'Verify filters / sorting working properly'),
  ('Collection Page Testing',              'Check product cards alignment'),
  ('Collection Page Testing',              'Verify wishlist / cart buttons'),
  ('Collection Page Testing',              'Test pagination or infinite scroll'),
  ('Collection Page Testing',              'Check breadcrumb navigation'),
  ('Collection Page Testing',              'Verify "no products found" empty state'),
  ('Collection Page Testing',              'Check out-of-stock product display logic'),

  -- Product: page state is compared against products.json, not against itself
  ('Product Page Testing',                 'Check product images & variant images'),
  ('Product Page Testing',                 'Verify Add to Cart & Buy Now buttons'),
  ('Product Page Testing',                 'Test variant selection'),
  ('Product Page Testing',                 'Ensure no broken layout on mobile'),
  ('Product Page Testing',                 'Check breadcrumb navigation'),
  ('Product Page Testing',                 'Verify stock/inventory status'),
  ('Product Page Testing',                 'Check sale price / compare-at price display'),
  ('Product Page Testing',                 'Verify related / upsell / cross-sell'),
  ('Product Page Testing',                 'Test sticky Add to Cart on scroll (mobile)'),

  -- Cart: real add / update / remove, verified against /cart.js rather than
  -- against what the page claims. Stops at the checkout handoff.
  ('Cart & Checkout Testing',              'Add product to cart'),
  ('Cart & Checkout Testing',              'Verify corner cart / drawer cart working'),
  ('Cart & Checkout Testing',              'Test Shiprocket checkout redirect'),
  ('Cart & Checkout Testing',              'Check discount codes'),
  ('Cart & Checkout Testing',              'Verify payment methods visibility'),
  ('Cart & Checkout Testing',              'Test Partial COD / prepaid logic'),
  ('Cart & Checkout Testing',              'Update quantity / remove item'),
  ('Cart & Checkout Testing',              'Check empty cart state'),
  ('Cart & Checkout Testing',              'Verify guest checkout option'),
  ('Cart & Checkout Testing',              'Check shipping cost calculation display'),
  -- NOTE: 'Test address & pincode serviceability' is deliberately absent. See
  -- the note at the foot of this file.

  -- Cross-browser: Chromium covers Chrome and Edge, WebKit is Safari,
  -- Gecko is Firefox. Every engine the task names is genuinely loaded.
  ('Cross-Browser & Accessibility Testing','Test on Chrome / Safari / Firefox / Edge'),
  ('Cross-Browser & Accessibility Testing','Check keyboard nav / screen reader basics')
);

-- ---------------------------------------------------------------------------
-- The one task left manual, and why.
--
-- 'Test address & pincode serviceability' stays check_type='manual' on purpose.
-- Proving a pincode is serviceable means typing a real delivery address into
-- the live Shiprocket checkout — which can create a real order and real
-- customer data, twice a day, forever. That is a worse outcome than a checkbox.
--
-- The browser run still covers it: it walks the cart to the checkout handoff
-- and writes a task_checks row with status 'manual' saying exactly how far it
-- got. Because the item is still typed manual, the Pass / Attention buttons
-- stay on the row, so the one thing a person must do is still one click.
-- ---------------------------------------------------------------------------
-- Verify. Expect: 1 manual, 57 auto.
--   select check_type, count(*) from public.task_items group by 1;
--
-- And to see the browser-driven set specifically:
--   select category, item from public.task_items
--   where auto_key = 'browser' order by category, sort;
-- ---------------------------------------------------------------------------
