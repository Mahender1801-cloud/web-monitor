-- ============================================================================
-- URGENT follow-up to traffic_and_funnel_fix.sql — run this right away.
--
-- Two real problems found by testing against your live data after you ran
-- the first migration:
--
-- 1) PERFORMANCE REGRESSION. dash_stats and dash_pivot now call
--    public.traffic_channel(...) once per row inside a GROUP BY. That
--    function-call overhead, multiplied by ~80k+ rows in a 7-day window,
--    pushed both functions past their 20s statement_timeout — they now
--    return an error for any window bigger than ~24h. (Confirmed live:
--    7-day dash_stats/dash_pivot calls failed after 20-26s.) This migration
--    inlines the classification CASE directly back into both functions
--    (same approach the original, proven-fast code used) instead of calling
--    out to a separate function per row. traffic_channel() itself is kept
--    for one-off/manual queries, just no longer called from these two.
--
-- 2) CLASSIFICATION GAP found in your real utm data:
--    - utm_source='ig' (your actual Instagram shorthand — 163 hits in the
--      last week) fell through to a generic "Campaign: ig" bucket instead
--      of "Instagram", because the old check only matched utm_source values
--      containing "insta".
--    - utm_source='fbjatin' + utm_medium='Instagram_Reels' is a paid Meta
--      placement (Meta's ad UTM builder fills utm_medium with placement
--      names like Instagram_Reels/Instagram_Stories/Facebook_Feed, not
--      "cpc"/"paid"), so it was misclassified as organic "Facebook / Meta"
--      instead of "Meta Ads". Both are fixed below.
--
-- Also fixes viewed_cart in funnel_stats to use UNION ALL instead of UNION
-- (avoids an unnecessary extra dedup pass — cheap, no behavior change).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- traffic_channel(): kept for manual/ad-hoc use (small queries only — do not
-- call this from a per-row GROUP BY on rum_events, see above). Same fixes.
-- ---------------------------------------------------------------------------
create or replace function public.traffic_channel(
  p_referrer text, p_utm_source text, p_utm_medium text, p_gclid text, p_fbclid text
) returns text language sql immutable parallel safe as $$
  select case
    when (p_utm_medium ~* 'cpc|ppc|paid|ads|reel|stor|feed')
         and p_utm_source ilike any (array['%face%','%insta%','%meta%','%fb%'])   then 'Meta Ads'
    when (p_utm_medium ~* 'cpc|ppc|paid|ads')
         and p_utm_source ilike '%google%'                                       then 'Google Ads'
    when p_utm_source ilike 'ig' or p_utm_source ilike '%insta%'                  then 'Instagram'
    when p_utm_source ilike any (array['%face%','%meta%','%fb%'])                 then 'Facebook / Meta'
    when p_utm_source ilike '%whatsapp%'                                          then 'Shared link'
    when p_utm_source ilike '%google%'                                            then 'Google'
    when p_utm_source ilike '%youtube%'                                           then 'YouTube'
    when p_utm_source is not null and p_utm_source <> ''                          then 'Campaign: ' || p_utm_source
    when p_gclid is not null and p_gclid <> ''                                    then 'Google Ads'
    when p_fbclid is not null and p_fbclid <> '' and p_referrer ilike '%instagram%' then 'Instagram'
    when p_fbclid is not null and p_fbclid <> ''                                  then 'Facebook / Meta'
    when p_referrer is null or p_referrer = ''                                    then 'Direct'
    when p_referrer ilike '%instagram%' or p_referrer ilike '%l.instagram%'       then 'Instagram'
    when p_referrer ilike '%facebook%'  or p_referrer ilike '%l.facebook%'
      or p_referrer ilike '%fb.com%'    or p_referrer ilike '%fb.me%'             then 'Facebook / Meta'
    when p_referrer ilike '%whatsapp%'  or p_referrer ilike '%wa.me%'
      or p_referrer ilike '%t.co%'      or p_referrer ilike '%bit.ly%'
      or p_referrer ilike '%lnk.%'      or p_referrer ilike '%linktr%'            then 'Shared link'
    when p_referrer ilike '%google%'                                              then 'Google'
    when p_referrer ilike '%youtube%'                                             then 'YouTube'
    when p_referrer ilike '%bing%' or p_referrer ilike '%yahoo%'
      or p_referrer ilike '%duckduckgo%'                                          then 'Other search'
    when p_referrer ilike '%hashtageyewear%'                                      then 'Internal'
    else 'Other referral'
  end
$$;

