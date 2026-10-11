/**
 * W014 (audit 2026-10-10 A023, A128): a coach plan write runs the full policy pass — diet flags,
 * confirmed profile hard rules and the human-food check — not only the allergen / category / Avoid
 * check grounding does. A blocked food is refused whole (refusePlanBlocked); a rule the evidence
 * cannot settle marks the food "unverified"; unreadable evidence never reads as "allowed".
 */
import { describe, expect, it, vi } from "vitest";
import type { CoachAction, GroundedActionItem } from "@/lib/coach/actions";
import { judgePlanActions } from "@/lib/coach/plan-item-policy";
import { refusePlanBlocked } from "@/lib/coach/plan-policy";
import type { SuggestionEvidence, SuggestionFoodEvidence } from "@/lib/coach/suggest-policy";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import type { PolicyPreferenceFlag } from "@/lib/policy/facet-rules";
import { ruleId, type RuleItem } from "@/lib/policy/profiles/types";

const BACON = "00000000-0000-4000-8000-0000000000b1";
const RICE = "00000000-0000-4000-8000-0000000000a1";
const SOAP = "00000000-0000-4000-8000-0000000000c1";
const HOUSE = "00000000-0000-4000-8000-0000000000d1";

const PROFILE: ConstraintProfile = {
  avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [],
};

const facts = (foodName: string, over: Partial<SuggestionFoodEvidence> = {}): SuggestionFoodEvidence => ({
  allergenTags: [], allergenEvidence: {}, checkedAllergens: [], ingredientsText: null,
  foodName, foodBrand: null, policyCategories: [], facets: {}, noCook: null,
  onEatsList: false, onAvoidList: false, role: null, ...over,
});

const FACTS: Record<string, SuggestionFoodEvidence> = {
  [`ref:${BACON}`]: facts("Pork bacon, cooked"),
  [`ref:${RICE}`]: facts("Rice, white, cooked"),
  [`ref:${SOAP}`]: facts("Dish soap", {
    facets: { human_food: { p: 0, rubricVersion: 1, judgedAt: "2026-10-01T00:00:00.000Z" } },
  }),
  [`ref:${HOUSE}`]: facts("House special"),
};

const evidence = (preferenceFlags: PolicyPreferenceFlag[] = []): SuggestionEvidence => ({
  status: "ready", preferenceFlags, byIdentity: FACTS,
});

const food = (foodRefId: string, name: string): GroundedActionItem => ({
  name, grams: 100, foodRefId, catalogFoodRevisionId: 7, kcalPer100g: 100, proteinPer100g: 10,
  carbsPer100g: 10, fatPer100g: 5, verdict: "allowed",
});

const base = { actionId: "a1", date: "2026-10-10", slot: "meal-2", flagged: [] as string[] };
const setSlotMeal = (...items: GroundedActionItem[]) =>
  ({ ...base, kind: "set_slot_meal", title: "Dinner", items }) as unknown as CoachAction;
const addSlotItem = (item: GroundedActionItem) =>
  ({ ...base, kind: "add_slot_item", item }) as unknown as CoachAction;
const setSlotItem = (item: GroundedActionItem) =>
  ({ ...base, kind: "set_slot_item", ...item }) as unknown as CoachAction;

const KINDS: [string, (item: GroundedActionItem) => CoachAction][] = [
  ["set_slot_meal", (item) => setSlotMeal(food(RICE, "rice"), item)],
  ["add_slot_item", addSlotItem],
  ["set_slot_item", setSlotItem],
];

async function judged(action: CoachAction, ev: SuggestionEvidence, profile = PROFILE) {
  return refusePlanBlocked(await judgePlanActions("u1", [action], profile, { evidence: ev }));
}

