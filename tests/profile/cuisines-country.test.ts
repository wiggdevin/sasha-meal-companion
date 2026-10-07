/**
 * Phase 18 W5, acceptance 1 and 2 on the phone side (docs/specs/phase-18-open-world-foods.md D2,
 * §6 row 4): the cuisines and country parsers match the database checks, and the sync mapping in
 * lib/sync/user-settings.ts follows the omit/null rule. The database side is
 * tests/integration/profile-sync.test.ts.
 */
import { describe, expect, it } from "vitest";
import { CUISINES } from "@/lib/foods/universe/vocabulary";
import { cuisinesFrom, parseCountryCode, parseCuisines } from "@/lib/profile/cuisines";
import { settingsProfileFromRow, settingsProfileToRow, type ProfileSettings } from "@/lib/sync/user-settings";

describe("parseCuisines (the DB check, phone side)", () => {
  it("accepts up to six distinct vocabulary words, in order", () => {
    expect(parseCuisines([])).toEqual([]);
    expect(parseCuisines(["korean", "italian"])).toEqual(["korean", "italian"]);
    expect(parseCuisines(CUISINES.slice(0, 6))).toEqual(CUISINES.slice(0, 6));
  });

  it("refuses a seventh cuisine, a duplicate, an unknown word, a label, null elements and non-arrays", () => {
    expect(parseCuisines(CUISINES.slice(0, 7))).toBeNull();
    expect(parseCuisines(["korean", "korean"])).toBeNull();
    expect(parseCuisines(["klingon"])).toBeNull();
    expect(parseCuisines(["Korean"])).toBeNull();
    expect(parseCuisines(["Mexican and Latin American"])).toBeNull();
    expect(parseCuisines([null])).toBeNull();
    expect(parseCuisines("korean")).toBeNull();
    expect(parseCuisines(null)).toBeNull();
  });

  it("reads a stored list leniently", () => {
    expect(cuisinesFrom(["korean", "klingon", "korean", ...CUISINES])).toEqual(["korean", ...CUISINES.filter((c) => c !== "korean").slice(0, 5)]);
    expect(cuisinesFrom(null)).toEqual([]);
  });
});

describe("parseCountryCode", () => {
  it("accepts two capital letters and nothing else", () => {
    expect(parseCountryCode("US")).toBe("US");
    expect(parseCountryCode("CA")).toBe("CA");
    for (const bad of ["us", "USA", "U", " US", "U1", "", null, undefined, 1]) expect(parseCountryCode(bad)).toBeNull();
  });
});

describe("sync mapping: the omit/null rule", () => {
  const base: ProfileSettings = { heightCm: null, birthYear: null, sex: null };

  it("an omitted field is omitted on the wire (the server keeps the stored value)", () => {
    for (const settings of [base, { ...base, cuisines: undefined, countryCode: undefined }]) {
      const row = settingsProfileToRow(settings);
      expect(row).not.toHaveProperty("cuisines");
      expect(row).not.toHaveProperty("country_code");
    }
  });

  it("sends a set value, and clears cuisines with [] (never null: the column is NOT NULL)", () => {
    expect(settingsProfileToRow({ ...base, cuisines: ["japanese"], countryCode: "US" }))
      .toMatchObject({ cuisines: ["japanese"], country_code: "US" });
    expect(settingsProfileToRow({ ...base, cuisines: [] })).toMatchObject({ cuisines: [] });
    expect(settingsProfileToRow({ ...base, cuisines: null })).toMatchObject({ cuisines: [] });
    expect(settingsProfileToRow({ ...base, countryCode: null })).toMatchObject({ country_code: null });
  });

  it("leaves out a value the server would refuse instead of parking the settings op", () => {
    const bad = settingsProfileToRow({ ...base,
      cuisines: [...CUISINES.slice(0, 7)], countryCode: "usa" } as ProfileSettings);
    expect(bad).not.toHaveProperty("cuisines");
    expect(bad).not.toHaveProperty("country_code");
  });

  it("pulls camelCase, and a row without the columns pulls without the fields", () => {
    expect(settingsProfileFromRow({ cuisines: ["african"], country_code: "GH" }))
      .toMatchObject({ cuisines: ["african"], countryCode: "GH" });
    expect(settingsProfileFromRow({ country_code: null })).toMatchObject({ countryCode: null });
    const old = settingsProfileFromRow({});
    expect(old).not.toHaveProperty("cuisines");
    expect(old).not.toHaveProperty("countryCode");
  });

  it("round-trips", () => {
    const pulled = settingsProfileFromRow({ cuisines: ["mediterranean", "south_asian"], country_code: "US" });
    expect(settingsProfileToRow(pulled)).toMatchObject({ cuisines: ["mediterranean", "south_asian"], country_code: "US" });
  });

  it("adds no state, region, race or ethnicity field", () => {
    const keys = Object.keys(settingsProfileToRow({ ...base, cuisines: ["american"], countryCode: "US" }));
    expect(keys.filter((key) => /state|region|race|ethnic|zip|postal|city/i.test(key))).toEqual([]);
  });
});
