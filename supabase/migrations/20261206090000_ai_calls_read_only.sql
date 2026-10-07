-- ai_calls is the server's spend and failure ledger: assertUnderSpendCap sums its cost_estimate,
-- assertCircuitClosed counts its failures and the capture caps count its rows. Phase 0
-- (20260911000500_rls.sql) gave it the generic owner shape — a FOR ALL policy plus insert, update
-- and delete grants — so a signed-in user could delete or zero her own rows through PostgREST and
-- reset all three guards. Every writer already uses the service role (lib/ai/call-ledger.ts,
-- lib/ai/typesafe.ts, lib/server/{capture,ui-lane,voice-ears}.ts); the one user-session read is
-- the capture replay check in lib/server/capture.ts. She keeps select on her own rows, nothing else.
drop policy if exists ai_calls_rw on ai_calls;
create policy ai_calls_read on ai_calls for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on table ai_calls from anon, authenticated;
