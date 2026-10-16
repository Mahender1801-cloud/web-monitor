# Running the Site Monitor off Docker (no Supabase)

Supabase was paused for non-payment, so the dashboard's cloud backend is gone.
The full data and every report now run from the local Docker archive instead.
Nothing about the dashboard changed — it just points at Docker.

## Start it (two commands)

```bash
docker compose -f docker/docker-compose.yml up -d
node scripts/local_dashboard.mjs
```

Then open **http://localhost:8899** and click **90 days** in the header.

That is it. The dashboard works exactly as before — Summary, Web Vitals,
Purchases, Visitors, Health, reports, QA — all served from the archive.

## Two things to know

- **Pick a range that has data.** The archive holds everything captured through
  **14 Sep 2026** (that is when Supabase stopped accepting writes). The dashboard
  opens on "Today", which is empty now, so click **90 days** or set a custom
  range ending 14 Sep. "90 days" shows the whole history.

- **15 Sep onward is gone, and that is not recoverable here.** Once Supabase
  paused, the beacon on the store kept posting to a dead endpoint and those
  writes failed — the beacon does not retry. That month exists only inside
  Supabase itself, reachable only by paying the outstanding invoice and
  unpausing. Everything up to 14 Sep is safe in the archive and in the GitHub
  Release backup.

## If the archive container is not running

```bash
docker start wm-archive-db wm-archive-rest
```

Check it is healthy:

```bash
docker ps --filter name=wm-archive
```

## What this is, under the hood

`scripts/local_dashboard.mjs` is a tiny server on :8899 that serves the existing
`index.html`, answers `/api/config` by pointing the dashboard at itself, and
proxies every `/rest/v1/*` call to PostgREST (`wm-archive-rest` on :3001), which
serves the archive database. Same shape Supabase presented, so the dashboard
cannot tell the difference.

The archive database holds all 14 tables plus every dashboard RPC
(`dash_stats`, `visitor_report`, `funnel_stats`, and the rest), loaded from this
repo's `.sql` files.
