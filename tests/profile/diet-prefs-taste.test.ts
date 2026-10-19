/**
 * Phase 18 W5, acceptance 3 (docs/specs/phase-18-open-world-foods.md D6): every existing
 * `diet_prefs` writer keeps `taste`, as each keeps `water`. A writer that rebuilt the object from
 * the keys it knew would silently forget the user's confirmed dislikes on the next save.
 *
 * The inventory at the bottom lists every non-test module that names `diet_prefs` / `dietPrefs`;
 * a new one fails until it is classified here as a writer (with a case above) or a reader.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  fetch: vi.fn(), mutate: vi.fn(), flush: vi.fn(), sync: vi.fn(), loadStore: vi.fn(), saveStore: vi.fn(),
  account: { userId: "account-a", epoch: 1 },
}));
vi.mock("@/lib/device/account", () => ({
  accountHandle: () => mocked.account,
  accountFetch: mocked.fetch,
  accountJson: async (_handle: unknown, response: Response) => response.json(),
  assertCurrent: () => undefined,
}));
vi.mock("@/lib/store", async (actual) => ({ ...(await actual<typeof import("@/lib/store")>()),
  loadStore: mocked.loadStore, saveStore: mocked.saveStore }));
vi.mock("@/lib/sync/outbox", () => ({ mutateUserSettings: mocked.mutate, USER_SETTINGS_KEY: "user_settings" }));
vi.mock("@/lib/sync/client", () => ({ flushOutboxNow: mocked.flush, syncOnce: mocked.sync }));

import { saveDiet } from "@/lib/foods/diet-client";
import { defaultSettings } from "@/lib/store";
import { buildCompletedSettings, createOnboardingState, onboardingReducer } from "@/lib/profile/onboarding-state";
import { parseTaste, storedTasteKey, tasteDislike, tasteFrom } from "@/lib/profile/taste";
import {
  settingsProfileFromRow, settingsProfileToRow, settingsWithCookingEffort, type ProfileDietPrefs,
} from "@/lib/sync/user-settings";
import type { Settings } from "@/lib/types";
import { dietPrefsWithWater } from "@/lib/water-prefs";
import { settingsWithPrefsAnswers } from "@/lib/profile/onboarding-prefs-parse";

const TASTE = { dislikes: ["f:okra", "t:slimy", "t:spicy_hot"] };
const STORED: ProfileDietPrefs = { flags: ["vegetarian"], text: "No meat", lifestyle: { cookingEffort: "minimal" },
  water: { unit: "ml", goal: "manual" }, taste: TASTE as ProfileDietPrefs["taste"] };

beforeEach(() => {
  for (const mock of [mocked.fetch, mocked.mutate, mocked.flush, mocked.sync, mocked.loadStore, mocked.saveStore]) {
    mock.mockReset();
  }
});

describe("every diet_prefs writer keeps taste", () => {
  it("the sync pull (settingsProfileFromRow) reads taste and the push (settingsProfileToRow) writes it back", () => {
    const pulled = settingsProfileFromRow({ diet_prefs: STORED });
    expect(pulled.dietPrefs?.taste).toEqual(TASTE);
    expect(settingsProfileToRow(pulled).diet_prefs).toEqual(STORED);
  });

  it("the cooking-effort writer (settingsWithCookingEffort) keeps taste and water", () => {
    const next = settingsWithCookingEffort({ ...settingsProfileFromRow({ diet_prefs: STORED }) }, "full");
    expect(next.dietPrefs).toEqual({ ...STORED, lifestyle: { cookingEffort: "full" } });
  });

  it("onboarding (buildCompletedSettings) keeps taste and water while it rewrites flags and text", () => {
    let state = createOnboardingState(defaultSettings());
    for (const action of [
      { type: "edit_body", key: "heightCm", value: "165" },
      { type: "edit_body", key: "birthYear", value: "1996" },
      { type: "set_sex", value: "female" },
      { type: "edit_weight", value: "132.277" },
      { type: "set_activity", value: "moderate" },
      { type: "set_goal", value: "recomp" },
      { type: "set_prefs_text", value: "Vegetarian" },
      { type: "toggle_flag", flag: "vegetarian" },
    ] as const) state = onboardingReducer(state, action);
    const base: Settings = { ...defaultSettings(), dietPrefs: STORED };
    const done = buildCompletedSettings(base, state, new Date(2026, 9, 6, 9, 30));
    expect((done.dietPrefs as ProfileDietPrefs).taste).toEqual(TASTE);
    expect((done.dietPrefs as ProfileDietPrefs).water).toEqual(STORED.water);
    expect(settingsProfileToRow(done).diet_prefs?.taste).toEqual(TASTE);
  });

  it("the water writers (setWaterPrefs, setGoal through dietPrefsWithWater) keep taste", () => {
    expect(dietPrefsWithWater(STORED, { unit: "cups" })).toEqual({ ...STORED, water: { unit: "cups", goal: "manual" } });
  });

  it("the diet-style writer (saveDiet) keeps taste in the queued payload", async () => {
    mocked.flush.mockResolvedValue(true);
    mocked.loadStore.mockReturnValue({ settings: { dietPrefs: STORED } });
    mocked.fetch.mockResolvedValueOnce(Response.json({ dietPrefs: STORED, rev: 4 }))
      .mockResolvedValueOnce(Response.json({ dietPrefs: { ...STORED, flags: ["vegan"] }, rev: 5 }));
    mocked.mutate.mockImplementation(async (_h, edit) => edit({ rev: 4, diet_prefs: STORED }));
    await saveDiet(["vegan"], 4);
    const queued = await mocked.mutate.mock.results[0].value;
    expect(queued.op.payload.diet_prefs).toEqual({ ...STORED, flags: ["vegan"] });
  });

  it("onboarding v2's stay-away and cuisine answers (settingsWithPrefsAnswers) add dislikes and keep every other key", () => {
    const base = { ...defaultSettings(), dietPrefs: STORED } as Settings;
    const next = settingsWithPrefsAnswers(base, { cuisines: ["italian"], dislikes: ["f:okra", "f:mushrooms"] });
    expect(next.dietPrefs).toEqual({ ...STORED, taste: { dislikes: [...TASTE.dislikes, "f:mushrooms"] } });
    expect(next.cuisines).toEqual(["italian"]);
    expect(settingsWithPrefsAnswers(base, { cuisines: null, dislikes: [] })).toBe(base);
  });

  it("the eval harness's flag writer (scripts/eval/coach-streak-jev.ts) spreads the stored object", () => {
    expect(readFileSync("scripts/eval/coach-streak-jev.ts", "utf8"))
      .toMatch(/\.update\(\{ diet_prefs: \{ \.\.\.kept, flags \} \}\)/);
  });

  it("the Settings water mirror (components/settings/WaterSection.tsx) spreads the stored object", () => {
    const source = readFileSync("components/settings/WaterSection.tsx", "utf8");
    expect(source).toMatch(/\{\s*\.\.\.\(store\.settings\.dietPrefs \?\? \{ flags: \[\] \}\), water: prefs \}/);
  });

  it("a stored key the database accepts is kept exactly on read and push; one it never could hold is dropped", () => {
    const pulled = settingsProfileFromRow({ diet_prefs: { flags: [],
      taste: { dislikes: ["f:okra", "t:not_a_tag", "x:okra", "f:Okra", "f:okra"] } } as unknown as ProfileDietPrefs });
    // "f:Okra" is not canonical (a new write refuses it) but the database stores it: never rewritten or dropped.
    expect(pulled.dietPrefs?.taste).toEqual({ dislikes: ["f:okra", "f:Okra"] });
    expect(settingsProfileToRow(pulled).diet_prefs?.taste).toEqual({ dislikes: ["f:okra", "f:Okra"] });
    // A taste that is not an object is not kept at all.
    const odd = settingsProfileFromRow({ diet_prefs: { flags: [], taste: null } as unknown as ProfileDietPrefs });
    expect(odd.dietPrefs).toEqual({ flags: [] });
    expect(settingsProfileToRow(odd).diet_prefs).toEqual({ flags: [] });
  });
});

describe("the taste parser", () => {
  it("accepts families and reviewed tags, at most 50, no duplicates", () => {
    expect(parseTaste({ dislikes: ["f:okra", "t:slimy"] })).toEqual({ dislikes: ["f:okra", "t:slimy"] });
    expect(parseTaste({})).toEqual({});
    expect(parseTaste({ dislikes: Array.from({ length: 50 }, (_, i) => `f:food ${i}`) })?.dislikes).toHaveLength(50);
  });

  it("refuses a 51st key, a duplicate, an unknown tag, an unnormalized family, extra keys and non-objects", () => {
    expect(parseTaste({ dislikes: Array.from({ length: 51 }, (_, i) => `f:food ${i}`) })).toBeNull();
    expect(parseTaste({ dislikes: ["f:okra", "f:okra"] })).toBeNull();
    expect(parseTaste({ dislikes: ["t:crunchy_ish"] })).toBeNull();
    expect(parseTaste({ dislikes: ["f:Okra"] })).toBeNull();
    expect(parseTaste({ dislikes: ["f:okra, raw"] })).toBeNull();
    expect(parseTaste({ dislikes: ["okra"] })).toBeNull();
    expect(parseTaste({ dislikes: [7] })).toBeNull();
    expect(parseTaste({ dislikes: "f:okra" })).toBeNull();
    expect(parseTaste({ dislikes: [], likes: ["f:kale"] })).toBeNull();
    expect(parseTaste(null)).toBeNull();
    expect(parseTaste(["f:okra"])).toBeNull();
  });

  it("refuses a family jsonb cannot store: U+0000 or a lone surrogate", () => {
    expect(parseTaste({ dislikes: ["f:a\u0000b"] })).toBeNull();
    expect(parseTaste({ dislikes: ["f:a\ud800b"] })).toBeNull();
    expect(parseTaste({ dislikes: ["f:a\udc00"] })).toBeNull();
    expect(parseTaste({ dislikes: ["f:🥑"] })).toEqual({ dislikes: ["f:🥑"] });
  });

  it("the stored-key reader takes the storage contract; the write parser also wants the canonical family", () => {
    for (const key of ["f:Okra", "f:green  beans", "f: okra", "f:okra, raw", "f:\u00a0x"]) {
      expect(storedTasteKey(key)).toBe(key);
      expect(tasteDislike(key)).toBeNull();
    }
    for (const key of ["f:", "f:a\u0000b", "f:a\ud800b", "f:a\udc00", `f:${"a".repeat(81)}`, "t:nope", "x:okra", 7]) {
      expect(storedTasteKey(key)).toBeNull();
    }
    expect(storedTasteKey(`f:${"a".repeat(80)}`)).toBe(`f:${"a".repeat(80)}`);
    expect(storedTasteKey(`f:${"🥑".repeat(80)}`)).toBe(`f:${"🥑".repeat(80)}`);
  });

  it("reads leniently: drops what it does not know and cuts at 50", () => {
    expect(tasteFrom({ dislikes: Array.from({ length: 60 }, (_, i) => `f:food ${i}`) })?.dislikes).toHaveLength(50);
    expect(tasteFrom({ dislikes: "nope" })).toEqual({});
    expect(tasteFrom("nope")).toBeNull();
  });
});

describe("diet_prefs inventory", () => {
  /** Writers have a case in "every diet_prefs writer keeps taste" above; readers only read flags/water/text;
   *  seeds write the first row of a new synthetic test account (scripts/), where nothing exists to keep. */
  const CLASSIFIED: Record<string, "writer" | "reader" | "seed"> = {
    "lib/sync/user-settings.ts": "writer",
    "lib/profile/onboarding-state.ts": "writer",
    "lib/foods/diet-client.ts": "writer",
    "lib/water-prefs.ts": "writer",
    "lib/profile/onboarding-prefs-parse.ts": "writer",
    // Reads the stored flags to seed the practice question; writes go through settingsWithPrefsAnswers.
    "components/Onboarding/ConversationalOnboarding.tsx": "reader",
    "lib/water-client.ts": "writer",
    "components/settings/WaterSection.tsx": "writer",
    "scripts/eval/coach-streak-jev.ts": "writer",
    // Name diet_prefs.text only in the privacy note (the field's raw text is saved as on main).
    "lib/profile/prefs-client.ts": "reader",
    "lib/profile/taste-safety.ts": "reader",
    // Phase 18 W5b-2: the confirm's wire contract names the column in prose only; the write is the
    // taste_chips_confirm RPC, which keeps every other diet_prefs key (tests/migrations/taste-chips-confirm-db.test.ts).
    "lib/profile/taste-confirm.ts": "reader",
    // Followups #1: the remove/undo wire contract names the column in prose only (one error code);
    // the write is the taste_dislike_remove / taste_dislike_remove_undo RPCs, which keep every
    // other diet_prefs key the same way taste_chips_confirm does.
    "lib/profile/taste-dislike-remove.ts": "reader",
    // The settings algebra replays a diet_prefs edit by the sub-keys it changed and keeps the rest of
    // the server's row, taste included (tests/sync/settings-subkey-intents.test.ts).
    "lib/sync/settings-intents.ts": "reader",
    // Seeds: each creates a brand-new synthetic test account's first row, so no stored taste exists to keep.
    "scripts/coach-live-check.ts": "seed",
    "scripts/eval/coach-streak-harness.ts": "seed",
    "scripts/audit/data-integrity.ts": "reader",
    "lib/profile/taste.ts": "reader",
    "lib/types.ts": "reader",
    "lib/store.ts": "reader",
    "lib/today/widget-prefs.ts": "reader",
    "lib/server/dietary-profiles.ts": "reader",
    "lib/server/recipe-plan.ts": "reader",
    "lib/server/export.ts": "reader",
    "lib/server/log.ts": "reader",
    "lib/server/export-water.ts": "reader",
    "lib/server/candidate-foods.ts": "reader",
    "lib/server/meal-snapshot-v3.ts": "reader",
    "lib/server/recipe-candidates.ts": "reader",
    // W014 (A130): reads diet_prefs.flags to screen menu dishes; never writes the column.
    "lib/server/plan-menu.ts": "reader",
    "lib/server/coach-context.ts": "reader",
    "lib/coach/suggest-policy.ts": "reader",
    "lib/recipes/recipe-freshness.ts": "reader",
    "lib/recipes/accepted-client.ts": "reader",
    "lib/foods/rule-marks.ts": "reader",
    "lib/foods/eligible-client.ts": "reader",
    "lib/foods/starter-seed.ts": "reader",
    "lib/foods/world/admission.ts": "reader",
    "app/api/foods/diet/route.ts": "reader",
    "components/AvoidsView.tsx": "reader",
    // Reads settings.dietPrefs.taste.dislikes to show the current, read-only dislike pills
    // (Phase 18 W5b-3 UI gate); writes go through TasteChipsField's own confirm/undo contract.
    "components/settings/CuisinesSection.tsx": "reader",
    "components/shopping/BuildListCard.tsx": "reader",
    "components/MyFoods.rule-marks.ts": "reader",
    "components/ShoppingRoot.tsx": "reader",
    // Passes settings.dietPrefs to currentEligibleView to judge a heart's Favored marks.
    "lib/favorite-meals-client.ts": "reader",
  };

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sources(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it("names every module that touches diet_prefs", () => {
    const found = ["lib", "app", "components", "scripts"].flatMap(sources)
      .filter((file) => /\b(diet_prefs|dietPrefs)\b/.test(readFileSync(file, "utf8")))
      .map((file) => file.split(path.sep).join("/")).sort();
    expect(found.filter((file) => !(file in CLASSIFIED))).toEqual([]);
  });
});
