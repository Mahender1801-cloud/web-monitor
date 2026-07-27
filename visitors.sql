-- ============================================================================
-- Visitor explorer — recent visitors with their footprint.  Run in SQL Editor.
--
-- Groups rum_events by the persistent visitor key: ga_client_id where present
-- (a real multi-page journey), else session_id (a single visit). Returns, per
-- visitor: pages seen, engaged time, device, entry source/page, first/last seen.
-- Powers the "Visitors" tab; each row drills into the full page-by-page journey.
-- ============================================================================
create or replace function public.recent_visitors(
  p_from timestamptz, p_to timestamptz, p_limit int default 100
) returns json language plpgsql stable
set statement_timeout = '20s'
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
      bool_or(has_ga) as has_ga,
      count(*) as pages,
      sum(top) as engaged,
      min(created_at) as first_seen,
      max(created_at) as last_seen,
      (array_agg(device   order by created_at))[1] as device,
      (array_agg(nullif(referrer,'') order by created_at) filter (where nullif(referrer,'') is not null))[1] as referrer,
      (array_agg(path     order by created_at))[1] as entry_path,
      (array_agg(path     order by created_at desc))[1] as exit_path
    from w group by k
    order by max(created_at) desc
    limit p_limit
  )
  select coalesce(json_agg(json_build_array(
    k, case when has_ga then 'ga' else 'sid' end, pages, engaged,
    first_seen, last_seen, device, referrer, entry_path, exit_path
  ) order by last_seen desc), '[]'::json)
  into result from agg;
  return result;
end;
$$;
grant execute on function public.recent_visitors(timestamptz, timestamptz, int) to anon;

-- Verify:  select public.recent_visitors(now() - interval '2 days', now(), 50);
