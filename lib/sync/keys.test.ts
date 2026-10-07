import { describe, expect, it } from "vitest";
import { decodeKey, encodeKey } from "./keys";

const UUID = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";
const LOWER = UUID.toLowerCase();

describe("encodeKey", () => {
  it("lowercases the UUID for id-keyed entities", () => {
    for (const e of ["user_foods", "log_entries", "gut_log", "duplicate_groups"] as const) {
      expect(encodeKey(e, { id: UUID })).toBe(LOWER);
    }
  });
  it("uses YYYY-MM-DD for date-keyed entities, trimming a timestamp", () => {
    expect(encodeKey("plan_days", { local_date: "2026-09-11" })).toBe("2026-09-11");
    expect(encodeKey("water_log", { local_date: "2026-09-11T00:00:00.000Z" })).toBe("2026-09-11");
  });
  it("is the literal 'settings' for user_settings", () => {
    expect(encodeKey("user_settings", {})).toBe("settings");
    expect(encodeKey("user_settings", { user_id: UUID })).toBe("settings");
  });
  it("uses food_ref_id for user_food_prefs", () => {
    expect(encodeKey("user_food_prefs", { food_ref_id: UUID })).toBe(LOWER);
  });
  it("refuses a bad row and refuses log_items, which never syncs alone", () => {
    expect(() => encodeKey("log_entries", {})).toThrow(/log_entries/);
    expect(() => encodeKey("plan_days", { local_date: "11/09/2026" })).toThrow(/local_date/);
    expect(() => encodeKey("user_food_prefs", { food_ref_id: "nope" })).toThrow(/food_ref_id/);
    expect(() => encodeKey("log_items", { id: UUID })).toThrow(/log_items/);
  });
});

describe("decodeKey", () => {
  it("returns the primary-key columns and round-trips every synced entity", () => {
    const rows: Record<string, Record<string, unknown>> = {
      user_foods: { id: LOWER }, user_food_prefs: { food_ref_id: LOWER },
      log_entries: { id: LOWER }, water_log: { local_date: "2026-09-11" },
      plan_days: { local_date: "2026-09-11" }, user_settings: {},
      gut_log: { id: LOWER }, duplicate_groups: { id: LOWER },
    };
    for (const [entity, row] of Object.entries(rows)) {
      expect(decodeKey(entity as never, encodeKey(entity as never, row))).toEqual(row);
    }
  });
  it("refuses a malformed key", () => {
    expect(() => decodeKey("log_entries", "not-a-uuid")).toThrow(/log_entries/);
    expect(() => decodeKey("plan_days", "2026-9-1")).toThrow(/plan_days/);
    expect(() => decodeKey("user_settings", "other")).toThrow(/user_settings/);
  });
});

describe("phase 3 entity keys", () => {
  it("keys recipes and favorites_meals by their own id", () => {
    expect(encodeKey("recipes", { id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }))
      .toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(encodeKey("favorites_meals", { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }))
      .toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("keys favorites_foods by food_ref_id and favorites_recipes by recipe_id", () => {
    expect(encodeKey("favorites_foods", { food_ref_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }))
      .toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(encodeKey("favorites_recipes", { recipe_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }))
      .toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  });

  it("decodes each key back to its own column", () => {
    expect(decodeKey("recipes", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
      .toEqual({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(decodeKey("favorites_foods", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))
      .toEqual({ food_ref_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(decodeKey("favorites_recipes", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"))
      .toEqual({ recipe_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
  });

  it("refuses a favorites_recipes row with no recipe_id", () => {
    expect(() => encodeKey("favorites_recipes", { id: "nope" })).toThrow(TypeError);
  });
});
