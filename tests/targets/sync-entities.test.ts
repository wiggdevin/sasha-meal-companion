import { describe, expect, it } from "vitest";
import { ENTITIES } from "@/lib/sync/types";
import { decodeKey, encodeKey } from "@/lib/sync/keys";
import { MergeRefusedError, mergeEntity, NEVER_MERGED } from "@/lib/sync/merge";
import { DB_VERSION } from "@/lib/sync/idb";

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("target_profiles and target_proposals as pull-only entities", () => {
  it("are in ENTITIES so a pulled change row lands in the client store", () => {
    expect(ENTITIES).toContain("target_profiles");
    expect(ENTITIES).toContain("target_proposals");
  });
  it("are uuid-keyed and round-trip", () => {
    for (const e of ["target_profiles", "target_proposals"] as const) {
      expect(encodeKey(e, { id: UUID.toUpperCase() })).toBe(UUID);
      expect(decodeKey(e, UUID)).toEqual({ id: UUID });
    }
  });
  it("are never merged — the server wins outright", () => {
    expect(NEVER_MERGED.has("target_profiles")).toBe(true);
    expect(NEVER_MERGED.has("target_proposals")).toBe(true);
    for (const e of ["target_profiles", "target_proposals"] as const) {
      expect(() => mergeEntity(e, { id: UUID }, { id: UUID }, "2026-09-11T00:00:00.000Z",
        "2026-09-11T00:00:01.000Z")).toThrow(MergeRefusedError);
    }
  });
  it("creates the two stores from empty in the per-account database (Phase 9 §0.2: v1)", () => {
    expect(DB_VERSION).toBe(1);
  });
});
