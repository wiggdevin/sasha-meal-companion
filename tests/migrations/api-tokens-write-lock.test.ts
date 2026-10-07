// Audit 2026-09-13, gap-privileged-boundary-5 (critical): 20260911000500_rls.sql's pattern-1 loop
// gave api_tokens the same full _rw policy and all four grants as every owner table. A token row's
// token_hash is resolved only by the service-role RPC lookup_api_token (20260911000600_rpc.sql,
// revoked from authenticated) — the table itself is meant to be written only by the server-side
// issuance flow (lib/server/tokens.ts) and the revoke_api_token RPC, never directly by a client
// holding a plain user JWT. Left open, any signed-in session can INSERT its own api_tokens row
// with token_hash set to a hash of a secret it picked, any scopes, and no expiry — self-minting a
// full-scope MCP credential that bypasses server issuance entirely and never appears in any
// "create token" UI for her to notice or revoke.
//
// No later migration narrowed this, unlike the identical fix already shipped for
// health_samples/ingest_events (20260925000000_phase5_health_ingest.sql: "Phase 0's pattern-1 loop
// gave both tables a full _rw policy and all four grants... revoke insert, update, delete on table
// health_samples from authenticated"). This migration mirrors that fix for api_tokens. Modeled on
// the static-assertion pattern tests/coach/migration.test.ts and tests/migrations/down-coverage.test.ts
// already use for up/down migration pairs — no live Supabase branch needed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const up = (f: string) => readFileSync(path.join(root, "supabase/migrations", f), "utf8");
const down = (f: string) => readFileSync(path.join(root, "supabase/migrations/down", f), "utf8");

const LOCK = "20261015000000_lock_api_tokens_writes.sql";
const LOCK_DOWN = "20261015000000_lock_api_tokens_writes.down.sql";

describe("api_tokens is locked to read-only for authenticated", () => {
  it("drops the Phase 0 _rw policy and replaces it with a select-only policy on her own rows", () => {
    const sql = up(LOCK);
    expect(sql).toContain("drop policy api_tokens_rw on api_tokens");
    expect(sql).toContain("create policy api_tokens_ro on api_tokens for select to authenticated");
    expect(sql).toContain("using (user_id = (select auth.uid()))");
  });

  it("revokes insert, update and delete from authenticated — select stays granted", () => {
    const sql = up(LOCK);
    expect(sql).toMatch(/revoke insert, update, delete on table api_tokens from authenticated/);
    // A blanket revoke would also pull the select grant Phase 0 already made; this fix must only
    // narrow the write surface, not break the read path her token-status UI (if any) still needs.
    expect(sql).not.toMatch(/revoke all on table api_tokens/);
    expect(sql).not.toMatch(/revoke select[^;]*api_tokens/);
  });

  it("has a down file that restores the Phase 0 owner-table shape exactly", () => {
    const sql = down(LOCK_DOWN);
    expect(sql).toContain("drop policy if exists api_tokens_ro on api_tokens");
    expect(sql).toContain("create policy api_tokens_rw on api_tokens for all to authenticated");
    expect(sql).toContain("grant insert, update, delete on table api_tokens to authenticated");
  });
});
