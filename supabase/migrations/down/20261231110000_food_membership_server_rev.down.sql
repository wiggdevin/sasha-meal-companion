-- Reverse of 20261231110000_food_membership_server_rev.sql. Revert the app deploy first: the sync
-- route and the Foods sheet call the 6-argument set_food_membership, and the phone reads
-- food_membership_revisions under the owner policy.
set local lock_timeout = '3s';
set local statement_timeout = '30s';

drop function if exists public.set_food_membership(uuid, text, text, text, bigint, uuid);
-- The select grant stays: RLS with no policy reads no row, as before the up migration.
drop policy if exists food_membership_revisions_owner_read on public.food_membership_revisions;
drop table if exists public.food_membership_ops;
