/**
 * 2026-10-05 calculation audit F1-F3: saved plan content is judged against the account's CURRENT
 * food rules on read. It is marked, never hidden or deleted; eaten content is history and is
 * never re-judged; a verified eligible set or recipe verdict is never reused across a rules change.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDay } from "@/lib/resolve";
import { defaultSettings } from "@/lib/store";
import { withAcceptedRecipeSelections } from "@/lib/recipes/accepted-overlay";
import { StampedEligibleSet } from "@/lib/foods/eligible-client";
import {
  foodRulesEpoch, noteFoodRulesChanged, noteRulesRevision, noteRulesSignature,
  resetFoodRulesMemoryForTests, SYNCED_EVENT as EPOCH_SYNCED_EVENT,
} from "@/lib/foods/rules-epoch";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { loadStore, saveStore } from "@/lib/store";
import { loadRuleReview } from "@/lib/rule-review-client";
import { confirmFoodPreference, confirmProfileInstance, fetchProfileInstances, removeProfileInstance,
} from "@/lib/profile/instances-client";
import { foodRulesKey } from "@/lib/foods/rule-marks";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { submitRuleReview } from "@/lib/rule-review-client";
import { loadConstraints, saveConstraints } from "@/lib/constraints-client";
import { recipeEligibility } from "@/lib/recipes/eligibility";
import { EMPTY_PROFILE } from "@/lib/policy/constraints";
import type { Food } from "@/lib/foods";
import type { AcceptedRecipeSelection } from "@/lib/shopping/preview-contract";
import type { FoodComponent, RuleMark, Store, StoredDay } from "@/lib/types";
import { ingredient, recipe } from "../recipes/fixture";
import { F } from "@/tests/helpers/meal-foods";
import { loadAcceptedRecipeSelections } from "@/lib/recipes/accepted-client";

vi.mock("server-only", () => ({}));
const { hasUnjudgedLine, recipeFlagsFrom, ruleMarkFromEligibility } = await import("@/lib/server/recipe-candidates");

const DAY = "2026-10-06";
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const food = (id: string, name: string, status: Food["status"] = "eats"): Food => ({
  id, name, role: "fat", unit: "tbsp", perUnit: { protein: 4, carbs: 3, fat: 8 },
  status, updatedAt: "2026-10-01",
});

const line = (name: string): FoodComponent => ({ name, qty: 2, unit: "tbsp", role: "fat",
  macros: { kcal: 190, protein: 8, carbs: 6, fat: 16 } });

function storeWith(day: Partial<StoredDay>, foods: Food[], settings = defaultSettings()): Store {
  return { version: 1, firstOpenedAt: "2026-08-01T12:00:00.000Z", settings,
    days: { [DAY]: { date: DAY, ...day } },
    foods: Object.fromEntries(foods.map((entry) => [entry.id, entry])) };
}

const savedSlot = (components: FoodComponent[]) => ({ itemOverrides: { "meal-2": {
  baseMealId: null, title: "Snack", components } } }) satisfies Partial<StoredDay>;

/** A set verified now, in the current rules epoch. */
const stamped = (ids: string[], marks: [string, RuleMark][] = [], settings = defaultSettings()) =>
  new StampedEligibleSet(ids, new Map(marks), foodRulesKey(settings), foodRulesEpoch());

const slot = (store: Store, eligible?: ReadonlySet<string>) =>
  resolveDay(store, DAY, 0, eligible).slots.find((entry) => entry.slot === "meal-2");

afterEach(() => { vi.unstubAllGlobals(); unbindAccount(); resetFoodRulesMemoryForTests(); });

