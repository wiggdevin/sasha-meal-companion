/**
 * UI-NEEDS MASCOT (coord.md 2026-10-07T12:38Z): the chosen companion, end to end on the phone.
 * lib/profile/mascot.ts's key list and fallback mirror components/today/island/mascots.ts's
 * (the UI lane's richer catalog) -- this file holds the two equal. lib/today/pet-mood.ts's lines
 * take the chosen name without changing any unmodified caller's behaviour. lib/sync/user-settings.ts
 * follows the existing omit-keeps rule (the column itself never clears to null either way).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_MASCOT, MASCOT_KEYS, MASCOT_NAMES, isMascotKey, mascotKeyOf, mascotNameOf }
  from "@/lib/profile/mascot";
import { PET_ART, PET_NAME, petState, type PetDay } from "@/lib/today/pet-mood";
import { settingsProfileFromRow, settingsProfileToRow, type ProfileSettings } from "@/lib/sync/user-settings";

describe("lib/profile/mascot.ts", () => {
  it("has the four keys the UI lane's catalog uses, and Sprout is the default", () => {
    expect(MASCOT_KEYS).toEqual(["sprout", "blueberry", "mushroom", "peapod"]);
    expect(DEFAULT_MASCOT).toBe("sprout");
  });

  it("matches components/today/island/mascots.ts's own key list exactly, once it lands", () => {
    // Static text match (no cross-lane import): the UI lane owns the richer catalog, this file
    // owns the thin id-only twin. A test holds the two EXACT key sets equal (Sol review NIT: a
    // "contains" check alone would miss a key the UI added or renamed that this file lacks).
    let mascotsTs: string | null = null;
    try {
      mascotsTs = readFileSync("components/today/island/mascots.ts", "utf8");
    } catch {
      mascotsTs = null;
    }
    if (mascotsTs === null) return; // Not landed in this worktree yet; nothing to compare.
    // Each mascot's own entry is `<key>: { key: "<key>", ...`; collect every such key.
    const found = [...mascotsTs.matchAll(/^\s*([a-z]+): \{ key: "\1"/gm)].map((m) => m[1]);
    expect(found.sort()).toEqual([...MASCOT_KEYS].sort());
  });

  it("isMascotKey/mascotKeyOf: a known key passes through, anything else falls back to sprout", () => {
    for (const key of MASCOT_KEYS) {
      expect(isMascotKey(key)).toBe(true);
      expect(mascotKeyOf(key)).toBe(key);
    }
    for (const bad of ["Sprout", "SPROUT", "klingon", "", null, undefined, 7, ["sprout"]]) {
      expect(isMascotKey(bad)).toBe(false);
      expect(mascotKeyOf(bad)).toBe("sprout");
    }
  });

  it("mascotNameOf: the working display name, falling back the same way", () => {
    expect(mascotNameOf("sprout")).toBe("Sprout");
    expect(mascotNameOf("blueberry")).toBe("Blu");
    expect(mascotNameOf("mushroom")).toBe("Button");
    expect(mascotNameOf("peapod")).toBe("Pod");
    expect(mascotNameOf("unknown")).toBe("Sprout");
    expect(mascotNameOf(null)).toBe("Sprout");
    expect(new Set(Object.values(MASCOT_NAMES)).size).toBe(MASCOT_KEYS.length); // no two share a name
  });
});

describe("petState takes the chosen mascot without changing an unmodified caller", () => {
  const day = (kcal: number, protein: number, cups?: number, extra: Partial<PetDay> = {}): PetDay => ({
    targets: { kcal: 2000, protein: 150, carbs: 0, fat: 0 },
    consumed: { kcal, protein, carbs: 0, fat: 0 },
    ...(cups !== undefined ? { water: { cups, goal: 8 } } : {}),
    ...extra,
  });

  it("every existing call site (no fourth argument) still says Sprout, PET_NAME unchanged", () => {
    expect(PET_NAME).toBe("Sprout");
    expect(petState(day(0, 0, 0), 8).line).toBe("Sprout is thriving today.");
    expect(petState(day(0, 0), 10, "future").line).toBe("Sprout is waiting for this day.");
    expect(petState(day(300, 20, 1), 23, "past").line).toBe("A quieter day for Sprout.");
    expect(Object.keys(PET_ART).sort()).toEqual(["content", "droopy", "joyful", "sleepy"]);
  });

  it("names the chosen companion in every line kind, including the past-droopy one", () => {
    expect(petState(day(0, 0, 0), 8, "today", "blueberry").line).toBe("Blu is thriving today.");
    expect(petState(day(0, 0), 10, "future", "mushroom").line).toBe("Button is waiting for this day.");
    expect(petState(day(300, 20, 1), 23, "past", "peapod").line).toBe("A quieter day for Pod.");
    expect(petState(day(2000, 150, 8), 22, "today", "blueberry").line).toBe("Blu is asleep. Rest well.");
  });

  it("an unknown or stored-but-unrecognised mascot falls back to Sprout, never an error", () => {
    expect(petState(day(0, 0, 0), 8, "today", "klingon" as never).line).toBe("Sprout is thriving today.");
  });
});

describe("Settings.mascot: the sync omit/null rule (lib/sync/user-settings.ts)", () => {
  const base: ProfileSettings = { heightCm: null, birthYear: null, sex: null };

  it("an omitted field is omitted on the wire (the server keeps the stored value)", () => {
    expect(settingsProfileToRow(base)).not.toHaveProperty("mascot");
    expect(settingsProfileToRow({ ...base, mascot: undefined })).not.toHaveProperty("mascot");
  });

  it("sends a chosen mascot, validated to a known key", () => {
    expect(settingsProfileToRow({ ...base, mascot: "blueberry" })).toMatchObject({ mascot: "blueberry" });
    expect(settingsProfileToRow({ ...base, mascot: "klingon" as never })).toMatchObject({ mascot: "sprout" });
  });

  it("reads the stored value leniently, always present (the column is NOT NULL, default 'sprout')", () => {
    expect(settingsProfileFromRow({ mascot: "peapod" })).toMatchObject({ mascot: "peapod" });
    expect(settingsProfileFromRow({ mascot: "sprout" })).toMatchObject({ mascot: "sprout" });
    expect(settingsProfileFromRow({ mascot: "something-new" })).toMatchObject({ mascot: "sprout" });
    expect(settingsProfileFromRow({})).toMatchObject({ mascot: "sprout" });
  });

  it("round-trips a chosen mascot through pull then push unchanged", () => {
    for (const key of ["sprout", "blueberry", "mushroom", "peapod"] as const) {
      const pulled = settingsProfileFromRow({ mascot: key });
      expect(settingsProfileToRow(pulled)).toMatchObject({ mascot: key });
    }
  });
});