-- ---------------------------------------------------------------------------
-- dash_stats: by_ref classification INLINED (not a function call per row).
-- Everything else identical to traffic_and_funnel_fix.sql's version.
-- ---------------------------------------------------------------------------
create or replace function public.dash_stats(p_from timestamptz, p_to timestamptz)
returns json
language plpgsql
stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select lcp, inp, cls, fcp, ttfb, time_on_page,
           device, os, connection, referrer, path, ga_client_id,
           utm_source, utm_medium, gclid, fbclid
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
  ),
  agg as (
    select count(*) views,
           count(distinct ga_client_id) visitors,
           percentile_cont(0.75) within group (order by lcp)  lcp,
           percentile_cont(0.75) within group (order by inp)  inp,
           percentile_cont(0.75) within group (order by cls)  cls,
           percentile_cont(0.75) within group (order by fcp)  fcp,
           percentile_cont(0.75) within group (order by ttfb) ttfb,
           avg(time_on_page) dwell
    from w
  ),
  toppaths as (
    select path from w where path is not null
    group by path having count(*) >= 5
    order by count(*) desc limit 40
  ),
  slowpaths as (
    select w.path, count(*) n,
           percentile_cont(0.75) within group (order by w.lcp) l,
           percentile_cont(0.75) within group (order by w.inp) i,
           percentile_cont(0.75) within group (order by w.cls) c2
    from w join toppaths t on t.path = w.path
    group by w.path
    order by l desc nulls last
    limit 8
  )
  select json_build_object(
    'views',    (select views    from agg),
    'visitors', (select visitors from agg),
    'lcp',      (select lcp      from agg),
    'inp',      (select inp      from agg),
    'cls',      (select cls      from agg),
    'fcp',      (select fcp      from agg),
    'ttfb',     (select ttfb     from agg),
    'dwell',    (select dwell    from agg),
    'by_device',(select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                   from (select coalesce(nullif(device,''),'other') k, count(*) c from w group by 1) t),
    'by_os',    (select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                   from (select coalesce(nullif(os,''),'Other') k, count(*) c from w group by 1) t),
    'by_net',   (select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                   from (select coalesce(nullif(connection,''),'unknown') k, count(*) c from w group by 1) t),
    'by_ref',   (select coalesce(json_agg(json_build_array(k,c) order by c desc),'[]'::json)
                   from (
                     select case
                       when (utm_medium ~* 'cpc|ppc|paid|ads|reel|stor|feed')
                            and utm_source ilike any (array['%face%','%insta%','%meta%','%fb%'])   then 'Meta Ads'
                       when (utm_medium ~* 'cpc|ppc|paid|ads')
                            and utm_source ilike '%google%'                                        then 'Google Ads'
                       when utm_source ilike 'ig' or utm_source ilike '%insta%'                    then 'Instagram'
                       when utm_source ilike any (array['%face%','%meta%','%fb%'])                 then 'Facebook / Meta'
                       when utm_source ilike '%whatsapp%'                                          then 'Shared link'
                       when utm_source ilike '%google%'                                            then 'Google'
                       when utm_source ilike '%youtube%'                                           then 'YouTube'
                       when utm_source is not null and utm_source <> ''                            then 'Campaign: ' || utm_source
                       when gclid is not null and gclid <> ''                                      then 'Google Ads'
                       when fbclid is not null and fbclid <> '' and referrer ilike '%instagram%'   then 'Instagram'
                       when fbclid is not null and fbclid <> ''                                    then 'Facebook / Meta'
                       when referrer is null or referrer = ''                                      then 'Direct'
                       when referrer ilike '%instagram%' or referrer ilike '%l.instagram%'         then 'Instagram'
                       when referrer ilike '%facebook%'  or referrer ilike '%l.facebook%'
                         or referrer ilike '%fb.com%'    or referrer ilike '%fb.me%'                then 'Facebook / Meta'
                       when referrer ilike '%whatsapp%'  or referrer ilike '%wa.me%'
                         or referrer ilike '%t.co%'      or referrer ilike '%bit.ly%'
                         or referrer ilike '%lnk.%'      or referrer ilike '%linktr%'               then 'Shared link'
                       when referrer ilike '%google%'                                               then 'Google'
                       when referrer ilike '%youtube%'                                              then 'YouTube'
                       when referrer ilike '%bing%' or referrer ilike '%yahoo%'
                         or referrer ilike '%duckduckgo%'                                           then 'Other search'
                       when referrer ilike '%hashtageyewear%'                                       then 'Internal'
                       else 'Other referral'
                     end k, count(*) c
                     from w group by 1) t),
    'slow',     (select coalesce(json_agg(json_build_array(path,n,l,i,c2) order by l desc nulls last),'[]'::json)
                   from slowpaths)
  ) into result;
  return result;
