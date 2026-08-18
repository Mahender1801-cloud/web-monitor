-- ============================================================================
-- Search visibility: your own rankings, and who else is on the page.
-- Run once in Supabase -> SQL Editor.
--
-- Two sources, because they answer different questions and only one of them is
-- free at any useful volume.
--
--   gsc_keywords  Google Search Console, via the API. Your own impressions,
--                 clicks, CTR and average position for every query Google
--                 actually showed you for. Free, official, unlimited, and it is
--                 ground truth — no scraper can match it, because it comes from
--                 the same place the ranking happened.
--
--   serp_results  Who else ranks for those queries. This cannot come from
--                 Search Console; it needs an actual SERP fetch per keyword,
--                 and every provider meters that. So it is budgeted, rotated,
--                 and deliberately shallow — see serp_budget.
--
-- What is NOT here, and why: a competitor's own top-200 keyword list. That is
-- keyword-database territory (Ahrefs, Semrush, DataForSEO Labs) and there is no
-- free tier for it anywhere. What replaces it is share_of_voice below, built
-- from SERPs we already fetched — which measures competitors against the
-- keywords that actually earn this shop money, rather than their global list.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Search Console: one row per query per day.
-- ---------------------------------------------------------------------------
create table if not exists public.gsc_keywords (
  d           date   not null,
  query       text   not null,
  page        text,
  country     text,
  device      text,
  clicks      integer not null default 0,
  impressions integer not null default 0,
  ctr         numeric,
  position    numeric,                    -- Google's own average position
  created_at  timestamptz not null default now(),
  primary key (d, query, coalesce(page,''), coalesce(country,''), coalesce(device,''))
);
create index if not exists gsc_day       on public.gsc_keywords (d desc);
create index if not exists gsc_query     on public.gsc_keywords (query);
create index if not exists gsc_impressions on public.gsc_keywords (d desc, impressions desc);

-- ---------------------------------------------------------------------------
-- 2) SERP snapshots: the ten results Google showed for a keyword, and when.
--
-- One row per result, not per keyword, so "who was above us" is a query rather
-- than a jsonb dig, and a brand's history across keywords falls out of a group by.
-- ---------------------------------------------------------------------------
create table if not exists public.serp_results (
  id          bigint generated always as identity primary key,
  checked_at  timestamptz not null default now(),
  keyword     text    not null,
  position    integer not null,           -- 1..10, position on the page
  url         text    not null,
  domain      text    not null,
  brand       text,                       -- domain mapped to a readable name
  title       text,
  is_us       boolean not null default false,
  provider    text,                       -- which API answered, for auditing
  country     text default 'in'
);
create index if not exists serp_kw   on public.serp_results (keyword, checked_at desc);
create index if not exists serp_when on public.serp_results (checked_at desc);
create index if not exists serp_brand on public.serp_results (brand, checked_at desc);

-- ---------------------------------------------------------------------------
-- 3) The budget. This table is the whole reason the feature can stay free.
--
-- Every free SERP plan is a monthly allowance — a few hundred queries. Without
-- a ledger the first run burns the month in one pass and every later run
-- silently returns nothing, which looks exactly like "our rankings vanished".
-- The fetcher reads this before every call and stops when the month is spent.
-- ---------------------------------------------------------------------------
create table if not exists public.serp_budget (
  provider   text    not null,
  month      date    not null,            -- first of the month
  used       integer not null default 0,
  monthly_cap integer not null,
  primary key (provider, month)
);

create or replace function public.serp_budget_take(p_provider text, p_cap int, p_n int default 1)
returns boolean language plpgsql
as $$
declare m date := date_trunc('month', now())::date; ok boolean;
begin
  insert into public.serp_budget (provider, month, used, monthly_cap)
  values (p_provider, m, 0, p_cap)
  on conflict (provider, month) do update set monthly_cap = excluded.monthly_cap;

  update public.serp_budget
     set used = used + p_n
   where provider = p_provider and month = m and used + p_n <= monthly_cap
  returning true into ok;

  return coalesce(ok, false);
end $$;
grant execute on function public.serp_budget_take(text, int, int) to anon;

