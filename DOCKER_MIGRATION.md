# Running the database yourself, in place of Supabase

Supabase gives you three things: Postgres, PostgREST in front of it, and HTTPS.
`docker/docker-compose.prod.yml` runs the same three. The dashboard and
`webvitals.js` cannot tell the difference, because a Supabase anon key is just
an HS256 JWT whose payload says `{"role":"anon"}` and PostgREST reads exactly
that. Same headers, same URL shape, different hostname.

## The one thing to settle before anything else

**Where does this run?**

Not on a laptop, if it is replacing Supabase. `webvitals.js` fires from your
customers' phones and the checks run on GitHub's machines. Neither can reach a
container on your desk, and the beacon does not retry — whatever it sends while
the machine is asleep or offline is gone for good. You would not know it was
missing, because missing data looks like a quiet day.

It needs a host that is always on, with a public hostname and ports 80 and 443
free. A small VPS is a few dollars a month and is the honest answer here.

If you would rather not run one: keep Supabase as the front door and use
`docker/docker-compose.yml` (the archive) behind it. That is already working and
already holds all 1.3M rows.

## Migrating

**1. Prepare the host**

Point a DNS A record at it — say `rum.hashtageyewears.com`. Caddy proves control
of that name to Let's Encrypt, so it has to resolve publicly. Ports 80 and 443
must be open and unused.

```bash
cp docker/.env.example docker/.env
```

Fill it in. For `JWT_SECRET`, paste Supabase's own (Dashboard → Settings → API →
JWT Secret). Reusing it means the anon key already live in your theme keeps
validating, so the cutover is reversible: point the URL back and everything
works again. Generate a fresh `PGPASSWORD` with `openssl rand -base64 32`.

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env up -d
```

**2. Copy Supabase across, exactly**

```bash
node scripts/db_clone.mjs --schema-only    # structure first, so you can read the errors
node scripts/db_clone.mjs                  # then structure and data
```

This uses `pg_dump`, not the row-copy in `db_sync.mjs`. The difference matters:
`db_sync.mjs` brings rows and infers their types, which is right for an archive
and useless for a replacement. It carries no functions, no RLS policies, no
triggers, no indexes. The dashboard would come up blank, because everything it
calls — `dash_stats`, `qa_day`, `rum_rollup_day`, `link_orders_by_intent` — is
a function.

Errors mentioning `supabase_admin`, `authenticator`, `pg_graphql` or `pgsodium`
are expected. Those are Supabase's own furniture and nothing here uses them.

**3. Prove it before you point anything at it**

```bash
docker exec wm-db psql -U monitor -d monitor -c \
  "select public.dash_stats(now() - interval '7 days', now())"
```

Numbers coming back means the dashboard will work. Also confirm RLS survived —
without it the anon key can delete every row:

```bash
docker exec wm-db psql -U monitor -d monitor -c \
  "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and relkind='r' and not relrowsecurity"
```

Anything listed there is unprotected. Re-run `SECURITY_rls_lockdown.sql` if so.

And from outside the host, check the certificate and CORS are real:

```bash
curl -sI https://rum.hashtageyewears.com/rest/v1/rum_daily?limit=1
```

**4. Switch the three places that name the database**

| Where | What |
|---|---|
| `webvitals.js` lines 4–5 | `SUPABASE_URL` → `https://rum.hashtageyewears.com` |
| Vercel env vars | `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| GitHub repo secrets | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` |

`webvitals.js` is the only theme file that changes, which keeps the existing
rule intact.

Do them in that order and watch the first one land before doing the rest:

```bash
docker exec wm-db psql -U monitor -d monitor -c \
  "select count(*), max(created_at) from public.rum_events_all
   where created_at > now() - interval '5 minutes'"
```

If that stays at zero after a few minutes of real traffic, the beacon is not
arriving — check the browser console on the storefront for a CORS or certificate
error, and put the old URL back while you work it out.

**5. Keep Supabase for a week**

Do not delete the project. It costs nothing to leave it, and it is your rollback
if something only shows up under real load.

## What you get that Supabase's free tier would not give

- **No pruning.** `storage_retention.sql` exists because 500 MB forced it. On
  your own disk, keep every raw event for as long as you want.
- **The `raw` column stays.** Step 4 of the retention plan was going to empty it
  to reclaim ~174 MB. It holds the full beacon payload, including the user-agent
  the bot filter reads.
- **Deeper capture becomes affordable** — per-request resource timing, long
  tasks, full error stacks. All of it was priced out before.

## Backups are now yours

Supabase did this invisibly. Nothing does it here until you say so.

```bash
docker exec wm-db pg_dump -U monitor -d monitor --format=custom \
  --file=/backups/monitor-$(date +%F).dump
```

`docker/backups` is mounted into the container. Put that in cron, and copy the
files off the host — a backup that only exists on the machine it protects is
not a backup.