describe("saved slots against current rules (F1)", () => {
  const peanutButter = food("pb", "Peanut butter");
  const allergyMark: RuleMark = { verdict: "blocked",
    reason: "has peanut, which your rules exclude." };

  it("marks a peanut-butter slot saved before a peanut allergy as blocked, and keeps it", () => {
    const store = storeWith(savedSlot([line("Peanut butter")]), [peanutButter]);
    const resolved = slot(store, stamped([], [["pb", allergyMark]]));
    expect(resolved?.components.map((part) => part.name)).toEqual(["Peanut butter"]);
    expect(resolved?.meal?.name).toBe("Snack");
    expect(resolved?.ruleMark).toEqual({ verdict: "blocked",
      reason: "Peanut butter has peanut, which your rules exclude." });
    expect(resolved?.componentRuleMarks).toEqual([resolved?.ruleMark]);
  });

  it("marks a saved food the account has since put on Avoid, even before a refresh", () => {
    const store = storeWith(savedSlot([line("Peanut butter")]), [food("pb", "Peanut butter", "avoid")]);
    // The set still lists the food: it was verified before the Avoid mark.
    expect(slot(store, stamped(["pb"]))?.ruleMark).toEqual({ verdict: "blocked",
      reason: "Peanut butter is on your Avoid list." });
  });

  it("leaves a saved slot whose food is still verified unmarked", () => {
    const store = storeWith(savedSlot([line("Peanut butter")]), [peanutButter]);
    const resolved = slot(store, stamped(["pb"]));
    expect(resolved?.ruleMark).toBeNull();
    expect(resolved?.componentRuleMarks).toEqual([null]);
  });

  it("never re-judges an eaten slot", () => {
    const store = storeWith({ ...savedSlot([line("Peanut butter")]),
      eaten: { "meal-2": "2026-10-06T12:00:00.000Z" } }, [food("pb", "Peanut butter", "avoid")]);
    const resolved = slot(store, stamped([], [["pb", allergyMark]]));
    expect(resolved?.eaten).toBe(true);
    expect(resolved?.components.map((part) => part.name)).toEqual(["Peanut butter"]);
    expect(resolved?.ruleMark).toBeNull();
    expect(resolved?.componentRuleMarks).toEqual([null]);
  });

  it("fails closed: unknown without a verified set, or for a line no food backs", () => {
    const store = storeWith(savedSlot([line("Peanut butter"), line("Mystery bar")]), [peanutButter]);
    expect(slot(store)?.ruleMark?.verdict).toBe("unknown");
    const marks = slot(store, stamped(["pb"]))?.componentRuleMarks;
    expect(marks?.[0]).toBeNull();
    expect(marks?.[1]).toMatchObject({ verdict: "unknown" });
  });

  it("keeps a line unknown when a same-name Eats sibling was never verified", () => {
    const store = storeWith(savedSlot([line("Peanut butter")]),
      [peanutButter, food("pb-2", "Peanut butter, crunchy")]);
    expect(slot(store, stamped(["pb"]))?.ruleMark?.verdict).toBe("unknown");
    expect(slot(store, stamped(["pb", "pb-2"]))?.ruleMark).toBeNull();
  });

  it("names the blocked line first when a slot mixes blocked and unknown lines", () => {
    const store = storeWith(savedSlot([line("Mystery bar"), line("Peanut butter")]), [peanutButter]);
    expect(slot(store, stamped([], [["pb", allergyMark]]))?.ruleMark?.verdict).toBe("blocked");
  });
});

