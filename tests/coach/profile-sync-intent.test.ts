import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it } from "vitest";
import { resetTestAccount } from "@/tests/helpers/account";
import { defaultSettings } from "@/lib/store";
import { syncProfileSettings } from "@/lib/coach/apply-profile";
import { applyPulledUserSettings, USER_SETTINGS_KEY } from "@/lib/sync/settings";
import { allOps, getRow } from "@/lib/sync/idb";
import type { AccountHandle } from "@/lib/device/account";
let h: AccountHandle;
beforeEach(async () => { h = await resetTestAccount(); globalThis.indexedDB = new IDBFactory(); });
it("a meal-count edit on an unloaded device preserves the server profile and pins", async () => {
  const saved = { rev: 7, height_cm: 180, goal: "lose_fat", onboarded_at: "2026-09-20T12:00:00Z",
    diet_prefs: { flags: ["vegan"] }, meals_per_day: 5, training_kcal: 2200, rest_kcal: 1900, protein_g: 130 };
  await applyPulledUserSettings(h, saved, 7);
  await syncProfileSettings({ ...defaultSettings(), mealsPerDay: 4 }, h, ["mealsPerDay"]);
  expect(await getRow(h, "user_settings", USER_SETTINGS_KEY)).toMatchObject({ ...saved, meals_per_day: 4, rev: 8 });
  const op = (await allOps(h))[0];
  expect(op.intents).toEqual([{ key: "meals_per_day", value: 4 }]);
});
it("an intentional clear remains a clear without clearing other fields", async () => {
  await applyPulledUserSettings(h, { rev: 2, body_fat_pct: 25, body_fat_source: "dexa",
    body_fat_measured_on: "2026-09-01", height_cm: 180 }, 2);
  await syncProfileSettings({ ...defaultSettings(), bodyFatPct: null }, h, ["bodyFatPct"]);
  expect(await getRow(h, "user_settings", USER_SETTINGS_KEY)).toMatchObject({
    height_cm: 180, body_fat_pct: null, body_fat_source: null, body_fat_measured_on: null });
});

it("an edit before the first pull adds only its field to the arriving profile", async () => {
  await syncProfileSettings({ ...defaultSettings(), mealsPerDay: 3 }, h, ["mealsPerDay"]);
  await applyPulledUserSettings(h, { height_cm: 180, onboarded_at: "2026-09-20T12:00:00Z",
    diet_prefs: { flags: ["vegan"] }, meals_per_day: 5, training_kcal: 2200 }, 7);
  expect(await getRow(h, "user_settings", USER_SETTINGS_KEY)).toMatchObject({
    height_cm: 180, onboarded_at: "2026-09-20T12:00:00Z", diet_prefs: { flags: ["vegan"] },
    meals_per_day: 3, training_kcal: 2200 });
  expect((await allOps(h))[0].intents).toEqual([{ key: "meals_per_day", value: 3 }]);
});