describe("plan writes and the account's diet flags", () => {
  it.each(KINDS)("%s refuses bacon for a vegetarian account", async (_kind, build) => {
    const out = await judged(build(food(BACON, "bacon")), evidence(["vegetarian"]));
    expect(out.actions).toEqual([]);
    expect(out.refusals).toEqual([expect.stringContaining("bacon")]);
  });

  it.each(KINDS)("%s refuses bacon for a no-pork or halal account", async (_kind, build) => {
    for (const flag of ["no_pork", "halal"] as const) {
      expect((await judged(build(food(BACON, "bacon")), evidence([flag]))).actions).toEqual([]);
    }
  });

  it.each(KINDS)("%s keeps the same food for an account with no diet flag", async (_kind, build) => {
    const action = build(food(BACON, "bacon"));
    const out = await judged(action, evidence());
    expect(out.refusals).toEqual([]);
    expect(out.actions).toHaveLength(1);
  });
});

describe("plan writes and confirmed profile hard rules", () => {
  const rule: RuleItem = {
    id: ruleId("p", "pork"), profileId: "p", facet: "pork", strength: "never", hardBasis: "religious",
    evidenceStrength: null, confirmation: "confirmed", expiresAt: null,
  };
  const ruled: ConstraintProfile = {
    ...PROFILE, profileRules: { items: [rule], asOf: new Date("2026-10-10T00:00:00.000Z") },
  };

  it.each(KINDS)("%s refuses a food a confirmed rule names", async (_kind, build) => {
    expect((await judged(build(food(BACON, "bacon")), evidence(), ruled)).actions).toEqual([]);
  });

  it.each(KINDS)("%s marks a food the rule cannot clear as unverified, never allowed",
    async (kind, build) => {
      const out = await judged(build(food(HOUSE, "house special")), evidence(), ruled);
      expect(out.actions).toHaveLength(1);
      const placed = out.actions[0] as unknown as Record<string, unknown> & { items?: GroundedActionItem[];
        item?: GroundedActionItem };
      const judgedFood = kind === "set_slot_meal" ? placed.items?.[1]
        : kind === "add_slot_item" ? placed.item : placed;
      expect(judgedFood?.verdict).toBe("unverified");
      expect(judgedFood?.marks).toEqual(expect.arrayContaining([
        expect.objectContaining({ facet: "pork", source: "profile", outcome: "unknown" }),
      ]));
    });
});

describe("plan writes and the human-food check", () => {
  it.each(KINDS)("%s refuses a food judged not human food", async (_kind, build) => {
    expect((await judged(build(food(SOAP, "dish soap")), evidence())).actions).toEqual([]);
  });
});

describe("plan writes with unreadable evidence", () => {
  it.each(KINDS)("%s marks the food unverified instead of allowed", async (kind, build) => {
    const port = vi.fn(async () => ({ status: "unavailable" as const, preferenceFlags: [], byIdentity: {} }));
    const actions = await judgePlanActions("u1", [build(food(RICE, "rice"))], PROFILE, { evidencePort: port });
    expect(port).toHaveBeenCalledTimes(1);
    const placed = actions[0] as unknown as GroundedActionItem & { items?: GroundedActionItem[];
      item?: GroundedActionItem };
    const foods = kind === "set_slot_meal" ? placed.items ?? [] : kind === "add_slot_item"
      ? [placed.item as GroundedActionItem] : [placed];
    expect(foods.map((item) => item.verdict)).toEqual(foods.map(() => "unverified"));
  });

  it("keeps a grounded blocked food blocked and never reads evidence for a log", async () => {
    const port = vi.fn();
    const log = { ...base, kind: "log_meal", items: [food(BACON, "bacon")] } as unknown as CoachAction;
    expect(await judgePlanActions("u1", [log], PROFILE, { evidencePort: port })).toEqual([log]);
    expect(port).not.toHaveBeenCalled();
    const blocked = addSlotItem({ ...food(RICE, "rice"), verdict: "blocked" });
    expect((await judged(blocked, evidence())).actions).toEqual([]);
  });
});
