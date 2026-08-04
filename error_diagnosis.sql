-- ============================================================================
-- Why, not just what.  Run in Supabase -> SQL Editor.
--
-- The Health tab listed error messages and the pages people struggle on, which
-- says WHERE but never WHY. The collector already records the script and line an
-- error came from, and for a rage or dead click it records the ELEMENT that was
-- clicked — none of that was being surfaced.
--
--   error_diagnosis()  groups each error with the script and line that raised it,
--                      which browsers and devices see it, and how recently.
--   struggle_detail()  groups frustration by the actual ELEMENT, so the answer is
--                      "the Add to Cart label on Safari", not "this page".
-- ============================================================================

create or replace function public.error_diagnosis(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with e as (
    select detail, coalesce(source,'') source, line, browser, device, path, created_at
    from public.health_events
    where kind = 'js_error' and created_at >= p_from and created_at <= p_to
  ),
  g as (
    select
      -- collapse the per-page noise: the same bug repeats across product URLs
      regexp_replace(coalesce(detail,''), '\s*https?://\S+', '', 'g')       as msg,
      source,
      max(line)                                       as line,
      count(*)                                        as n,
      count(distinct path)                            as pages,
      mode() within group (order by browser)          as top_browser,
      mode() within group (order by device)           as top_device,
      count(*) filter (where browser = 'Safari')      as safari,
      count(*) filter (where browser = 'Chrome')      as chrome,
      min(created_at)                                 as first_seen,
      max(created_at)                                 as last_seen,
      (array_agg(path order by created_at desc))[1]   as sample_path
    from e
    group by 1,2
  )
  select coalesce(json_agg(json_build_array(
           msg, source, line, n, pages, top_browser, top_device,
           safari, chrome, first_seen, last_seen, sample_path
         ) order by n desc), '[]'::json)
  into result
  from (select * from g order by n desc limit 20) t;
  return result;
end $$;
grant execute on function public.error_diagnosis(timestamptz, timestamptz) to anon;

-- ---------------------------------------------------------------------------
-- Frustration, by the element people actually clicked.
-- ---------------------------------------------------------------------------
create or replace function public.struggle_detail(p_from timestamptz, p_to timestamptz)
returns json language plpgsql stable
set statement_timeout = '20s'
as $$
declare result json;
begin
  with s as (
    select kind, coalesce(detail,'') element, path, browser, device
    from public.health_events
    where kind in ('rage_click','dead_click')
      and created_at >= p_from and created_at <= p_to
  )
  select json_build_object(
    'by_element', (select coalesce(json_agg(json_build_array(element, kind, n, pages, top_browser, top_device, sample_path) order by n desc), '[]'::json)
      from (
        select element, kind, count(*) n, count(distinct path) pages,
               mode() within group (order by browser) top_browser,
               mode() within group (order by device)  top_device,
               (array_agg(path))[1] sample_path
        from s where element <> '' group by element, kind
        order by count(*) desc limit 20
      ) t),
    'by_page', (select coalesce(json_agg(json_build_array(path, n, elems) order by n desc), '[]'::json)
      from (
        select path, count(*) n, count(distinct element) elems
        from s group by path order by count(*) desc limit 12
      ) t)
  ) into result;
  return result;
end $$;
grant execute on function public.struggle_detail(timestamptz, timestamptz) to anon;

-- Verify:
--   select public.error_diagnosis(now() - interval '7 days', now());
--   select public.struggle_detail(now() - interval '7 days', now());
