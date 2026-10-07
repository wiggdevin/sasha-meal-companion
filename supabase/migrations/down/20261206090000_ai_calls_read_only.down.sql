-- Restores the Phase 0 owner shape on ai_calls (FOR ALL policy plus write grants).
drop policy if exists ai_calls_read on ai_calls;
create policy ai_calls_rw on ai_calls for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant insert, update, delete on table ai_calls to authenticated;
