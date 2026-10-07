-- Apple is no longer an allergen rule (Devin, 2026-09-22).
--
-- lib/reference.ts no longer offers `apple` in the Add-a-rule picker, so a row that still carries
-- it would render a rule the user can see but never re-add. 20261026090100 merged `apple` into
-- every existing row to preserve the old code floor; this takes it back out. Every other key in
-- the row is left exactly as it is.
--
-- rev is bumped for a row this changes, for the same reason 20261026090100 bumped it: a tab that
-- loaded the profile before this ran still holds `apple` at the older rev, and a save from it
-- would write the key back. The bump makes that save answer conflict, which AvoidRules renders.
--
-- Only avoid_allergens is touched: `apple` was only ever an allergen key. It has never been a
-- banned_categories key (lib/catalog/category-map.ts) and conditions is free text the user owns.
--
-- Re-running changes nothing: the WHERE clause stops matching once no row names `apple`.
update constraint_profiles
   set avoid_allergens = array_remove(avoid_allergens, 'apple'),
       rev = rev + 1,
       updated_at = now()
 where 'apple' = any(avoid_allergens);