describe("accepted recipe selections against current rules (F2)", () => {
  const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
  const riceLine = { seq: 1, name: "Rice", foodRefId: null, foodDbId: null, foodRevisionId: null,
    quantity: 1, unit: "cup", grams: 150, purchaseGrams: 150, state: "raw" as const };
  /** As `loadAcceptedRecipeSelections` returns a row: stamped with the epoch its read began in. */
  const selection = (ruleMark?: RuleMark | null): AcceptedRecipeSelection => ({
    id: "selection", localDate: DAY, slotId: "meal-2", recipeId: "chicken-bowl",
    recipeRevisionId: "chicken-bowl-v1", recipeName: "Chicken bowl", servingFraction: 1,
    ingredientSnapshot: [riceLine], nutritionSnapshot: { kcal: known(500), protein: known(40),
      carbs: known(45), fat: known(15) },
    exactFitAvailable: true, approximateFitAvailable: true, evidenceIssues: [], planRevision: 1,
    ruleMarkEpoch: foodRulesEpoch(), ruleMarkRulesKey: foodRulesKey(defaultSettings()),
    ...(ruleMark === undefined ? {} : { ruleMark }),
  });

  it("judges a chicken recipe accepted before a vegan rule as blocked", () => {
    const chicken = recipe({ name: "Chicken bowl", ingredients: [
      ingredient({ seq: 1, name: "chicken breast" }), ingredient({ seq: 2, name: "rice" })] });
    expect(ruleMarkFromEligibility(recipeEligibility(chicken, { profile: EMPTY_PROFILE })))
      .toBeNull();
    const meat = { meat: { p: 1, rubricVersion: 1, judgedAt: "2026-10-05" } };
    const vegan = ruleMarkFromEligibility(recipeEligibility(chicken, { profile: EMPTY_PROFILE,
      preferenceFlags: ["vegan"], evidenceBySeq: { 1: { facets: meat as never } } }));
    expect(vegan?.verdict).toBe("blocked");
    expect(vegan?.reason).toMatch(/chicken breast/i);
    // Phase 18 W2c: the ingredient's own name decides, with or without a Jev facet.
    expect(ruleMarkFromEligibility(recipeEligibility(chicken, { profile: EMPTY_PROFILE,
      preferenceFlags: ["vegan"] }))?.verdict).toBe("blocked");
    // A Jev-only flag on a name that says nothing is unknown, never blocked and never a pass.
    const mystery = recipe({ name: "Mystery bowl", ingredients: [
      ingredient({ seq: 1, name: "house protein" }), ingredient({ seq: 2, name: "rice" })] });
    expect(ruleMarkFromEligibility(recipeEligibility(mystery, { profile: EMPTY_PROFILE,
      preferenceFlags: ["vegan"], evidenceBySeq: { 1: { facets: meat as never } } }))?.verdict)
      .toBe("unknown");
  });

  it("never clears a recipe that is not fully eligible (round 2, finding 3)", () => {
    // Recipe-completeness codes are not the account's rules, but they are not a pass either.
    expect(ruleMarkFromEligibility({ status: "blocked", reasons: [
      { code: "not_published", message: "Superseded." }] })).toEqual({ verdict: "unknown",
      reason: "This recipe could not be checked against your current food rules. Superseded." });
    expect(ruleMarkFromEligibility({ status: "blocked", reasons: [
      { code: "incomplete_ingredient", message: "Check the quantity for rice." }] })?.verdict)
      .toBe("unknown");
    // A non-eligible status with no reason, or an unknown status, is unknown.
    expect(ruleMarkFromEligibility({ status: "unknown", reasons: [] })?.verdict).toBe("unknown");
    expect(ruleMarkFromEligibility({ status: "blocked", reasons: [] })?.verdict).toBe("unknown");
    // A rule block still wins over a completeness code.
    expect(ruleMarkFromEligibility({ status: "blocked", reasons: [
      { code: "rights", message: "No rights." }, { code: "avoid_list", message: "Rice is on your Avoid list." }] }))
      .toEqual({ verdict: "blocked", reason: "Rice is on your Avoid list." });
    // A pinned revision withdrawn since it was accepted, judged end to end.
    const withdrawn = recipe({ publicationState: "withdrawn" });
    expect(ruleMarkFromEligibility(recipeEligibility(withdrawn, { profile: EMPTY_PROFILE }))?.verdict)
      .toBe("unknown");
    expect(ruleMarkFromEligibility({ status: "eligible", reasons: [] })).toBeNull();
  });

  it("blocks an accepted recipe at once when an ingredient goes on Avoid (round 2, finding 1)", () => {
    const withChicken = { ...selection(null), ingredientSnapshot: [{ seq: 1, name: "Chicken breast",
      foodRefId: null, foodDbId: null, foodRevisionId: null, quantity: 1, unit: "whole", grams: 150,
      purchaseGrams: 150, state: "raw" as const }] };
    const eats = withAcceptedRecipeSelections(storeWith({}, [food("ck", "Chicken breast, raw")]),
      [withChicken]);
    expect(slot(eats, stamped(["ck"]))?.ruleMark).toBeNull();
    // An Avoid mark is an outbox write: no epoch move, no selection re-read. It still applies now.
    const avoided = withAcceptedRecipeSelections(storeWith({}, [food("ck", "Chicken breast, raw", "avoid")]),
      [withChicken]);
    const resolved = slot(avoided, stamped(["ck"]));
    expect(resolved?.ruleMark).toEqual({ verdict: "blocked",
      reason: "Chicken breast is on your Avoid list." });
    expect(resolved?.meal?.name).toBe("Chicken bowl");
    // A server block on a matching food in the current view applies the same way.
    const pbMark: RuleMark = { verdict: "blocked", reason: "has peanut, which your rules exclude." };
    expect(slot(eats, stamped([], [["ck", pbMark]]))?.ruleMark?.verdict).toBe("blocked");
  });

  it("never judges a recipe override by its title (round 2, finding 2)", () => {
    const oats = food("oats", "Oats");
    const store = storeWith({ itemOverrides: { "meal-2": { baseMealId: "recipe:oats-v1", title: "Oats",
      components: [line("Oats")] } } }, [oats]);
    expect(slot(store, stamped(["oats"]))?.ruleMark).toEqual({ verdict: "unknown",
      reason: "This recipe has not been checked against your current food rules." });
  });

  it("does not trust a recipe pass under an unstamped view (round 2, finding 4)", () => {
    const store = withAcceptedRecipeSelections(storeWith({}, []), [selection(null)]);
    expect(slot(store, new Set<string>())?.ruleMark?.verdict).toBe("unknown");
  });

  it("carries the server's mark onto Today's slot and keeps the recipe on it", () => {
    const mark: RuleMark = { verdict: "blocked", reason: "chicken breast: does not fit your food rules." };
    const store = withAcceptedRecipeSelections(storeWith({}, []), [selection(mark)]);
    const resolved = slot(store, stamped([]));
    expect(resolved?.meal?.name).toBe("Chicken bowl");
    expect(resolved?.ruleMark).toEqual(mark);
  });

  it("never lets a pass from older rules stand: a rules change waits for the next selection read", () => {
    vi.stubGlobal("dispatchEvent", vi.fn());
    const before = withAcceptedRecipeSelections(storeWith({}, []), [selection(null)]);
    expect(slot(before, stamped([]))?.ruleMark).toBeNull();
    noteFoodRulesChanged();
    // The eligible set refreshed under the new rules; the recipe verdict did not.
    expect(slot(before, stamped([]))?.ruleMark).toEqual({ verdict: "unknown",
      reason: "Checking against your updated food rules." });
    // No current verified view at all: still never a pass.
    expect(slot(before)?.ruleMark?.verdict).toBe("unknown");
    // The next selection read is stamped under the new rules and counts again.
    const after = withAcceptedRecipeSelections(storeWith({}, []), [selection(null)]);
    expect(slot(after, stamped([]))?.ruleMark).toBeNull();
  });

  it("leaves a still-fitting accepted recipe unmarked and fails closed without a verdict", () => {
    expect(slot(withAcceptedRecipeSelections(storeWith({}, []), [selection(null)]), stamped([]))
      ?.ruleMark).toBeNull();
    expect(slot(withAcceptedRecipeSelections(storeWith({}, []), [selection()]), stamped([]))
      ?.ruleMark?.verdict).toBe("unknown");
  });
});

