-- Reverse of 20261214100200_catalog_replace_food_inputs.sql. Drops only the import's writer
-- function; the table and its rows stay. Rollback order: this file, then
-- 20261214100100_catalog_food_inputs_validate.down.sql, then 20261214100000_catalog_food_inputs.down.sql.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.catalog_replace_food_inputs(bigint[], jsonb);
