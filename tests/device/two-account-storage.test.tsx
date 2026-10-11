// @vitest-environment jsdom
/**
 * W056 (B159): two accounts signed in, one after the other, on one browser tab. Every browser-
 * storage writer used by the first account files its value under that account (its id in the key),
 * or under a device-level key that holds no account data; the second account then reads none of it.
 * Sign-out replaces the page (lib/device/departure.ts), which keeps sessionStorage for the tab, so
 * sessionStorage counts as much as localStorage here.
 */
import "fake-indexeddb/auto";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import RecipeDetails from "@/components/RecipeDetails";
import { readStoredTasteChips, writeStoredTasteChips } from "@/components/coach/taste-chips-storage";
import { cachedCoachThread, rememberCoachThread } from "@/components/coach/coach-resume";
import { addPendingScan, readPendingScans } from "@/lib/barcode/scan-cache";
import { loadDraft, saveDraft } from "@/lib/capture/drafts";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { DEVICE_KEYS } from "@/lib/device/account-storage";
import { touchAccount } from "@/lib/device/forget";
import { readFoodMembership, readPrefRefCache } from "@/lib/foods/prefs-client";
import { dismissOnboardingInvite, readOnboardingInviteDismissedAt } from "@/lib/profile/onboarding-state";
import { closeAllAccountDbs, putMeta } from "@/lib/sync/idb";
import { defaultStore, loadStore, resetStoreCache, saveStore } from "@/lib/store";
import type { ProposeResponse } from "@/lib/capture/types";
import type { RecipeCandidate } from "@/lib/recipe-catalog/types";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
const ingredient = (seq: number, name: string) => ({ seq, name, foodRefId: `f${seq}`,
  catalogFoodRevisionId: seq, quantity: 100, unit: "g", grams: 100, state: "raw", required: true,
  purchaseGrams: 100, purchaseConversionStatus: "known", allergenEvidence: {},
  nutrition: { kcal: known(100), protein: known(10), carbs: known(5), fat: known(3) } });
/** A shared catalog recipe: the same revision id for every account. */
const recipe = {
  sourceKind: "shared", recipeId: "r1", revisionId: "shared-rev-1", publicationState: "published",
  withdrawalReason: null, name: "Chicken skillet", cuisine: "American", dishTags: [], activeMinutes: 20,
  totalMinutes: 25, effort: "standard", servings: 3, yieldGrams: null, yieldStatus: "unknown",
  minServingFraction: 0.5, maxServingFraction: 2,
  ingredients: ["Carrots", "Olive oil", "Chicken"].map((name, index) => ingredient(index + 1, name)),
  steps: [{ seq: 1, text: "Cook." }],
  nutritionPerServing: { kcal: known(508), protein: known(51), carbs: known(44), fat: known(13) },
  source: { author: "Sasha kitchen", sourceUrl: null, rightsKind: "original", rightsRecord: "o",
    sourceRevision: "1", kitchenTested: true },
  eligibility: { status: "eligible", reasons: [] },
} as unknown as RecipeCandidate;

const boxes = () => within(screen.getByRole("region", { name: "Ingredients" }))
  .getAllByRole("checkbox") as HTMLInputElement[];

/** Signs the tab over to another account the way the reload boundary leaves it: memory reset,
 *  both storages kept. */
function switchTo(userId: string) {
  cleanup();
  unbindAccount();
  resetStoreCache();
  return bindAccount(userId);
}

function allKeys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k): k is string => k !== null);
}

beforeEach(async () => {
  cleanup();
  await closeAllAccountDbs();
  unbindAccount();
  resetStoreCache();
  localStorage.clear();
  sessionStorage.clear();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(cleanup);

describe("two accounts on one tab", () => {
  it("a shared recipe's ticked ingredients stay with the account that ticked them", () => {
    bindAccount(A);
    render(<RecipeDetails recipe={recipe} />);
    fireEvent.click(boxes()[0]);
    fireEvent.click(boxes()[2]);
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true]);

    switchTo(B);
    render(<RecipeDetails recipe={recipe} />);
    expect(boxes().map((b) => b.checked)).toEqual([false, false, false]);

    switchTo(A);
    render(<RecipeDetails recipe={recipe} />);
    expect(boxes().map((b) => b.checked)).toEqual([true, false, true]);
  });

  it("every key the first account writes names it or is device-level, and the second reads none", async () => {
    const a = bindAccount(A);
    touchAccount(A);
    saveStore({ ...defaultStore(), days: { "2026-10-11": { date: "2026-10-11", eaten: {}, swaps: {},
      extras: [] } } } as unknown as ReturnType<typeof defaultStore>);
    saveDraft({ draftId: "d1", items: [] } as unknown as ProposeResponse);
    addPendingScan("00012345678905");
    dismissOnboardingInvite(new Date("2026-10-11T00:00:00Z"));
    writeStoredTasteChips(a, "p1", { actionId: "x", dislikes: ["f:okra"], cuisines: [], status: "applied" });
    rememberCoachThread(A, "thread-a");
    await putMeta(a, "probe", { owner: A });
    render(<RecipeDetails recipe={recipe} />);
    fireEvent.click(boxes()[1]);

    const deviceLevel = (k: string) => DEVICE_KEYS.includes(k) || k.startsWith("smc:device:");
    const local = allKeys(localStorage);
    const session = allKeys(sessionStorage);
    expect(local.length).toBeGreaterThan(5);
    expect(session.length).toBeGreaterThan(0);
    expect([...local, ...session].filter((k) => !k.includes(A) && !deviceLevel(k))).toEqual([]);
    // The registry is device-level, but it names accounts in its value, never their data.
    expect(JSON.parse(localStorage.getItem("smc:device:accounts") ?? "[]"))
      .toEqual([{ userId: A, lastUsedAt: expect.any(Number) }]);
    const databases = (await indexedDB.databases()).map((d) => d.name);
    expect(databases.filter((n) => !n?.includes(A))).toEqual([]);

    const b = switchTo(B);
    expect(loadStore().days).toEqual({});
    expect(loadDraft("d1")).toBeNull();
    expect(readPendingScans()).toEqual([]);
    expect(readOnboardingInviteDismissedAt()).toBeNull();
    expect(readStoredTasteChips(b, "p1")).toBeNull();
    expect(cachedCoachThread(B)).toBeNull();
    expect(readPrefRefCache(B)).toEqual({});
    expect(readFoodMembership(B, "okra")).toBeUndefined();
    render(<RecipeDetails recipe={recipe} />);
    expect(boxes().some((box) => box.checked)).toBe(false);
  });
});
