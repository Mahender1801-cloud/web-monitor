# Hashtag Eyewear — Site Monitor

Free, real-time monitoring for hashtageyewears.com. No paid tiers, no credit card.

**Stack:** Supabase (database + realtime) · GitHub Pages (dashboard host) · GitHub Actions (5×/day scheduler) · PageSpeed Insights API (Web Vitals).

```
 visitor's browser ──(collector-snippet)──▶  Supabase.rum_events
                                                  ▲   │
 GitHub Actions (5×/day) ──(check.mjs)──▶ psi_results, task_checks
                                                      │ realtime
                                              index.html (GitHub Pages)
```

---

## Why not Vercel?
You asked about Vercel. Two blockers on its **free** Hobby tier: (1) its cron only fires **once per day**, so 5×/day is impossible, and (2) Hobby forbids **commercial** use — your store is a business. GitHub Pages (static, commercial-OK) + GitHub Actions (any schedule, free) avoids both. If you ever want Vercel, it works, but on the paid plan.

---

## Setup (about 20 minutes)

### 1. Supabase (the database)
1. Create a free account at supabase.com → **New project** (no card). Pick a region near India (Mumbai/Singapore).
2. Open **SQL Editor → New query**, paste all of `supabase_schema.sql`, **Run**. This creates the tables, security rules, your monitored URLs, and the full QA checklist.
3. **Database → Replication** (or Table editor → each table → Realtime toggle): turn **Realtime ON for `rum_events`** so the Live tab streams.
4. **Project Settings → API**, copy three values:
   - Project URL (`https://xxxx.supabase.co`)
   - `anon` public key — safe to expose, goes in the collector + dashboard
   - `service_role` key — **secret**, goes only in GitHub Actions

### 2. Collector (fix the data at the source)
Open `collector-snippet.html`, replace `SUPABASE_URL` and `SUPABASE_ANON_KEY`. In Shopify: **Online Store → Themes → Edit code → theme.liquid**, paste the whole `<script>` block **just before `</body>`**. Remove your old web-vitals snippet + the Apps Script — this replaces both.

> This is the actual fix for "data not coming through": one clean row per pageview, real column mapping, and a `raw` JSON copy so nothing is ever lost.

### 3. Dashboard (GitHub Pages)
1. Create a GitHub repo, upload every file here.
2. **Settings → Pages → Source: Deploy from branch → main → /(root)**. Your dashboard is live at `https://<you>.github.io/<repo>/`.
3. Open it → **Connect** → paste Project URL + anon key (+ optional PageSpeed key). It stores them in your browser and goes live.
   - To skip the button, hardcode them in `index.html` at `let CONFIG = {...}` before uploading.

### 4. Scheduler (GitHub Actions, 5×/day)
In the repo: **Settings → Secrets and variables → Actions → New repository secret**, add:
- `SUPABASE_URL` — your project URL
- `SUPABASE_SERVICE_KEY` — the **service_role** key
- `PSI_KEY` — a free PageSpeed key (optional; console.cloud.google.com → enable *PageSpeed Insights API* → create API key). Raises quota; not required.

The workflow in `.github/workflows/monitor.yml` runs at ~09/12/15/18/21 IST and can be run any time from the **Actions** tab → *Site monitor* → **Run workflow**.

### 5. (Optional) PageSpeed key in the dashboard
Same key in the Connect box lets the **Run PageSpeed now** buttons work without hitting the anonymous rate limit.

---

## The four dashboards
- **Summary** — real-user p75 for LCP/INP/CLS/FCP/TTFB, trend, device split, slowest paths (from your visitors).
- **Web Vitals** — **live** per-page p75 from your own visitors (the beacon), laid out like your reference image. Below it, a **PageSpeed cross-check** (28-day field average + synthetic lab) for validation only — it is *not* live and will always lag the real-user table.
- **Live Data** — raw events streaming in with filters and a raw-JSON view of exactly what landed in the DB.
- **QA Tasks** — the 10 categories. Each item is **AUTO** (scripted, runs 5×/day) or **MANUAL** (you toggle after eyeballing).

## What's honestly automatable
Live Web Vitals come **only** from the in-page beacon (real users, real time). PageSpeed is a periodic cross-check — its field numbers are a 28-day rolling cache, so it validates the live data, it doesn't replace it. Real scripted checks: page load speed & HTTP status, Core Web Vitals cross-check (PageSpeed), SSL days-left, robots.txt + sitemap.xml, meta title/description, canonical tag, JSON-LD schema, policy pages, sampled broken links. Everything visual/subjective (banner looks right, mega-menu UX, variant selection, checkout redirect) stays **MANUAL** — the dashboard tracks those as toggles rather than pretending to test them. The browser **Run** buttons can refresh PageSpeed instantly; the server-only probes refresh on the 5×/day schedule (browsers can't fetch other sites' headers/SSL directly).

## Security note (v1)
The dashboard reads with the public anon key and, for convenience, lets anyone with the URL add monitors and toggle manual checks. Keep the Pages URL private, or later turn on Supabase Auth and scope the RLS policies to your email. The `service_role` key stays only in GitHub secrets — never put it in the dashboard or collector.

## Keeping Supabase awake
Free projects pause after 7 days of **no** database activity. Live store traffic (RUM inserts) and the 5×/day job keep it awake automatically — no action needed while the site gets visitors.
