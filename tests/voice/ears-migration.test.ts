/**
 * Phase 14 slice 1 — 20261117090000_voice_ears.sql, the live-dictation minute ledger.
 *
 * Pins what a careless edit to the historical file would break (service-role only, RLS forced,
 * the per-user lock before the checks). Phase 14 is retired (OD05,
 * docs/specs/phase-14-voice-agent.md) and 20270102090000_voice_ears_cleanup.sql drops this table
 * and its three functions, so a migrated database no longer has them and the branch half that ran
 * the real functions is gone; tests/migrations/voice-ears-cleanup-db.test.ts runs the original
 * and the cleanup together inside a rolled-back transaction.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const NAME = "20261117090000_voice_ears";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8");
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");

describe(`${NAME}.sql (text)`, () => {
  it("forces RLS on the ledger and gives it to the service role only", () => {
    expect(UP).toContain("alter table voice_ears enable row level security");
    expect(UP).toContain("alter table voice_ears force row level security");
    expect(UP).toContain("revoke all on table voice_ears from anon, authenticated");
    expect(UP).toContain("grant all on table voice_ears to service_role");
  });

  it("revokes every function from authenticated and grants it to service_role", () => {
    for (const sig of ["voice_ears_open(uuid, integer, integer)",
      "voice_ears_close(uuid, uuid)", "voice_ears_refuse(uuid, uuid)"]) {
      expect(UP).toContain(`revoke execute on function ${sig} from public, anon, authenticated`);
      expect(UP).toContain(`grant execute on function ${sig} to service_role`);
    }
  });

  it("has no way for a reported duration to lower a charge", () => {
    expect(UP).not.toMatch(/used_seconds\s+integer\s*,\s*p_floor/);
    expect(UP).not.toContain("charged_seconds");
    expect(UP).toContain("sum(v.reserved_seconds)");
  });

  it("takes the per-user lock before it checks anything", () => {
    const lock = UP.indexOf("pg_advisory_xact_lock");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(UP.indexOf("'busy'"));
    expect(lock).toBeLessThan(UP.indexOf("'exhausted'"));
  });

  it("down drops the three functions and the table", () => {
    expect(DOWN).toContain("drop function if exists voice_ears_open(uuid, integer, integer)");
    expect(DOWN).toContain("drop function if exists voice_ears_close(uuid, uuid)");
    expect(DOWN).toContain("drop function if exists voice_ears_refuse(uuid, uuid)");
    expect(DOWN).toContain("drop table if exists voice_ears");
  });
});
