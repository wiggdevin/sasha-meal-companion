-- Reverse of 20261027090000_drop_apple_allergen.sql: nothing to undo.
--
-- The forward migration is data only: it removed the `apple` key from constraint_profiles rows
-- because the application no longer offers it as a rule. Putting the key back on a rollback would
-- re-add a restriction to every account that had it merged in by 20261026090100, whether or not
-- that account ever chose it, so it is left out on purpose. The build this rolls back to still
-- labels `apple` and enforces it only for a row that names it, so a rolled-back app reads these
-- rows correctly as they are.
select 1;
