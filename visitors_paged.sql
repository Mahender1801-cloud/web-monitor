-- ============================================================================
-- Visitors list — paginated over the WHOLE window, not just the top 150.
-- Run in Supabase -> SQL Editor.
--
-- The tab could only ever show 150 visitors, and worse, the four tiles above the
-- list were computed from those 150 rows — so the page showed "Visitors 150" at
-- the top and "42,857" in the behaviour section. Same page, two different answers.
--
-- Rendering 40k+ rows at once would lock up the browser, so the list is paged:
-- this returns one page plus the true total, and the tiles now read from
-- visitor_report() (the real figures for the window).
-- ============================================================================
create or replace function public.recent_visitors(
  p_from timestamptz, p_to timestamptz,
  p_limit int default 200, p_offset int default 0
) returns json language plpgsql stable
set statement_timeout = '25s'
as $$
declare result json;
begin
  with w as materialized (
    select
      coalesce(nullif(ga_client_id,''), session_id) as k,
      (ga_client_id is not null and ga_client_id <> '') as has_ga,
      created_at, path, device, referrer, coalesce(time_on_page,0) as top
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
      and coalesce(nullif(ga_client_id,''), session_id) is not null
  ),
  agg as (
    select k,
      bool_or(has_ga)                                    as has_ga,
      count(*)                                           as pages,
      sum(top)                                           as engaged,
      min(created_at)                                    as first_seen,
      max(created_at)                                    as last_seen,
      (array_agg(device   order by created_at))[1]       as device,
      (array_agg(nullif(referrer,'') order by created_at)
         filter (where nullif(referrer,'') is not null))[1] as referrer,
      (array_agg(path     order by created_at))[1]       as entry_path,
      (array_agg(path     order by created_at desc))[1]  as exit_path
    from w group by k
  ),
  page as (
    select * from agg order by last_seen desc limit p_limit offset p_offset
  )
  select json_build_object(
    'total', (select count(*) from agg),
    'limit', p_limit,
    'offset', p_offset,
    'rows',  (select coalesce(json_agg(json_build_array(
                 k, case when has_ga then 'ga' else 'sid' end, pages, engaged,
                 first_seen, last_seen, device, referrer, entry_path, exit_path
               ) order by last_seen desc), '[]'::json) from page)
  ) into result;
  return result;
end;
$$;
grant execute on function public.recent_visitors(timestamptz, timestamptz, int, int) to anon;

-- Verify:
--   select public.recent_visitors(now() - interval '7 days', now(), 200, 0) -> 'total';
