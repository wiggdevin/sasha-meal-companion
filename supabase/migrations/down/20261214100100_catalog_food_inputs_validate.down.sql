-- Reverse of 20261214100100_catalog_food_inputs_validate.sql (run after 20261214100200's down).
-- Validation changes no data and no
-- shape a reader sees, and PostgreSQL cannot mark a validated constraint NOT VALID again, so this
-- step is a deliberate no-op. Rollback order: this file, then
-- 20261214100000_catalog_food_inputs.down.sql.
select 1;
