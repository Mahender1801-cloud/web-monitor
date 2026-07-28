-- ============================================================================
-- Visitor deep-dive: per-channel drill-down + an overall visitor report.
-- Powers the clickable funnel on the Visitors tab. Run in SQL Editor.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) One channel in depth: who they are, what they saw, how engaged, did they buy.
--    p_channel matches the value returned by traffic_channel().
-- ---------------------------------------------------------------------------
create or replace function public.channel_detail(
  p_from timestamptz, p_to timestamptz, p_channel text
) returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select coalesce(nullif(ga_client_id,''), session_id) k,
           session_id, path, device, lcp, coalesce(time_on_page,0) top, created_at
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
      and coalesce(nullif(ga_client_id,''), session_id) is not null
      and public.traffic_channel(referrer, utm_source, utm_medium, gclid, fbclid) = p_channel
  ),
  per as (   -- one row per visitor
    select k, count(*) pages, sum(top) engaged,
           (array_agg(device order by created_at))[1] device,
           (array_agg(path   order by created_at))[1] entry
    from w group by k
  )
  select json_build_object(
    'channel',   p_channel,
    'visitors',  (select count(*) from per),
    'views',     (select count(*) from w),
    'pages_avg', (select round(avg(pages),2) from per),
    'engaged_avg',(select round(avg(engaged)/1000.0,1) from per),
    'bounced',   (select count(*) from per where pages = 1),
    'lcp_p75',   (select percentile_cont(0.75) within group (order by lcp) from w where lcp is not null),
    'by_device', (select coalesce(json_agg(json_build_array(k2,c) order by c desc),'[]'::json)
                    from (select coalesce(nullif(device,''),'other') k2, count(*) c from per group by 1) t),
    'top_entry', (select coalesce(json_agg(json_build_array(entry,c) order by c desc),'[]'::json)
                    from (select entry, count(*) c from per group by entry order by count(*) desc limit 10) t),
    'top_pages', (select coalesce(json_agg(json_build_array(path,c) order by c desc),'[]'::json)
                    from (select path, count(*) c from w group by path order by count(*) desc limit 10) t),
    'orders',    (select count(*) from public.shop_orders o
                    where o.created_at >= p_from and o.created_at <= p_to
                      and o.order_number not ilike 'R-%' and o.order_number not ilike 'E-%'
                      and (o.rum_session in (select session_id from w)
                        or o.ga_client_id in (select k from per)))
  ) into result;
  return result;
end;
$$;
grant execute on function public.channel_detail(timestamptz, timestamptz, text) to anon;

-- ---------------------------------------------------------------------------
-- 2) Overall visitor report — the numbers the Visitors tab summarises.
-- ---------------------------------------------------------------------------
create or replace function public.visitor_report(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select coalesce(nullif(ga_client_id,''), session_id) k,
           path, device, coalesce(time_on_page,0) top, created_at,
           (ga_client_id is not null and ga_client_id <> '') has_ga
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
      and coalesce(nullif(ga_client_id,''), session_id) is not null
  ),
  per as (
    select k, count(*) pages, sum(top) engaged, bool_or(has_ga) has_ga,
           (array_agg(device order by created_at))[1] device,
           (array_agg(path   order by created_at))[1] entry,
           (array_agg(path   order by created_at desc))[1] exitp,
           min(created_at) first_seen, max(created_at) last_seen
    from w group by k
  )
  select json_build_object(
    'visitors',    (select count(*) from per),
    'views',       (select count(*) from w),
    'identified',  (select count(*) from per where has_ga),
    'multipage',   (select count(*) from per where pages > 1),
    'bounced',     (select count(*) from per where pages = 1),
    'engaged_avg', (select round(avg(engaged)/1000.0,1) from per),
    'pages_avg',   (select round(avg(pages),2) from per),
    'deep',        (select count(*) from per where pages >= 5),
    'by_device',   (select coalesce(json_agg(json_build_array(k2,c) order by c desc),'[]'::json)
                      from (select coalesce(nullif(device,''),'other') k2, count(*) c from per group by 1) t),
    'top_entry',   (select coalesce(json_agg(json_build_array(entry,c) order by c desc),'[]'::json)
                      from (select entry, count(*) c from per group by entry order by count(*) desc limit 12) t),
    'top_exit',    (select coalesce(json_agg(json_build_array(exitp,c) order by c desc),'[]'::json)
                      from (select exitp, count(*) c from per group by exitp order by count(*) desc limit 12) t),
    'by_hour',     (select coalesce(json_agg(json_build_array(h,c) order by h),'[]'::json)
                      from (select extract(hour from first_seen)::int h, count(*) c from per group by 1) t)
  ) into result;
  return result;
end;
$$;
grant execute on function public.visitor_report(timestamptz, timestamptz) to anon;

-- Verify:
--   select public.visitor_report(now() - interval '1 day', now());
--   select public.channel_detail(now() - interval '1 day', now(), 'Meta Ads');
