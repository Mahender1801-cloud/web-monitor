-- ============================================================================
-- Final speed pass: the last two slow calls.  Run in Supabase -> SQL Editor.
--
-- Measured on the live DB after the rollup landed:
--     traffic_sources … 10.0s   (still scanning raw rum_events + count distinct)
--     dash_trend ……… 6.5s
--     everything else < 1s
--
-- Both are fixed the same way the rest were: read the pre-aggregated day rows and
-- live-query only the partial head/tail of the window.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Store the channel breakdown in the daily rollup (visitors + views per
--    channel), so traffic_sources doesn't have to scan raw events.
-- ---------------------------------------------------------------------------
alter table public.rum_daily add column if not exists by_channel jsonb;   -- {'Meta Ads': [visitors, views], …}

create or replace function public.rum_rollup_channels(p_day date)
returns void language plpgsql
set statement_timeout = '60s'
as $$
begin
  with src as materialized (
    select coalesce(nullif(ga_client_id,''), session_id) k,
           public.traffic_channel(referrer, utm_source, utm_medium, gclid, fbclid) ch
    from public.rum_events
    where created_at >= p_day::timestamptz and created_at < (p_day+1)::timestamptz
      and coalesce(nullif(ga_client_id,''), session_id) is not null
  ),
  agg as (select ch, count(distinct k) v, count(*) w from src group by ch)
  update public.rum_daily d
     set by_channel = (select coalesce(jsonb_object_agg(ch, jsonb_build_array(v,w)),'{}'::jsonb) from agg)
   where d.d = p_day;
end $$;
grant execute on function public.rum_rollup_channels(date) to anon;

-- Backfill channels for every rolled-up day
do $$
declare dd date;
begin
  for dd in select d from public.rum_daily order by d loop
    perform public.rum_rollup_channels(dd);
  end loop;
end $$;

-- Keep it fresh alongside the main rollup
create or replace function public.rum_rollup_refresh(p_days int default 2)
returns int language plpgsql
set statement_timeout = '300s'
as $$
declare dd date; n int := 0;
begin
  for dd in select generate_series(current_date - (p_days - 1), current_date, '1 day')::date loop
    perform public.rum_rollup_day(dd);
    perform public.rum_rollup_channels(dd);
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function public.rum_rollup_refresh(int) to anon;

-- ---------------------------------------------------------------------------
-- 2) traffic_sources from the rollup.
--    NOTE ON VISITORS: daily unique visitors are summed across days, so a shopper
--    who returns on three days counts three times. That is the standard "daily
--    uniques" definition and is what makes this fast; the shares are unaffected.
-- ---------------------------------------------------------------------------
create or replace function public.traffic_sources(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json; full_lo date; full_hi date;
begin
  full_lo := (date_trunc('day', p_from))::date;
  if date_trunc('day', p_from) < p_from then full_lo := full_lo + 1; end if;
  full_hi := (date_trunc('day', p_to))::date;
  if full_hi < full_lo then full_hi := full_lo; end if;

  with roll as (
    select key ch, (value->>0)::bigint v, (value->>1)::bigint w
    from public.rum_daily d, jsonb_each(coalesce(d.by_channel,'{}'::jsonb))
    where d.d >= full_lo and d.d < full_hi
  ),
  live_src as materialized (
    select coalesce(nullif(ga_client_id,''), session_id) k,
           public.traffic_channel(referrer, utm_source, utm_medium, gclid, fbclid) ch
    from public.rum_events
    where ((created_at >= p_from and created_at < full_lo::timestamptz)
        or (created_at >= full_hi::timestamptz and created_at <= p_to))
      and coalesce(nullif(ga_client_id,''), session_id) is not null
  ),
  live as (select ch, count(distinct k) v, count(*) w from live_src group by ch),
  all_ as (select ch, v, w from roll union all select ch, v, w from live),
  tot as (select ch, sum(v) v, sum(w) w from all_ group by ch)
  select coalesce(json_agg(json_build_array(ch, v, w) order by v desc), '[]'::json)
  into result from tot;
  return result;
end $$;
grant execute on function public.traffic_sources(timestamptz, timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- 3) dash_trend from the rollup histograms (day buckets); finer buckets still
--    query raw events, which is cheap because those windows are short.
-- ---------------------------------------------------------------------------
create or replace function public.dash_trend(
  p_from timestamptz, p_to timestamptz, p_bucket text default 'day', p_metric text default 'lcp'
) returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json; w numeric;
begin
  if p_bucket = 'day' then
    w := case p_metric when 'lcp' then 50 when 'fcp' then 50 when 'ttfb' then 25
                       when 'inp' then 10 when 'cls' then 0.005 else 50 end;
    select coalesce(json_agg(json_build_array(d, val, views) order by d), '[]'::json) into result
    from (
      select d,
             public.hist_pct(case p_metric when 'lcp' then h_lcp when 'inp' then h_inp
                                           when 'cls' then h_cls when 'fcp' then h_fcp
                                           else h_ttfb end, w) val,
             views
      from public.rum_daily
      where d >= (date_trunc('day', p_from))::date and d <= (date_trunc('day', p_to))::date
    ) t;
    return result;
  end if;

  select coalesce(json_agg(json_build_array(b, val, n) order by b), '[]'::json) into result
  from (
    select date_trunc(p_bucket, created_at) b, count(*) n,
           percentile_cont(0.75) within group (order by
             case p_metric when 'lcp' then lcp when 'inp' then inp when 'cls' then cls
                           when 'fcp' then fcp else ttfb end) val
    from public.rum_events
    where created_at >= p_from and created_at <= p_to
    group by 1
  ) t;
  return result;
end $$;
grant execute on function public.dash_trend(timestamptz, timestamptz, text, text) to anon;

analyze public.rum_daily;

-- Verify (both should be well under a second):
--   select public.traffic_sources(now() - interval '7 days', now());
--   select public.dash_trend(now() - interval '7 days', now(), 'day', 'lcp');
