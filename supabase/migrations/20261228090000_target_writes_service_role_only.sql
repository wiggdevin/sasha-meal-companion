-- Target writes are service-role only (onboarding v2 security fix, branch fix/onb2-qs-backend).
--
-- THE HOLE. write_target_revision, write_target_revision_if_active, write_target_revision_pair
-- and approve_target_proposal are SECURITY DEFINER and were granted to `authenticated`
-- (20261023090000, 20261023091000, 20261029090000, 20261208100000, 20261209090000). Their own
-- guard (_sync_assert_caller) only binds p_user_id to auth.uid(), so a signed-in user could call
-- them over PostgREST for their OWN account and write any revision: skip the adult floor, the
-- pregnancy / kidney / eating-disorder / clinician pace holds, the pace caps and the floors that
-- lib/server/targets.ts and lib/server/proposals.ts apply before every write.
--
-- THE FIX. Revoke EXECUTE from public, anon and authenticated; keep service_role. The app calls
-- all four through lib/server/target-writes.ts (the service-role client, with the session-verified
-- user id). Privileges live on the pg_proc row and survive a later `create or replace`; only a
-- drop + create resets them, and that migration must repeat this revoke.
--
-- Function bodies are unchanged. Their _sync_assert_caller guard still passes for the service
-- role (no auth.uid()), and the SQL callers (write_target_revision_if_active and _pair call
-- write_target_revision; approve_target_proposal calls it too) are SECURITY DEFINER and run as
-- the owner, so they keep EXECUTE.
--
-- Order: apply AFTER the app build with lib/server/target-writes.ts is live. That build writes as
-- the service role and works before and after this file; an older build writes on the session
-- client and gets 42501 once this is applied.
--
-- Live-safe: privilege changes only, no table lock beyond the catalog row; lock_timeout bounds it.
set local lock_timeout = '3s';

revoke execute on function public.write_target_revision(uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.write_target_revision_if_active(uuid, jsonb, uuid, bigint)
  from public, anon, authenticated;
revoke execute on function public.write_target_revision_pair(uuid, jsonb, jsonb)
  from public, anon, authenticated;
revoke execute on function public.approve_target_proposal(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.write_target_revision(uuid, jsonb) to service_role;
grant execute on function public.write_target_revision_if_active(uuid, jsonb, uuid, bigint)
  to service_role;
grant execute on function public.write_target_revision_pair(uuid, jsonb, jsonb) to service_role;
grant execute on function public.approve_target_proposal(uuid, uuid) to service_role;
