-- Rollback of 20261018090100_constraint_profile_all_categories.
--
-- Restores the Phase 0 default. The four keys are NOT removed from an existing row: a row may
-- carry them because she switched them on herself, and this file cannot tell the two apart. Undo
-- the rows by hand if that is really what is wanted.

alter table constraint_profiles
  alter column banned_categories set default '{simple_sugars}';
