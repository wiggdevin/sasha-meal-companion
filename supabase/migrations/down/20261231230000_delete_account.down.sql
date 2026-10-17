-- Down for 20261231230000_delete_account.sql: drops the one function it created. Accounts it
-- already deleted stay deleted (a down migration restores schema, never data). Turn
-- ACCOUNT_DELETION_ENABLED off first: with the function gone the route answers 503
-- account_deletion_unavailable.
set local lock_timeout = '3s';

drop function if exists public.delete_account(uuid);
