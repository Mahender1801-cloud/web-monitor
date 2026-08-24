-- ============================================================================
-- The last two QA tasks. Run once in Supabase -> SQL Editor.
--
-- The customer's 32-task checklist carries two rows the monitor never had:
--
--   Check A+ content / media sections
--   Test size guide / lens options / custom sections
--
-- They were never in the seed, so every report printed "No automated signal —
-- verify visually" against them and the weekly coverage stopped at 30 of 32.
-- That was accurate — nothing was checking them — but it was a gap that stayed
-- open only because the two rows had never been created.
--
-- Both are now real browser checks in scripts/qa_browser.mjs, so they need to
-- exist as task_items for the dashboard and the reports to pick them up.
-- ============================================================================

insert into public.task_items (category, item, check_type, auto_key, sort)
values
  -- Rich media below the buy box: embedded video, images inside the
  -- description, image-with-text blocks. Judged on what is present rather than
  -- one marker, because themes build this half a dozen different ways.
  ('Product Page Testing', 'Check A+ content / media sections', 'auto', 'browser', 12),

  -- A size guide that opens nothing is the failure worth catching, so the check
  -- clicks it and looks for a dialog rather than settling for the link existing.
  ('Product Page Testing', 'Test size guide / lens options / custom sections', 'auto', 'browser', 13)
on conflict do nothing;

-- Verify — expect 60 items, 59 auto, and the two new rows marked 'browser':
--   select check_type, count(*) from public.task_items group by 1;
--   select item, auto_key from public.task_items
--   where item in ('Check A+ content / media sections',
--                  'Test size guide / lens options / custom sections');
--
-- Then run the QA workflow (Actions -> "QA tasks (browser)" -> Run workflow).
-- The next report should read 32 of 32.
