-- ============================================================================
-- ONLY the visitor_report function. channel_detail already exists, so run just
-- this block if the earlier file stopped partway.
-- Paste ALL of it into Supabase -> SQL Editor -> Run.
-- ============================================================================
create or replace function public.visitor_report(p_from timestamptz, p_to timestamptz)
returns json
language plpgsql
stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select
      coalesce(nullif(ga_client_id, ''), session_id) as vkey,
      path,
      device,
      coalesce(time_on_page, 0) as dwell,
      created_at,
      (ga_client_id is not null and ga_client_id <> '') as has_ga
    from public.rum_events
    where created_at >= p_from
      and created_at <= p_to
      and coalesce(nullif(ga_client_id, ''), session_id) is not null
  ),
  per as (
    select
      vkey,
      count(*)                                        as pages,
      sum(dwell)                                      as engaged,
      bool_or(has_ga)                                 as identified,
      (array_agg(device order by created_at))[1]      as dev,
      (array_agg(path   order by created_at))[1]      as entry_page,
      (array_agg(path   order by created_at desc))[1] as exit_page
    from w
    group by vkey
  )
  select json_build_object(
    'visitors',    (select count(*) from per),
    'views',       (select count(*) from w),
    'identified',  (select count(*) from per where identified),
    'multipage',   (select count(*) from per where pages > 1),
    'bounced',     (select count(*) from per where pages = 1),
    'deep',        (select count(*) from per where pages >= 5),
    'engaged_avg', (select round(avg(engaged) / 1000.0, 1) from per),
    'pages_avg',   (select round(avg(pages), 2) from per),
    'by_device',   (select coalesce(json_agg(json_build_array(kk, cc) order by cc desc), '[]'::json)
                    from (select coalesce(nullif(dev, ''), 'other') kk, count(*) cc
                          from per group by 1) t1),
    'top_entry',   (select coalesce(json_agg(json_build_array(pp, cc) order by cc desc), '[]'::json)
                    from (select entry_page pp, count(*) cc
                          from per group by entry_page order by count(*) desc limit 12) t2),
    'top_exit',    (select coalesce(json_agg(json_build_array(pp, cc) order by cc desc), '[]'::json)
                    from (select exit_page pp, count(*) cc
                          from per group by exit_page order by count(*) desc limit 12) t3)
  ) into result;
  return result;
end;
$$;

grant execute on function public.visitor_report(timestamptz, timestamptz) to anon;

-- Verify (should return a JSON object, not an error):
--   select public.visitor_report(now() - interval '1 day', now());
