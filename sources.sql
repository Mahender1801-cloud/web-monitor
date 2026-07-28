-- ============================================================================
-- Traffic sources — how visitors arrive (Meta Ads, Instagram, search, shared…).
--
-- Uses the SHARED public.traffic_channel() classifier (defined in rollup.sql /
-- traffic_perf_fix.sql) so the Visitors tab and the Summary "Traffic source" card
-- always agree. An earlier version classified on `referrer` alone here, which
-- ignored utm_source/utm_medium/gclid/fbclid — paid Meta and Google Ads traffic
-- was mislabelled as plain Instagram/Facebook/Direct in this view only.
--
-- Fast: referrer + the visitor key are covered by rum_session_cover_idx.
-- Run after rollup.sql (which defines traffic_channel).
-- ============================================================================
create or replace function public.traffic_sources(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select coalesce(nullif(ga_client_id,''), session_id) as k,
           public.traffic_channel(referrer, utm_source, utm_medium, gclid, fbclid) as channel
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
      and coalesce(nullif(ga_client_id,''), session_id) is not null
  )
  select coalesce(json_agg(json_build_array(channel, visitors, views) order by visitors desc), '[]'::json)
  into result
  from (select channel, count(distinct k) visitors, count(*) views from w group by channel) x;
  return result;
end;
$$;
grant execute on function public.traffic_sources(timestamptz, timestamptz) to anon;

-- Verify:  select public.traffic_sources(now() - interval '7 days', now());
