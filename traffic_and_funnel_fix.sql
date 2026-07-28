-- ============================================================================
-- Traffic-source attribution + funnel-accuracy fix. Run once in Supabase ->
-- SQL Editor, AFTER webvitals.js has been re-pasted into Shopify (this file
-- adds the columns the new collector fields need; old rows just have them null).
--
-- WHY
-- 0) The Purchases tab's "Linked to browsing" headline TILE was reading
--    buys.length — the count of rows in the `purchases` table, which is fed
--    by a checkout pixel that has recorded 3 rows in this database's entire
--    history. That's the "1/161", "0/7" the user saw: a near-dead pixel count
--    displayed next to the accurate Shopify order total. The REAL link count
--    (shop_orders.rum_session/ga_client_id, filled by the cart-stamp) was only
--    ever shown in small print under the orders table. shop_stats now returns
--    an accurate, window-wide `linked` count so the headline tile can use it.
-- 1) Live-site inspection found the theme uses a DRAWER cart (no /cart page
--    nav) and a third-party checkout button (Shiprocket's accelerated
--    checkout, class="cart-footer-bar__buy-now") that matched none of the
--    collector's checkout selectors. Confirmed in the DB: funnel_events has
--    273 rows and every single one is add_to_cart — checkout_click has never
--    fired once. funnel_stats' viewed_cart/checkout_click were structurally
--    stuck near zero. webvitals.js now emits a view_cart event on cart-icon
--    click and detects checkout via a much broader selector; this migrates
--    funnel_stats to use the new signals.
-- 2) "How did they arrive" was answered only by a coarse, referrer-only
--    Direct/Instagram/Facebook/Google/Internal/Other split, duplicated
--    (slightly differently) across dash_stats.by_ref and dash_pivot.r. This
--    factors that into ONE function, traffic_channel(), driven first by UTM
--    tags and ad click-ids (gclid/fbclid — survive in-app-browser referrer
--    stripping, unlike referrer) and falling back to referrer, so "Meta Ads"
--    vs organic Instagram/Facebook, search, and shared links (WhatsApp,
--    bit.ly, Linktree…) are distinguishable. Wired into the dashboard's
--    existing "Referrer source" pie/pivot — no new UI needed.
-- ============================================================================

alter table public.rum_events add column if not exists gclid  text;
alter table public.rum_events add column if not exists fbclid text;

-- ---------------------------------------------------------------------------
-- Single source of truth for channel classification (was duplicated across
-- dash_stats and dash_pivot). immutable: pure string logic, no table access,
-- safe for the planner to inline into the surrounding aggregate scan.
-- ---------------------------------------------------------------------------
create or replace function public.traffic_channel(
  p_referrer text, p_utm_source text, p_utm_medium text, p_gclid text, p_fbclid text
) returns text language sql immutable parallel safe as $$
  select case
    -- 1) UTM tags — most reliable when present (survives in-app-browser referrer stripping)
    when (p_utm_medium ilike 'cpc' or p_utm_medium ilike 'ppc' or p_utm_medium ilike '%paid%' or p_utm_medium ilike 'ads')
         and p_utm_source ilike any (array['%face%','%insta%','%meta%','%fb%'])   then 'Meta Ads'
    when (p_utm_medium ilike 'cpc' or p_utm_medium ilike 'ppc' or p_utm_medium ilike '%paid%' or p_utm_medium ilike 'ads')
         and p_utm_source ilike '%google%'                                       then 'Google Ads'
    when p_utm_source ilike '%insta%'                                            then 'Instagram'
    when p_utm_source ilike any (array['%face%','%meta%','%fb%'])                then 'Facebook / Meta'
    when p_utm_source ilike '%whatsapp%'                                         then 'Shared link'
    when p_utm_source ilike '%google%'                                           then 'Google'
    when p_utm_source ilike '%youtube%'                                          then 'YouTube'
    when p_utm_source is not null and p_utm_source <> ''                         then 'Campaign: ' || p_utm_source
    -- 2) Ad click-ids present but no UTM tag — gclid is exclusive to Google Ads
    when p_gclid is not null and p_gclid <> ''                                   then 'Google Ads'
    when p_fbclid is not null and p_fbclid <> '' and p_referrer ilike '%instagram%' then 'Instagram'
    when p_fbclid is not null and p_fbclid <> ''                                 then 'Facebook / Meta'
    -- 3) Referrer fallback
    when p_referrer is null or p_referrer = ''                                   then 'Direct'
    when p_referrer ilike '%instagram%' or p_referrer ilike '%l.instagram%'      then 'Instagram'
    when p_referrer ilike '%facebook%'  or p_referrer ilike '%l.facebook%'
      or p_referrer ilike '%fb.com%'    or p_referrer ilike '%fb.me%'            then 'Facebook / Meta'
    when p_referrer ilike '%whatsapp%'  or p_referrer ilike '%wa.me%'
      or p_referrer ilike '%t.co%'      or p_referrer ilike '%bit.ly%'
      or p_referrer ilike '%lnk.%'      or p_referrer ilike '%linktr%'           then 'Shared link'
    when p_referrer ilike '%google%'                                             then 'Google'
    when p_referrer ilike '%youtube%'                                            then 'YouTube'
    when p_referrer ilike '%bing%' or p_referrer ilike '%yahoo%'
      or p_referrer ilike '%duckduckgo%'                                         then 'Other search'
    when p_referrer ilike '%hashtageyewear%'                                     then 'Internal'
    else 'Other referral'
  end