describe("the verified eligible set across a rules change (F3)", () => {
  const peanutButter = food("pb", "Peanut butter");
  const store = () => storeWith(savedSlot([line("Peanut butter")]), [peanutButter]);
  const profile = { avoid_allergens: ["peanut"], avoid_food_ref_ids: [], banned_categories: [],
    conditions: [], notes: null };

  it("is revoked by a direct rule write, however long it is held, and re-reads are signalled", () => {
    const dispatch = vi.fn();
    vi.stubGlobal("dispatchEvent", dispatch);
    const held = Array.from({ length: 12 }, () => stamped(["pb"]));
    expect(slot(store(), held[0])?.ruleMark).toBeNull();
    noteFoodRulesChanged();
    expect(held.every((set) => set.revoked)).toBe(true);
    expect(slot(store(), held[0])?.ruleMark?.verdict).toBe("unknown");
    expect(dispatch.mock.calls.map(([event]) => (event as Event).type))
      .toEqual(["meal-companion:synced", "recipe-plan-accepted"]);
  });

  it("is born revoked when a rule changed while its request was in flight", () => {
    vi.stubGlobal("dispatchEvent", vi.fn());
    const set = stamped(["pb"]);
    noteFoodRulesChanged();
    expect(set.revoked).toBe(true);
  });

  it("is revoked by a rule-review conflict exactly like a success", async () => {
    vi.stubGlobal("dispatchEvent", vi.fn());
    bindAccount(ACCOUNT);
    for (const status of [409, 200]) {
      const set = stamped(["pb"]);
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(status === 409 ? { error: "conflict" }
        : { status: "ok", review: { required: false, candidateAllergens: [],
          candidateCategories: [], rev: 4 } }, { status })));
      await submitRuleReview({} as never, 3);
      expect(set.revoked, `status ${status}`).toBe(true);
    }
  });

  it("is revoked by a constraints conflict or success, and by a revision moved elsewhere", async () => {
    vi.stubGlobal("dispatchEvent", vi.fn());
    bindAccount(ACCOUNT);
    const conflict = stamped(["pb"]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ value: profile, current_rev: 7 },
      { status: 409 })));
    expect((await saveConstraints({} as never, 6)).status).toBe("conflict");
    expect(conflict.revoked).toBe(true);
    const ok = stamped(["pb"]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ profile, rev: 8 })));
    expect((await saveConstraints({} as never, 7)).status).toBe("ok");
    expect(ok.revoked).toBe(true);
    // The same revision read back moves nothing; another device's revision moves the rules.
    const same = stamped(["pb"]);
    expect(await loadConstraints()).not.toBeNull();
    expect(same.revoked).toBe(false);
    noteRulesRevision(9, ACCOUNT);
    expect(same.revoked).toBe(true);
  });

  it("never rewinds to a late older revision, and still revokes alongside it (round 2, finding 5)", () => {
    vi.stubGlobal("dispatchEvent", vi.fn());
    noteRulesRevision(20, ACCOUNT);
    const current = stamped(["pb"]);
    noteRulesRevision(19, ACCOUNT); // a late answer computed before revision 20
    expect(current.revoked).toBe(true);
    const fresh = stamped(["pb"]);
    noteRulesRevision(20, ACCOUNT); // the known revision is still 20: nothing moved
    expect(fresh.revoked).toBe(false);
  });

  it("treats another account's first sighting as a rules change (round 2, finding 5)", () => {
    vi.stubGlobal("dispatchEvent", vi.fn());
    noteRulesRevision(3, ACCOUNT);
    const mine = stamped(["pb"]);
    noteRulesRevision(3, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(mine.revoked).toBe(true);
  });

  it("is revoked by a revision first seen on the rule-review read (round 2, finding 6)", async () => {
    vi.stubGlobal("dispatchEvent", vi.fn());
    const h = bindAccount(ACCOUNT);
    noteRulesRevision(30, ACCOUNT);
    const set = stamped(["pb"]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ required: false, candidateAllergens: [],
      candidateCategories: [], rev: 31 })));
    expect(await loadRuleReview({ account: h })).not.toBeNull();
    expect(set.revoked).toBe(true);
  });

  it("is revoked by every profile-instance write, and by its conflict (round 2, finding 9)", async () => {
    vi.stubGlobal("dispatchEvent", vi.fn());
    const h = bindAccount(ACCOUNT);
    const instance = { profileId: "vegan", source: "user_stated", rules: [] };
    const writes: [string, () => Promise<unknown>][] = [
      ["confirm", () => confirmProfileInstance(h, "vegan", [])],
      ["preference", () => confirmFoodPreference(h, "Oats", "prefer")],
      ["remove", () => removeProfileInstance(h, "vegan")],
    ];
    for (const [name, write] of writes) {
      const ok = stamped(["pb"]);
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ instance })));
      await write();
      expect(ok.revoked, name).toBe(true);
      const conflict = stamped(["pb"]);
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "moved" }, { status: 409 })));
      await expect(write()).rejects.toThrow();
      expect(conflict.revoked, `${name} conflict`).toBe(true);
    }
  });

  it("is revoked by profile instances changed on another device (round 2, finding 6)", async () => {
    vi.stubGlobal("dispatchEvent", vi.fn());
    const h = bindAccount(ACCOUNT);
    const answer = (confirmedAt: string) => vi.fn(async () => Response.json({
      instances: [{ profileId: "vegan", source: "user_stated", confirmedAt, rules: [] }],
      catalog: [], legacyProfileIds: [] }));
    vi.stubGlobal("fetch", answer("2026-10-01T00:00:00Z"));
    await fetchProfileInstances(h);
    const unchanged = stamped(["pb"]);
    await fetchProfileInstances(h);
    expect(unchanged.revoked).toBe(false);
    vi.stubGlobal("fetch", answer("2026-10-05T00:00:00Z"));
    await fetchProfileInstances(h);
    expect(unchanged.revoked).toBe(true);
  });

  it("is stale once local diet preferences differ from the ones the server judged under", () => {
    const vegan = { ...defaultSettings(), dietPrefs: { flags: ["vegan"] } };
    const local = storeWith(savedSlot([line("Peanut butter")]), [peanutButter], vegan);
    expect(slot(local, stamped(["pb"]))?.ruleMark?.verdict).toBe("unknown");
    expect(slot(local, stamped(["pb"], [], vegan))?.ruleMark).toBeNull();
    // The key reads flags the way the server normalizes them.
    expect(foodRulesKey({ dietPrefs: { flags: ["no_nuts", "bogus"] } }))
      .toBe(foodRulesKey({ dietPrefs: { flags: ["no_peanuts"] } }));
  });
});

