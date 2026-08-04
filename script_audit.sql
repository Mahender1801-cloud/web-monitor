-- ============================================================================
-- Full script audit + history.  Run in Supabase -> SQL Editor.
--
-- Why this exists: the server-side vendor scan only saw <script src> present in
-- the initial HTML, so it reported ~6 vendors on a page that loads dozens. Most
-- Shopify apps inject themselves at runtime, so they were invisible. The synthetic
-- run now watches the network from inside a real browser and records EVERY script,
-- xhr and stylesheet — however it got there — with transfer size, timing, status
-- and whether it failed.
-- ============================================================================
create table if not exists public.script_audit (
  id         bigserial primary key,
  url        text not null,
  vendor     text,
  type       text,            -- script | xhr | fetch | stylesheet
  bytes      bigint,
  ms         int,
  status     int,
  failed     boolean default false,
  hits       int,
  error      text,
  created_at timestamptz not null default now()
);
create index if not exists script_audit_created_idx on public.script_audit (created_at desc);
create index if not exists script_audit_vendor_idx  on public.script_audit (vendor, created_at desc);
alter table public.script_audit enable row level security;
drop policy if exists sel_script_audit on public.script_audit;
create policy sel_script_audit on public.script_audit for select to anon using (true);

-- ---------------------------------------------------------------------------
-- Latest audit, rolled up per vendor, with the failing resources called out.
-- ---------------------------------------------------------------------------
create or replace function public.script_report()
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json; run timestamptz;
begin
  select max(created_at) into run from public.script_audit;
  if run is null then return '{}'::json; end if;

  with latest as (
    select * from public.script_audit
    where created_at >= run - interval '10 minutes'      -- one synthetic run
  ),
  byv as (
    select coalesce(vendor,'other') vendor,
           count(*) resources,
           sum(coalesce(bytes,0)) bytes,
           max(coalesce(ms,0)) slowest_ms,
           count(*) filter (where failed) failing
    from latest group by 1
  )
  select json_build_object(
    'run_at',    run,
    'resources', (select count(*) from latest),
    'bytes',     (select sum(coalesce(bytes,0)) from latest),
    'failing',   (select count(*) filter (where failed) from latest),
    'vendors',   (select coalesce(json_agg(json_build_array(vendor, resources, bytes, slowest_ms, failing)
                                           order by bytes desc nulls last), '[]'::json) from byv),
    'heaviest',  (select coalesce(json_agg(json_build_array(url, vendor, bytes, ms) order by bytes desc nulls last), '[]'::json)
                  from (select url, vendor, bytes, ms from latest
                        where coalesce(bytes,0) > 0 order by bytes desc limit 15) t),
    'slowest',   (select coalesce(json_agg(json_build_array(url, vendor, ms, bytes) order by ms desc nulls last), '[]'::json)
                  from (select url, vendor, ms, bytes from latest
                        where coalesce(ms,0) > 0 order by ms desc limit 15) t),
    'broken',    (select coalesce(json_agg(json_build_array(url, vendor, status, error)), '[]'::json)
                  from (select url, vendor, status, error from latest where failed order by url limit 25) t)
  ) into result;
  return result;
end $$;
grant execute on function public.script_report() to anon;

-- ---------------------------------------------------------------------------
-- Health, this period vs the one before it — the comparison that was missing.
-- ---------------------------------------------------------------------------
create or replace function public.health_compare(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json; span interval;
begin
  span := p_to - p_from;
  with cur as (
    select kind, count(*) n from public.health_events
    where created_at >= p_from and created_at <= p_to group by kind
  ),
  prev as (
    select kind, count(*) n from public.health_events
    where created_at >= p_from - span and created_at < p_from group by kind
  ),
  k as (select kind from cur union select kind from prev)
  select json_build_object(
    'window_hours', round(extract(epoch from span)/3600),
    'kinds', (select coalesce(json_agg(json_build_array(
                 k.kind, coalesce(c.n,0), coalesce(p.n,0)) order by coalesce(c.n,0) desc), '[]'::json)
              from k left join cur c on c.kind=k.kind left join prev p on p.kind=k.kind),
    'synthetic', (select json_build_object(
                    'now_ok',  count(*) filter (where ok and created_at >= p_from),
                    'now_n',   count(*) filter (where created_at >= p_from),
                    'prev_ok', count(*) filter (where ok and created_at < p_from),
                    'prev_n',  count(*) filter (where created_at < p_from))
                  from public.synthetic_runs
                  where created_at >= p_from - span and created_at <= p_to),
    'checkout', json_build_object(
        'now',  public.checkout_health(p_from, p_to),
        'prev', public.checkout_health(p_from - span, p_from))
  ) into result;
  return result;
end $$;
grant execute on function public.health_compare(timestamptz, timestamptz) to anon;

-- Verify:
--   select public.script_report();
--   select public.health_compare(now() - interval '7 days', now());
