-- ============================================================================
-- ⚠ RUN THIS FIRST — CRITICAL.  Supabase -> SQL Editor -> Run.
--
-- The public anon key currently allows DESTRUCTIVE writes. Verified live:
--     DELETE /rum_events   -> 204   (anyone can wipe all traffic data)
--     DELETE /shop_orders  -> 204   (anyone can wipe all 36k orders)
--     PATCH  /shop_orders  -> 204   (anyone can rewrite order values)
--     POST   /monitors     -> 201   (anyone can inject rows)
--
-- This matters far more than the key being visible in the page. The anon key is
-- PUBLIC BY DESIGN — any browser dashboard must ship it, and hiding it in a build
-- secret does not help because it is still in the delivered JavaScript. What is
-- supposed to make that safe is Row Level Security, and right now RLS is not
-- restricting writes. This file fixes that.
--
-- After this: the browser can only (a) insert telemetry and (b) read what the
-- dashboard displays. It cannot update or delete anything. The GitHub Action keeps
-- full access because it uses the service_role key, which bypasses RLS.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper: reset every policy on a table, then grant exactly what's needed.
-- ---------------------------------------------------------------------------
do $$
declare t text; p text;
begin
  foreach t in array array['rum_events','funnel_events','shop_orders','purchases',
                           'monitors','psi_results','task_items','task_checks',
                           'web_scores','ga_daily','rum_daily']
  loop
    if to_regclass('public.'||t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname='public' and tablename=t
    loop
      execute format('drop policy %I on public.%I', p, t);
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1) Telemetry the collector must be able to write (insert only — never read
--    back, never modify). A visitor's browser only ever appends its own events.
-- ---------------------------------------------------------------------------
create policy anon_insert_rum    on public.rum_events    for insert to anon with check (true);
create policy anon_insert_funnel on public.funnel_events for insert to anon with check (true);
create policy anon_insert_buy    on public.purchases     for insert to anon with check (true);

-- ---------------------------------------------------------------------------
-- 2) Read access for the dashboard. SELECT only — no update, no delete.
--    (Aggregate RPCs run as the caller, so they need these too.)
-- ---------------------------------------------------------------------------
create policy anon_read_rum      on public.rum_events    for select to anon using (true);
create policy anon_read_funnel   on public.funnel_events for select to anon using (true);
create policy anon_read_orders   on public.shop_orders   for select to anon using (true);
create policy anon_read_buy      on public.purchases     for select to anon using (true);
create policy anon_read_monitors on public.monitors      for select to anon using (true);
create policy anon_read_psi      on public.psi_results   for select to anon using (true);
create policy anon_read_items    on public.task_items    for select to anon using (true);
create policy anon_read_checks   on public.task_checks   for select to anon using (true);
create policy anon_read_daily    on public.rum_daily     for select to anon using (true);

do $$ begin
  if to_regclass('public.ga_daily')   is not null then
    execute 'create policy anon_read_ga on public.ga_daily for select to anon using (true)'; end if;
  if to_regclass('public.web_scores') is not null then
    execute 'create policy anon_read_ws  on public.web_scores for select to anon using (true)';
    -- Web Score is an interactive tool: the dashboard saves scores you run.
    execute 'create policy anon_insert_ws on public.web_scores for insert to anon with check (true)'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3) Monitors are edited from the dashboard (add / remove a page). Keep that
--    working, but nothing else is writable.
--    If you would rather manage monitors only from the DB, delete these two.
-- ---------------------------------------------------------------------------
create policy anon_insert_monitors on public.monitors for insert to anon with check (true);
create policy anon_delete_monitors on public.monitors for delete to anon using (true);

-- ---------------------------------------------------------------------------
-- 4) Belt and braces: revoke UPDATE/DELETE at the GRANT level too, so a missing
--    policy can never silently re-open a destructive path.
-- ---------------------------------------------------------------------------
revoke update, delete on public.rum_events, public.funnel_events, public.shop_orders,
                         public.purchases, public.psi_results, public.task_items,
                         public.task_checks, public.rum_daily
  from anon;

-- ---------------------------------------------------------------------------
-- VERIFY — after running, these must all be blocked (401/403), not 204:
--   curl -X DELETE ".../rest/v1/shop_orders?id=eq.-1" -H "apikey: <anon>" ...
--   curl -X DELETE ".../rest/v1/rum_events?id=eq.-1"  -H "apikey: <anon>" ...
-- And these must still work: dashboard loads, collector inserts.
-- ---------------------------------------------------------------------------
select tablename, policyname, cmd, roles
from pg_policies where schemaname = 'public' order by tablename, cmd;
