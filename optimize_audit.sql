-- ============================================================================
-- Front-end optimisation audit storage + report.  Run in Supabase -> SQL Editor.
--
-- Covers the same ground a paid speed app sells (lazy images, responsive images,
-- app impact, critical CSS, fonts, minification, preloading, compression) but as
-- an AUDIT: it measures the store and says what to change. It never edits the
-- theme, which is why only webvitals.js ever needs to be touched.
-- ============================================================================
create table if not exists public.optimize_audit (
  id         bigserial primary key,
  page       text,
  area       text,      -- Images | JavaScript | CSS | Fonts | Delivery
  name       text,
  status     text,      -- pass | warn | fail
  value      text,      -- the measurement behind the verdict
  advice     text,
  created_at timestamptz not null default now()
);
create index if not exists opt_audit_created_idx on public.optimize_audit (created_at desc);
alter table public.optimize_audit enable row level security;
drop policy if exists sel_opt_audit on public.optimize_audit;
create policy sel_opt_audit on public.optimize_audit for select to anon using (true);

-- ---------------------------------------------------------------------------
-- Latest run, grouped so the dashboard can lead with what is worth fixing.
-- ---------------------------------------------------------------------------
create or replace function public.optimize_report()
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json; run timestamptz;
begin
  select max(created_at) into run from public.optimize_audit;
  if run is null then return '{}'::json; end if;

  with latest as (
    select * from public.optimize_audit where created_at >= run - interval '20 minutes'
  ),
  byarea as (
    select area,
           count(*) n,
           count(*) filter (where status='pass') pass,
           count(*) filter (where status='warn') warn,
           count(*) filter (where status='fail') fail
    from latest group by area
  )
  select json_build_object(
    'run_at', run,
    'pages',  (select count(distinct page) from latest),
    'checks', (select count(*) from latest),
    'pass',   (select count(*) filter (where status='pass') from latest),
    'warn',   (select count(*) filter (where status='warn') from latest),
    'fail',   (select count(*) filter (where status='fail') from latest),
    'score',  (select round(count(*) filter (where status='pass')::numeric
                            / nullif(count(*),0) * 100) from latest),
    'areas',  (select coalesce(json_agg(json_build_array(area, n, pass, warn, fail) order by fail desc, warn desc), '[]'::json) from byarea),
    -- one row per distinct check, worst page first, so the same issue across three
    -- templates does not read as three separate problems
    'issues', (select coalesce(json_agg(json_build_array(area, name, status, value, advice, page) order by ord, area, name), '[]'::json)
               from (
                 select distinct on (area, name) area, name, status, value, advice, page,
                        case status when 'fail' then 0 when 'warn' then 1 else 2 end ord
                 from latest
                 where status <> 'pass'
                 order by area, name, case status when 'fail' then 0 when 'warn' then 1 else 2 end
               ) t),
    'passing', (select coalesce(json_agg(json_build_array(area, name, value) order by area, name), '[]'::json)
               from (select distinct on (area, name) area, name, value from latest
                     where status='pass' order by area, name) t)
  ) into result;
  return result;
end $$;
grant execute on function public.optimize_report() to anon;

-- Verify:  select public.optimize_report();