describe("review round 3", () => {
  const known = (value: number) => ({ value, status: "known" as const, sourceRevisionId: 1 });
  const chickenLine = { seq: 1, name: "Chicken breast", foodRefId: null, foodDbId: null,
    foodRevisionId: null, quantity: 1, unit: "whole", grams: 150, purchaseGrams: 150, state: "raw" as const };
  const accepted = (flags: string[], ingredientSnapshot: AcceptedRecipeSelection["ingredientSnapshot"]
    = [chickenLine]): AcceptedRecipeSelection => ({
    id: "selection", localDate: DAY, slotId: "meal-2", recipeId: "chicken-bowl",
    recipeRevisionId: "chicken-bowl-v1", recipeName: "Chicken bowl", servingFraction: 1,
    ingredientSnapshot, nutritionSnapshot: { kcal: known(500), protein: known(40),
      carbs: known(45), fat: known(15) },
    exactFitAvailable: true, approximateFitAvailable: true, evidenceIssues: [], planRevision: 1,
    ruleMark: null, ruleMarkEpoch: foodRulesEpoch(),
    ruleMarkRulesKey: foodRulesKey({ dietPrefs: { flags } }),
  });
  const vegan = { ...defaultSettings(), dietPrefs: { flags: ["vegan"] } };

  it("BLOCK: a chicken clear from before going vegan is not a pass after the eligible refresh", () => {
    // Cleared under no flags, in this epoch. The account then goes vegan and the eligible set is
    // re-read under the new flags in the SAME epoch (no constraint revision moved).
    const held = withAcceptedRecipeSelections(storeWith({}, [], vegan), [accepted([])]);
    const refreshed = stamped([], [], vegan);
    expect(slot(held, refreshed)?.ruleMark).toEqual({ verdict: "unknown",
      reason: "Checking against your updated food rules." });
    // A selection read judged under the vegan flags counts again.
    const reread = withAcceptedRecipeSelections(storeWith({}, [], vegan), [accepted(["vegan"])]);
    expect(slot(reread, refreshed)?.ruleMark).toBeNull();
    // A read that did not say which flags it judged under never counts.
    const unflagged = { ...accepted(["vegan"]), ruleMarkRulesKey: undefined };
    expect(slot(withAcceptedRecipeSelections(storeWith({}, [], vegan), [unflagged]), refreshed)
      ?.ruleMark?.verdict).toBe("unknown");
  });

  it("BLOCK: a diet-flag change saved by any writer moves the rules epoch", async () => {
    const dispatch = vi.fn();
    vi.stubGlobal("dispatchEvent", dispatch);
    bindAccount(ACCOUNT);
    const base = loadStore();
    saveStore(base);
    const set = stamped([]);
    saveStore({ ...base, settings: { ...base.settings, shiftMinutes: base.settings.shiftMinutes + 5 } });
    await Promise.resolve();
    expect(set.revoked).toBe(false);
    saveStore({ ...base, settings: { ...base.settings, dietPrefs: { flags: ["vegan"] } } });
    await Promise.resolve();
    expect(set.revoked).toBe(true);
    expect(dispatch.mock.calls.map(([event]) => (event as Event).type))
      .toContain("recipe-plan-accepted");
  });

  it("WARN 2: a recipe ingredient whose own Eats food is unverified or unknown cannot clear", () => {
    const store = withAcceptedRecipeSelections(storeWith({}, [food("ck", "Chicken breast")]),
      [accepted([])]);
    expect(slot(store, stamped([]))?.ruleMark?.verdict).toBe("unknown");
    expect(slot(store, stamped([], [["ck", { verdict: "unknown", reason: "cannot be checked for meat." }]]))
      ?.ruleMark).toEqual({ verdict: "unknown", reason: "Chicken breast cannot be checked for meat." });
    expect(slot(store, stamped(["ck"]))?.ruleMark).toBeNull();
  });

  it("WARN 4: the first profile-rules signature this tab sees revokes a set it already holds", () => {
    vi.stubGlobal("dispatchEvent", vi.fn());
    const set = stamped([]);
    noteRulesSignature("profile-instances", "[]", ACCOUNT);
    expect(set.revoked).toBe(true);
    const next = stamped([]);
    noteRulesSignature("profile-instances", "[]", ACCOUNT);
    expect(next.revoked).toBe(false);
  });

  it("WARN 5: a recipe override set to follow the plan is still judged as a recipe", () => {
    const macros = { kcal: 1800, protein: 120, carbs: 190, fat: 60 };
    const foods = [F.eggs, F.yogurt, F.oats, F.toast, F.tuna, F.banana, F.rice, F.broccoli, F.oliveOil];
    const settings = { ...defaultSettings(), onboardedAt: "2026-09-26T12:00:00Z", trainingWeekdays: [],
      ruleReviewReady: true, mealsPerDay: 3, activeTargetProfile: { revision: 1, training: macros,
        rest: macros, pins: { trainingKcal: null, restKcal: null, proteinG: null } } } as Store["settings"];
    const day = (followPlan: boolean) => storeWith({ itemOverrides: { "meal-2": {
      baseMealId: "recipe:chicken-bowl-v1", title: "Chicken bowl", components: [], followPlan,
      time: "12:30" } } }, foods, settings);
    const set = new StampedEligibleSet(foods.map((entry) => entry.id), new Map(),
      foodRulesKey(settings), foodRulesEpoch());
    const generated = resolveDay(day(true), DAY, 0, set).slots.find((row) => row.slot === "meal-2");
    expect(generated?.components.length).toBeGreaterThan(0);
    // The generator filled the slot, but the override is a recipe with no current verdict.
    expect(generated?.ruleMark?.verdict).toBe("unknown");
    // A plain time-only override on the same plate is a generated plate: clear by construction.
    const plain = storeWith({ itemOverrides: { "meal-2": { baseMealId: null, components: [],
      followPlan: true, time: "12:30" } } }, foods, settings);
    expect(resolveDay(plain, DAY, 0, set).slots.find((row) => row.slot === "meal-2")?.ruleMark)
      .toBeNull();
  });

  it("NOTE 7: an accepted recipe with an empty ingredient list never clears", () => {
    const store = withAcceptedRecipeSelections(storeWith({}, []), [accepted([], [])]);
    expect(slot(store, stamped([]))?.ruleMark).toEqual({ verdict: "unknown",
      reason: "This recipe has not been checked against your current food rules." });
  });

  it("WARN 3: a snapshot line the pinned revision does not hold keeps the recipe from clearing", () => {
    const pinned = recipe({ ingredients: [ingredient({ seq: 1, name: "beans" })] });
    const line = (name: string, foodRefId: string | null) => ({ seq: 1, name, foodRefId,
      foodDbId: null, foodRevisionId: 1, quantity: 1, unit: "g", grams: 100, purchaseGrams: 100,
      state: "raw" });
    expect(hasUnjudgedLine(pinned, [line("beans", "beans")])).toBe(false);
    expect(hasUnjudgedLine(pinned, [line("peanuts", "peanuts")])).toBe(true);
    // Round 4 BLOCK 2: no snapshot, or an empty one, is unjudged too.
    expect(hasUnjudgedLine(pinned, undefined)).toBe(true);
    expect(hasUnjudgedLine(pinned, [])).toBe(true);
  });

  it("BLOCK: each selection read is stamped with the diet flags the server judged under", async () => {
    bindAccount(ACCOUNT);
    const row = accepted([]);
    for (const [body, key] of [[{ selections: [row], ruleFlags: ["vegan"] }, foodRulesKey(vegan)],
      [{ selections: [row] }, undefined]] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
      const [read] = await loadAcceptedRecipeSelections(DAY, DAY);
      expect(read.ruleMarkRulesKey).toBe(key);
    }
  });

  it("keeps the epoch's re-read signal spelled like the sync module's", () => {
    expect(EPOCH_SYNCED_EVENT).toBe(SYNCED_EVENT);
  });
});

