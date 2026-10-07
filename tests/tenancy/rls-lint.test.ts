/**
 * Spec 3.1 (Phase 9 slice 3): every account-owned table has RLS on and no `anon` policy, and the
 * list of account-owned tables that the catalog generates equals the manifest's keys, so a new
 * table fails CI until someone declares what `authenticated` may do on it.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { describe, expect, it } from "vitest";
import { HAS_DB } from "../helpers/supabase";
import { ownedTables, rlsState, userTables } from "./catalog";
import manifest from "./table-ops.json";

type Owner = "user_id" | { parent: string; fk: string };
const declared = manifest as Record<string, { owner: Owner }>;

describe.skipIf(!HAS_DB)("RLS lint (spec 3.1)", () => {
  it("every public table with user_id, and every owned child, has RLS on and no anon policy", () => {
    const bad = rlsState(userTables()).filter((t) => !t.rlsEnabled || t.anonPolicies > 0);
    expect(bad).toEqual([]);
  });

  it("the generated table list equals the manifest keys", () => {
    expect(userTables()).toEqual(Object.keys(declared).sort());
  });

  it("each table's declared owner equals the owner the catalog finds", () => {
    const wrong = ownedTables().filter((t) => {
      const owner = declared[t.table]?.owner;
      if (t.parent === null) return owner !== "user_id";
      return typeof owner !== "object" || owner.parent !== t.parent || owner.fk !== t.fk;
    }).map((t) => t.table);
    expect(wrong).toEqual([]);
  });
});