-- ---------------------------------------------------------------------------
-- 4) Which keywords to spend the budget on.
--
-- Not the top 100 by impressions, which would re-check the same head terms
-- forever and never notice a competitor taking a mid-tail term. Ranked by what
-- is worth knowing: impressions, weighted up where the position is close enough
-- to page one to be winnable, and down where it was checked recently.
-- ---------------------------------------------------------------------------
create or replace function public.serp_next_keywords(p_limit int default 20)
returns table(keyword text, impressions bigint, position numeric, last_checked timestamptz)
language sql stable
set statement_timeout = '20s'
as $$
  with recent as (
    select query,
           sum(impressions)::bigint imps,
           avg(position) pos
    from public.gsc_keywords
    where d > current_date - 28
    group by query
  ),
  seen as (
    select keyword, max(checked_at) last_at
    from public.serp_results group by keyword
  )
  select r.query, r.imps, round(r.pos, 1), s.last_at
  from recent r
  left join seen s on s.keyword = r.query
  where r.imps >= 10
  order by
    -- a term already on page one, or just off it, is where a change matters most
    (case when r.pos between 1 and 20 then 2.0
          when r.pos between 20 and 40 then 1.3
          else 1.0 end) * ln(r.imps + 1)
    * (case when s.last_at is null then 3.0
            else least(3.0, extract(epoch from (now() - s.last_at)) / 604800.0) end)
    desc
  limit p_limit;
$$;
grant execute on function public.serp_next_keywords(int) to anon;

-- ---------------------------------------------------------------------------
-- 5) Share of voice — the honest replacement for "their top 200 keywords".
--
-- Measured over the keywords this shop actually appears for, which is the set
-- that matters commercially. A competitor's global keyword list would be mostly
-- terms this business will never sell against.
-- ---------------------------------------------------------------------------
create or replace function public.serp_share_of_voice(p_days int default 30)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with latest as (
    select distinct on (keyword, domain) keyword, domain, brand, position, is_us, checked_at
    from public.serp_results
    where checked_at > now() - make_interval(days => p_days)
    order by keyword, domain, checked_at desc
  ),
  kw as (select count(distinct keyword) n from latest),
  agg as (
    select coalesce(brand, domain) brand,
           count(distinct keyword)                          keywords,
           round(avg(position), 1)                          avg_pos,
           count(*) filter (where position <= 3)            top3,
           bool_or(is_us)                                   is_us,
           -- clicks follow position steeply, so presence alone overstates a
           -- brand sitting at 9 and understates one owning the first result
           round(sum(1.0 / position) * 100.0 / nullif((select n from kw), 0), 1) sov
    from latest group by 1
  )
  select json_build_object(
    'days', p_days,
    'keywords_tracked', (select n from kw),
    'brands', (select coalesce(json_agg(json_build_array(
                 brand, keywords, avg_pos, top3, sov, is_us) order by sov desc), '[]'::json)
               from agg)
  ) into result;
  return result;
end $$;
grant execute on function public.serp_share_of_voice(int) to anon;

-- ---------------------------------------------------------------------------
-- Verify:
--   select public.serp_next_keywords(10);
--   select public.serp_share_of_voice(30);
--   select provider, month, used, monthly_cap from public.serp_budget;
-- ---------------------------------------------------------------------------

-- ============================================================================
-- Rich SERP features — everything on the page that is not an organic result.
-- Appended after the first version; run this part if serp.sql was already run.
--
-- These come only from a provider with real Google access. Brave's results page
-- carries none of them, so rows here exist for keywords checked through
-- SerpApi/Serper and not for the free Brave sweep. That is why they live in
-- their own table rather than as nullable columns on serp_results: a missing ad
-- block should read as "not measured for this keyword", never as "no ads ran".
-- ============================================================================
create table if not exists public.serp_features (
  id         bigint generated always as identity primary key,
  checked_at timestamptz not null default now(),
  keyword    text not null,
  kind       text not null,     -- ad | paa | related | knowledge | ai_overview | local | news
  position   integer,           -- rank within its own block, where ordered
  title      text,
  url        text,
  domain     text,
  brand      text,
  body       text,              -- ad copy, PAA answer, KG fact, AI overview text
  extra      jsonb,             -- rating, reviews, price, sitelinks — shape varies
  provider   text
);
create index if not exists serpf_kw   on public.serp_features (keyword, checked_at desc);
create index if not exists serpf_kind on public.serp_features (kind, checked_at desc);

-- Who is buying ads against the terms this shop ranks for. Paid pressure is the
-- thing organic tracking cannot see, and it moves faster than rankings do.
create or replace function public.serp_ad_competitors(p_days int default 30)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with latest as (
    select distinct on (keyword, domain) keyword, domain, brand, position, body, checked_at
    from public.serp_features
    where kind = 'ad' and checked_at > now() - make_interval(days => p_days)
    order by keyword, domain, checked_at desc
  )
  select json_build_object(
    'days', p_days,
    'keywords_with_ads', (select count(distinct keyword) from latest),
    'advertisers', (
      select coalesce(json_agg(json_build_array(brand, kws, avg_pos, sample) order by kws desc), '[]'::json)
      from (
        select coalesce(brand, domain) brand,
               count(distinct keyword) kws,
               round(avg(position), 1) avg_pos,
               (array_agg(body order by checked_at desc))[1] sample
        from latest group by 1 limit 25
      ) t)
  ) into result;
  return result;
end $$;
grant execute on function public.serp_ad_competitors(int) to anon;
