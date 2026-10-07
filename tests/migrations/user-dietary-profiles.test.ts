/**
 * Phase 13 slice 4 — 20261120090000_user_dietary_profiles.sql, the confirmed profile-instance
 * table (§4, §9 R5). Text-only: pins RLS, the owner-scoped policy, the service-role bypass and the
 * shape checks a careless edit would break. A live-branch half would duplicate
 * tests/migrations/allergen-evidence.test.ts's pattern; this table needs no server-side function,
 * so there is nothing a branch run would prove that the text checks below do not already pin.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const NAME = "20261120090000_user_dietary_profiles";
const UP = readFileSync(`supabase/migrations/${NAME}.sql`, "utf8");
const DOWN = readFileSync(`supabase/migrations/down/${NAME}.down.sql`, "utf8");

describe(`${NAME}.sql`, () => {
  it("forces RLS and scopes reads/writes to the row's own owner", () => {
    expect(UP).toContain("alter table user_dietary_profiles enable row level security");
    expect(UP).toContain("alter table user_dietary_profiles force row level security");
    expect(UP).toContain("using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))");
  });

  it("gives the service role its own bypass policy, separate from the owner policy", () => {
    expect(UP).toMatch(/create policy user_dietary_profiles_service_role[\s\S]*?to service_role/);
    expect(UP).toContain("grant all on table user_dietary_profiles to service_role");
  });

  it("revokes the table from anon and public before granting authenticated its own scope", () => {
    const revoke = UP.indexOf("revoke all on table user_dietary_profiles from public, anon, authenticated");
    const grant = UP.indexOf("grant select, insert, update, delete on table user_dietary_profiles to authenticated");
    expect(revoke).toBeGreaterThan(0);
    expect(grant).toBeGreaterThan(revoke);
  });

  it("keys one row per account per profile, never two open rows for the same profile", () => {
    expect(UP).toContain("primary key (user_id, profile_id)");
  });

  it("only ever accepts a JSON array for rules and a JSON object for options", () => {
    expect(UP).toContain("check (jsonb_typeof(rules) = 'array')");
    expect(UP).toContain("check (jsonb_typeof(options) = 'object')");
  });

  it("constrains source to the three ProfileSource values types.ts declares", () => {
    expect(UP).toContain(
      "check (source in ('user_stated', 'clinician_directed_per_user', 'coach_suggested_confirmed'))",
    );
  });

  it("requires confirmed_at (R5: a profile only has effect once confirmed)", () => {
    expect(UP).toMatch(/confirmed_at timestamptz not null,/);
  });

  it("down drops the table", () => {
    expect(DOWN).toContain("drop table if exists user_dietary_profiles");
  });
});
