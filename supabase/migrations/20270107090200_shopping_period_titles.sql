-- UI makeover W7 (docs/plans/2026-10-19-ui-makeover.md §7.2): saved, named and dated shopping
-- lists. One nullable `title` on shopping_periods: null means untitled (the phone shows
-- "List for <dates>", never stored). The owner's existing RLS policy covers the new column; the
-- period routes write it through the caller's session, like every other period field.
--
-- Live-safe: a nullable column with no default (no table rewrite) and a NOT VALID check, so the
-- ALTER takes its lock only briefly; 20270107090300 validates it. Apply BEFORE the code that
-- writes `title` merges (a write of the column fails until it exists).
-- Down: supabase/migrations/down/20270107090200_shopping_period_titles.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
              and table_name = 'shopping_periods' and column_name = 'title') then
    raise exception '20270107090200_shopping_period_titles: already applied';
  end if;
end $$;

alter table public.shopping_periods add column title text;
alter table public.shopping_periods add constraint shopping_periods_title_check
  check (title is null or (title = btrim(title) and char_length(title) between 1 and 60)) not valid;

comment on column public.shopping_periods.title is
  'UI makeover W7: the list''s name, trimmed, 1-60 characters; null is an untitled list.';
