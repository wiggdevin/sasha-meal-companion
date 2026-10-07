-- Restores Phase 0's owner-table shape for api_tokens exactly (20260911000500_rls.sql pattern 1):
-- one full _rw policy, plus insert/update/delete back on the authenticated grant (select was
-- never revoked, so it is not re-granted here).
drop policy if exists api_tokens_ro on api_tokens;
create policy api_tokens_rw on api_tokens for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant insert, update, delete on table api_tokens to authenticated;