$$;

-- ---------------------------------------------------------------------------
-- dash_stats: same as before, but by_ref now uses traffic_channel() and also
-- selects utm_source/utm_medium/gclid/fbclid in the same already-scanned `w`
-- CTE (no extra scan — dash_stats already reads the full window for the LCP/
-- INP/etc. percentiles, so this rides along for free).
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
                   from (select public.traffic_channel(referrer,utm_source,utm_medium,gclid,fbclid) k, count(*) c
                         from w group by 1) t),
    'slow',     (select coalesce(json_agg(json_build_array(path,n,l,i,c2) order by l desc nulls last),'[]'::json)
                   from slowpaths)
  ) into result;
  return result;
end;
$$;
grant execute on function public.dash_stats(timestamptz, timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- dash_pivot: same traffic_channel() swap for its `r` (referrer/source) CTE.
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
  r as (select public.traffic_channel(referrer,utm_source,utm_medium,gclid,fbclid) k, grp, count(*) c from w group by 1,2)
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
-- funnel_stats: viewed_cart now also counts the new view_cart funnel_events
-- (cart-icon click — the honest "reached cart" signal on a drawer-cart theme
-- that never navigates to /cart), unioned with the old path-based signal for
-- any traffic that does land straight on /cart.
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
                          union
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

-- ---------------------------------------------------------------------------
-- shop_stats: add an accurate, window-wide `linked` count (orders whose
-- rum_session or ga_client_id is set) so the Purchases tab's headline tile
-- can stop reading the near-empty pixel `purchases` table for this number.
-- ---------------------------------------------------------------------------
create or replace function public.shop_stats(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '10s'
as $$
declare result json;
begin
  with w as (
    select created_at, total_price, currency, rum_session, ga_client_id
    from public.shop_orders
    where created_at >= p_from and created_at <= p_to
      and coalesce(financial_status,'') not in ('voided','refunded')
  )
  select json_build_object(
    'orders',  (select count(*) from w),
    'revenue', (select coalesce(sum(total_price),0) from w),
    'aov',     (select case when count(*)>0 then sum(total_price)/count(*) end from w),
    'currency',(select currency from w order by created_at desc limit 1),
    'linked',  (select count(*) filter (where rum_session is not null or ga_client_id is not null) from w),
    'daily',   (select coalesce(json_agg(json_build_array(d,n,rev) order by d),'[]'::json)
                from (select date_trunc('day',created_at)::date d, count(*) n, sum(total_price) rev
                      from w group by 1) x)
  ) into result;
  return result;
end;
$$;
grant execute on function public.shop_stats(timestamptz, timestamptz) to anon;

analyze public.rum_events;

-- Verify:
--   select public.traffic_channel('https://l.instagram.com/','ig','cpc',null,null);  -> Meta Ads
--   select public.dash_stats(now() - interval '7 days', now());
--   select public.dash_pivot(now() - interval '7 days', now());
--   select public.funnel_stats(now() - interval '7 days', now());
--   select public.shop_stats(now() - interval '7 days', now());  -> check "linked" is sane vs "orders"
