-- Reverse of 20261116090000_body_fat_trigger_revoke.sql: deliberately a no-op.
--
-- Restoring the EXECUTE grant to `anon` / `authenticated` would only re-add an undeclared client
-- grant on an internal trigger function (tests/tenancy/rpc-matrix.test.ts), and no caller needs
-- it: the trigger fires without it. The function itself belongs to 20261028090000 and its down.
select 1;
