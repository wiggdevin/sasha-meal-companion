-- Rollback of 20261018091000_per_100g_canonical_keys.
--
-- Deliberately a no-op on the data. The rename is not reversible: a row carrying `protein`,
-- `carbohydrate` and `fat_total` may carry them because a label scan, a barcode match or
-- lib/foods/adopt-client.ts wrote them that way from the start, and this file cannot tell those
-- apart from the rows the up migration renamed. Renaming every canonical key back to the `_g`
-- spellings would break compute_item_snapshot for all of them — the exact bug §5 exists to close.
-- Undo the rows by hand if that is really what is wanted.

do $$
begin
  raise notice 'per_100g canonical keys: down is a no-op; see the file for why';
end $$;
