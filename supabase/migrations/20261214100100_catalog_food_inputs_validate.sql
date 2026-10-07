-- Phase 18 W4, step (b) of migration 3: validate step (a)'s NOT VALID foreign keys and checks.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE on catalog_food_inputs (reads and writes continue) and
-- ROW SHARE on the referenced catalog tables. Applied right after 20261214100000, before the
-- import runs, the table is empty and the scan is instant; applied later it still only reads.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

alter table public.catalog_food_inputs validate constraint catalog_food_inputs_revision_fk;
alter table public.catalog_food_inputs validate constraint catalog_food_inputs_input_fk;
alter table public.catalog_food_inputs validate constraint catalog_food_inputs_grams;
alter table public.catalog_food_inputs validate constraint catalog_food_inputs_source;
alter table public.catalog_food_inputs validate constraint catalog_food_inputs_seq;