describe("review round 4", () => {

  it("BLOCK 1: recipes are judged with the same normalized flags the GET publishes", () => {
    const flags = recipeFlagsFrom({ flags: ["no_nuts", "bogus", 3] });
    expect(flags).toEqual(["no_peanuts"]);
    expect(foodRulesKey({ dietPrefs: { flags } }))
      .toBe(foodRulesKey({ dietPrefs: { flags: ["no_nuts", "bogus"] } }));
    expect(recipeFlagsFrom(null)).toEqual([]);
  });

  it("WARN 4: a shown recipe override with no lines still carries its recipe verdict", () => {
    const store = storeWith({ itemOverrides: { "meal-2": { baseMealId: "recipe:oats-v1",
      title: "Oats", components: [] } } }, []);
    const resolved = slot(store, stamped([]));
    expect(resolved?.meal?.name).toBe("Oats");
    expect(resolved?.ruleMark).toEqual({ verdict: "unknown",
      reason: "This recipe has not been checked against your current food rules." });
  });

  it("NOTE 6: a silent store save (a sync pull) that changes diet flags moves the epoch", async () => {
    vi.stubGlobal("dispatchEvent", vi.fn());
    bindAccount(ACCOUNT);
    const base = loadStore();
    saveStore(base);
    const set = stamped([]);
    // Flags other than whatever this account's stored blob already holds.
    const next = base.settings.dietPrefs?.flags?.includes("pescatarian") ? [] : ["pescatarian"];
    saveStore({ ...base, settings: { ...base.settings, dietPrefs: { flags: next } } },
      { silent: true });
    await Promise.resolve();
    expect(set.revoked).toBe(true);
  });

  it("WARN 3: an eligible answer that clears foods without its flags is never a current view", async () => {
    const { loadEligibleLocalFoodIds } = await import("@/lib/foods/eligible-client");
    const account = bindAccount(ACCOUNT);
    const foods = { own: food("own", "Peanut butter") };
    const answer = (extra: object) => vi.fn(async () => Response.json({ eligibleRefIds: [],
      eligibleFoodIds: ["own"], eligibleCatalogFoodIds: [], excluded: [], ...extra }));
    vi.stubGlobal("fetch", answer({}));
    const unflagged = await loadEligibleLocalFoodIds(account, foods);
    expect([...unflagged]).toEqual(["own"]);
    const store = storeWith(savedSlot([line("Peanut butter")]), [foods.own]);
    expect(slot(store, unflagged)?.ruleMark?.verdict).toBe("unknown");
    // Round 5 WARN 2: an empty answer without its flags is not current either, so the server's
    // exclusion reasons on it are not shown as current; the line is the generic unknown.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ eligibleRefIds: [], eligibleFoodIds: [],
      eligibleCatalogFoodIds: [], excluded: [] })));
    expect(slot(store, await loadEligibleLocalFoodIds(account, foods))?.ruleMark).toEqual({
      verdict: "unknown", reason: "Peanut butter has not been checked against your current food rules." });
    // Round 5 WARN 5: a revoked set clears nothing even through a bare `.has`.
    vi.stubGlobal("dispatchEvent", vi.fn());
    expect(unflagged.has("own")).toBe(true);
    noteFoodRulesChanged();
    expect(unflagged.has("own")).toBe(false);
    vi.stubGlobal("fetch", answer({ preferenceFlags: [] }));
    const flagged = await loadEligibleLocalFoodIds(account, foods);
    expect(slot(store, flagged)?.ruleMark).toBeNull();
  });
});
