-- ============================================================================
-- Traffic sources — how visitors arrive (Instagram, Meta, search, shared link…).
-- Classifies rum_events by referrer. Fast: referrer + the visitor key are both in
-- rum_session_cover_idx, so this is an index-only scan. Run once in SQL Editor.
-- ============================================================================
create or replace function public.traffic_sources(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select coalesce(nullif(ga_client_id,''), session_id) as k,
      case
        when referrer is null or referrer = ''                      then 'Direct'
        when referrer ilike '%instagram%' or referrer ilike '%l.instagram%' then 'Instagram'
        when referrer ilike '%facebook%'  or referrer ilike '%l.facebook%'
          or referrer ilike '%fb.com%'    or referrer ilike '%fb.me%'   then 'Facebook / Meta'
        when referrer ilike '%whatsapp%'  or referrer ilike '%wa.me%'
          or referrer ilike '%t.co%'      or referrer ilike '%bit.ly%'
          or referrer ilike '%lnk.%'      or referrer ilike '%linktr%' then 'Shared link'
        when referrer ilike '%google%'                              then 'Google'
        when referrer ilike '%youtube%'                             then 'YouTube'
        when referrer ilike '%bing%' or referrer ilike '%yahoo%'
          or referrer ilike '%duckduckgo%'                          then 'Other search'
        when referrer ilike '%hashtageyewear%'                      then 'Internal'
        else 'Other referral'
      end as channel
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
