-- ============================================================================
-- Web Score — saved URLs + score history.  Run ONCE in Supabase → SQL Editor.
-- Powers the "Web Score" page. Scoring itself runs in /api/score (Vercel),
-- no PageSpeed API. Each score run is stored here so you can watch a site
-- over time and compare sites.
-- ============================================================================

create table if not exists public.web_scores (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  url            text not null,
  label          text,
  overall        numeric,
  performance    numeric,
  seo            numeric,
  accessibility  numeric,
  best_practices numeric,
  metrics        jsonb,
  saved          boolean default false      -- true = pinned to the monitored list
);
create index if not exists web_scores_url_idx     on public.web_scores (url, created_at desc);
create index if not exists web_scores_created_idx on public.web_scores (created_at desc);

alter table public.web_scores enable row level security;

drop policy if exists "read_web_scores"   on public.web_scores;
create policy "read_web_scores"   on public.web_scores for select using (true);
drop policy if exists "insert_web_scores" on public.web_scores;
create policy "insert_web_scores" on public.web_scores for insert with check (true);
drop policy if exists "update_web_scores" on public.web_scores;
create policy "update_web_scores" on public.web_scores for update using (true) with check (true);
drop policy if exists "delete_web_scores" on public.web_scores;
create policy "delete_web_scores" on public.web_scores for delete using (true);
