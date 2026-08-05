-- ============================================================================
-- Fix: every priority showed the same rupee figure.  Run in Supabase -> SQL Editor.
--
-- priorities() handed each failing speed item a flat 25% of the revenue gap, so
-- nine different problems all read "₹6,632". That is not an estimate, it is the
-- same number printed nine times, and it made the column worthless.
--
-- Each check now carries a measured severity weight (0-1) written by the audit
-- itself — the share of images that are not lazy, how far page weight exceeds a
-- sane budget, and so on. The revenue gap is apportioned across the failing items
-- in proportion to those weights, so the numbers differ and the split is traceable
-- back to something measured.
--
-- This is an apportionment, not a measurement, and the UI now says so.
-- ============================================================================
alter table public.optimize_audit add column if not exists weight numeric;

create or replace function public.priorities(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '30s'
as $$
declare result json; sr json; aov numeric; lost numeric; slow_sessions bigint;
begin
  select public.speed_revenue(p_from, p_to) into sr;
  aov  := coalesce((sr->>'aov')::numeric, 0);
  lost := coalesce((sr->>'lost_revenue')::numeric, 0);
  slow_sessions := coalesce((sr->>'slow_sessions')::bigint, 0);

  with latest as (
    select * from public.optimize_audit
    where created_at >= (select max(created_at) - interval '20 minutes' from public.optimize_audit)
      and status <> 'pass'
  ),
  -- one row per distinct check, worst status first, keeping the heaviest weight
  dedup as (
    select distinct on (name) area, name, status, value, advice,
           coalesce(weight, case status when 'fail' then 0.5 else 0.2 end) w
    from latest
    order by name, case status when 'fail' then 0 else 1 end, coalesce(weight,0) desc
  ),
  -- only the areas whose effect on speed we can actually argue for share the money
  speedy as (select * from dedup where area in ('Images','JavaScript','CSS','Delivery')),
  tot as (select nullif(sum(w),0) s from speedy)
  select json_build_object(
    'aov', aov, 'lost_revenue', lost, 'slow_sessions', slow_sessions,
    'items', (
      select coalesce(json_agg(json_build_array(area, name, status, value, advice, money, share) order by ord, money desc nulls last), '[]'::json)
      from (
        select d.area, d.name, d.status, d.value, d.advice,
               case when d.area in ('Images','JavaScript','CSS','Delivery')
                    then round(lost * d.w / (select s from tot)) end as money,
               case when d.area in ('Images','JavaScript','CSS','Delivery')
                    then round(100.0 * d.w / (select s from tot)) end as share,
               case d.status when 'fail' then 0 else 1 end as ord
        from dedup d
        order by ord, (case when d.area in ('Images','JavaScript','CSS','Delivery')
                            then d.w else 0 end) desc
        limit 14
      ) t)
  ) into result;
  return result;
end $$;
grant execute on function public.priorities(timestamptz, timestamptz) to anon;

-- Verify — the money column should now differ per row:
--   select public.priorities(now() - interval '7 days', now());
