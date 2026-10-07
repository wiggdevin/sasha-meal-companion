-- Audit 2026-09-13, gap-privileged-boundary-5 (critical). 20260911000500_rls.sql's pattern-1 loop
-- gave api_tokens the same full _rw policy and all four grants as every owner table. A token row's
-- token_hash is meant to be resolved only by the service-role RPC lookup_api_token
-- (20260911000600_rpc.sql, revoked from public/anon/authenticated) — the table itself is written
-- only by the server-side issuance flow (lib/server/tokens.ts) and the revoke_api_token RPC, never
-- directly by a client holding a plain user JWT. Left open, RLS's own user_id = auth.uid() check
-- let any signed-in session INSERT its own api_tokens row with a hash of a secret it picked, any
-- scopes, and no expiry — self-minting a full-scope MCP credential that bypasses server issuance
-- entirely and never shows up in any UI for her to notice or revoke.
--
-- Same fix Phase 5 already shipped for the identical shape on health_samples/ingest_events
-- (20260925000000_phase5_health_ingest.sql): drop the _rw policy, replace it with a select-only
-- policy on her own rows, and revoke the write grants — narrower than health_ingest's fix only in
-- keeping api_tokens' existing insert path closed rather than opening a new one, since api_tokens
-- never had a legitimate client insert path to begin with.
drop policy api_tokens_rw on api_tokens;
create policy api_tokens_ro on api_tokens for select to authenticated
  using (user_id = (select auth.uid()));
revoke insert, update, delete on table api_tokens from authenticated;
