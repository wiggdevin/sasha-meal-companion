-- Reverse of 20261214100000_catalog_food_inputs.sql. Drops the imported FNDDS inputs with the
-- table; they are rebuilt from the public FNDDS files by scripts/import-fndds-inputs.ts, so nothing
-- is lost that a re-import cannot restore. Revert the app deploy that reads the table first: with
-- the table gone, the taste read (lib/server/mixed-dish-inputs.ts) fails.
-- Runs alone: it drops only its own objects and skips a table that is already gone.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop table if exists public.catalog_food_inputs;
