-- Phase 18 W2b, step (d): the evidence clock on the five catalog tables admission reads
-- (written by the import worker and the barcode path, not by live account traffic).
-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the table (writes wait) for a catalog update only.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create trigger evidence_clock_catalog_foods_ins after insert on public.catalog_foods
  referencing new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_foods_upd after update on public.catalog_foods
  referencing old table as old_rows new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_foods_del after delete on public.catalog_foods
  referencing old table as old_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_food_revisions_ins after insert on public.catalog_food_revisions
  referencing new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_food_revisions_upd after update on public.catalog_food_revisions
  referencing old table as old_rows new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_food_revisions_del after delete on public.catalog_food_revisions
  referencing old table as old_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_food_nutrients_ins after insert on public.catalog_food_nutrients
  referencing new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_food_nutrients_upd after update on public.catalog_food_nutrients
  referencing old table as old_rows new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_food_nutrients_del after delete on public.catalog_food_nutrients
  referencing old table as old_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_ingredients_ins after insert on public.catalog_ingredients
  referencing new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_ingredients_upd after update on public.catalog_ingredients
  referencing old table as old_rows new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_ingredients_del after delete on public.catalog_ingredients
  referencing old table as old_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_portions_ins after insert on public.catalog_portions
  referencing new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_portions_upd after update on public.catalog_portions
  referencing old table as old_rows new table as new_rows for each statement execute function public.evidence_clock_bump();
create trigger evidence_clock_catalog_portions_del after delete on public.catalog_portions
  referencing old table as old_rows for each statement execute function public.evidence_clock_bump();