end;
$$;
grant execute on function public.dash_stats(timestamptz, timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- dash_pivot: same inlining for its `r` CTE.
-- ---------------------------------------------------------------------------
create or replace function public.dash_pivot(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with w as materialized (
    select device, os, connection, referrer, utm_source, utm_medium, gclid, fbclid,
      case
        when path is null or path = '' or path = '/' then 'Homepage'
        when path like '/collections%' then 'Collections'
        when path like '/products%'    then 'Products'
        when path like '/cart%'        then 'Cart'
        when path like '/pages%'       then 'Pages'
        when path like '/apps%'        then 'Apps'
        else 'Other'
      end as grp
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
  ),
  d as (select coalesce(nullif(initcap(device),''),'Other') k, grp, count(*) c from w group by 1,2),
  o as (select coalesce(nullif(os,''),'Other') k, grp, count(*) c from w group by 1,2),
  n as (select coalesce(nullif(connection,''),'unknown') k, grp, count(*) c from w group by 1,2),
  r as (
    select case
      when (utm_medium ~* 'cpc|ppc|paid|ads|reel|stor|feed')
           and utm_source ilike any (array['%face%','%insta%','%meta%','%fb%'])   then 'Meta Ads'
      when (utm_medium ~* 'cpc|ppc|paid|ads')
           and utm_source ilike '%google%'                                        then 'Google Ads'
      when utm_source ilike 'ig' or utm_source ilike '%insta%'                     then 'Instagram'
      when utm_source ilike any (array['%face%','%meta%','%fb%'])                  then 'Facebook / Meta'
      when utm_source ilike '%whatsapp%'                                           then 'Shared link'
      when utm_source ilike '%google%'                                             then 'Google'
      when utm_source ilike '%youtube%'                                            then 'YouTube'
      when utm_source is not null and utm_source <> ''                             then 'Campaign: ' || utm_source
      when gclid is not null and gclid <> ''                                       then 'Google Ads'
      when fbclid is not null and fbclid <> '' and referrer ilike '%instagram%'    then 'Instagram'
      when fbclid is not null and fbclid <> ''                                     then 'Facebook / Meta'
      when referrer is null or referrer = ''                                       then 'Direct'
      when referrer ilike '%instagram%' or referrer ilike '%l.instagram%'          then 'Instagram'
      when referrer ilike '%facebook%'  or referrer ilike '%l.facebook%'
        or referrer ilike '%fb.com%'    or referrer ilike '%fb.me%'                 then 'Facebook / Meta'
      when referrer ilike '%whatsapp%'  or referrer ilike '%wa.me%'
        or referrer ilike '%t.co%'      or referrer ilike '%bit.ly%'
        or referrer ilike '%lnk.%'      or referrer ilike '%linktr%'                then 'Shared link'
      when referrer ilike '%google%'                                                then 'Google'
      when referrer ilike '%youtube%'                                               then 'YouTube'
      when referrer ilike '%bing%' or referrer ilike '%yahoo%'
        or referrer ilike '%duckduckgo%'                                            then 'Other search'
      when referrer ilike '%hashtageyewear%'                                        then 'Internal'
      else 'Other referral'
    end k, grp, count(*) c from w group by 1,2)
  select json_build_object(
    'device', (select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from d),
    'os',     (select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from o),
    'net',    (select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from n),
    'ref',    (select coalesce(json_agg(json_build_array(k,grp,c)),'[]'::json) from r),
    'total',  (select count(*) from w)
  ) into result;
  return result;
end;
$$;
grant execute on function public.dash_pivot(timestamptz, timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- funnel_stats: UNION ALL instead of UNION for viewed_cart (the outer
-- count(distinct) already dedups, so the inner UNION's extra sort/dedup pass
-- was pure waste).
-- ---------------------------------------------------------------------------
create or replace function public.funnel_stats(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with r as materialized (
    select session_id, path from public.rum_events
    where created_at >= p_from and created_at <= p_to and session_id is not null
  ),
  f as materialized (
    select session_id, event_type from public.funnel_events
    where created_at >= p_from and created_at <= p_to
  )
  select json_build_object(
    'sessions',       (select count(distinct session_id) from r),
    'viewed_product', (select count(distinct session_id) from r where path like '/products%'),
    'viewed_cart',    (select count(distinct session_id) from (
                          select session_id from r where path like '/cart%'
                          union all
                          select session_id from f where event_type = 'view_cart'
                        ) x),
    'added_to_cart',  (select count(distinct session_id) from f where event_type = 'add_to_cart'),
    'checkout_click', (select count(distinct session_id) from f where event_type = 'checkout_click'),
    'purchased',      (select count(distinct rum_session) from public.shop_orders
                        where created_at >= p_from and created_at <= p_to and rum_session is not null)
  ) into result;
  return result;
end;
$$;
grant execute on function public.funnel_stats(timestamptz, timestamptz) to anon;

analyze public.rum_events;

-- Verify (all four should return in a couple of seconds, not time out):
--   select public.dash_stats(now() - interval '7 days', now());
--   select public.dash_pivot(now() - interval '7 days', now());
--   select public.funnel_stats(now() - interval '7 days', now());
--   select public.traffic_channel(null,'ig','social',null,null);              -> Instagram
--   select public.traffic_channel(null,'fbjatin','Instagram_Reels',null,null);-> Meta Ads
