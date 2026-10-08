/**
 * Plan-sheet chips (lib/plan/chips.ts) through `suggestOptions` with the route's `ideasPool` port:
 * every chip's own filter and order, "Not this" refills (`excludeIds`), the on-hand tiers and
 * sources, the empty on-hand offer, and the Jev ranking's formula-order fallback.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));

import { suggestOptions, type SuggestPorts } from "@/lib/coach/suggest";
import type { PoolInputs } from "@/lib/coach/suggest-pool";
import type { OnHandEntry } from "@/lib/coach/suggest-shape";
import {
  chipInput, LIGHT_SCALE, NO_QUICK_MESSAGE, ON_HAND_COPY, ON_HAND_EMPTY_MESSAGE, ON_HAND_NO_FIT_MESSAGE,
  type PlanChip,
} from "@/lib/plan/chips";
import { plateMinutes } from "@/lib/plan/prep-minutes";
import { bestPerAnchor, rankPlates } from "@/lib/meals/plate";
import { composedActions } from "@/components/CoachComposedCard";
import { coachActionSchema } from "@/lib/coach/actions";
import { TEST_PROFILE } from "@/tests/helpers/constraint-profile";
import { eats, F, MAIN } from "@/tests/helpers/meal-foods";
import { inputsFor, openSnapshot, ownFood } from "@/tests/helpers/open-snapshot";

const DATE = "2026-10-08";
const CLOSED = eats(F.eggs, F.yogurt, F.chicken, F.tofu, F.tuna, F.blackBeans, F.rice, F.bread,
  F.oats, F.tortilla, F.broccoli, F.spinach, F.banana, F.blueberries, F.oliveOil, F.avocado);

/** A stable fake food_refs uuid per pool id: a placeable card needs one per item. */
const uuidFor = (id: string) => {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hex = hash.toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex}0000`;
};
const refsOf = (ids: readonly string[]) => Object.fromEntries(ids.map((id) => [id, uuidFor(id)]));
/** What lib/server/universe-refs.ts answers: a catalog ref and its active revision per pool id. */
const universeRefsOf = (ids: readonly string[]) => Object.fromEntries(ids.map((id, index) =>
  [id, { foodRefId: uuidFor(id), catalogFoodRevisionId: 1000 + index }]));

function ports(pool: PoolInputs, overrides: Partial<SuggestPorts> = {}): SuggestPorts {
  return {
    userId: "u1", profile: TEST_PROFILE, target: async () => MAIN, searchFoods: async () => [],
    ideasPool: async () => pool, poolRefs: async () => refsOf(Object.keys(pool.foods)),
    universeRefs: async (_user, ids) => universeRefsOf(ids), slotClock: async () => "12:30",
    ...overrides,
  };
}
const closed = (foods = CLOSED): PoolInputs => ({ foods });
const run = (chip: PlanChip, pool: PoolInputs = closed(), overrides: Partial<SuggestPorts> = {},
  excludeIds?: string[]) =>
  suggestOptions(chipInput({ chip, slot: "meal-2", date: DATE, excludeIds }), ports(pool, overrides));

describe("chips answer in code", () => {
  it("choose: three titled cards with stable idea ids and app provenance", async () => {
    const cards = await run("choose");
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.ideaId).toMatch(/\+/);
      expect(card.wish).not.toBe("meal");
      expect(card.provenance).toEqual({ ai: false, source: "app" });
      expect(card.fitsTarget).toBe(true);
    }
    expect(new Set(cards.map((card) => card.ideaId)).size).toBe(3);
  });

  it("is deterministic for the same date", async () => {
    const [a, b] = await Promise.all([run("choose"), run("choose")]);
    expect(a.map((card) => card.ideaId)).toEqual(b.map((card) => card.ideaId));
  });

  it("protein: every card meets the slot's protein", async () => {
    const cards = await run("protein");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(card.totals.protein).toBeGreaterThanOrEqual(MAIN.protein * 0.9);
  });

  it("light: smaller calories, carbs and fat; protein never shrinks", async () => {
    const cards = await run("light");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.target.kcal).toBe(Math.round(MAIN.kcal * LIGHT_SCALE));
      expect(card.target.protein).toBe(MAIN.protein);
      expect(card.totals.kcal).toBeLessThan(MAIN.kcal * 0.9);
      expect(card.totals.protein).toBeGreaterThanOrEqual(MAIN.protein * 0.9);
    }
  });

  it("quick15: only plates whose derived prep time is 15 minutes or less", async () => {
    const cards = await run("quick15");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.prepMinutes).toBeLessThanOrEqual(15);
      expect(plateMinutes(card.items.map((item) => ({ name: item.name })))).toBe(card.prepMinutes);
    }
  });

  it("quick15: says so when nothing is that quick", async () => {
    const result = await run("quick15", closed(eats(F.chicken, F.rice, F.broccoli, F.oliveOil)));
    expect(result).toHaveLength(0);
    expect(result.message).toBe(NO_QUICK_MESSAGE);
  });

  it("surprise: a plate the history knows ranks behind an unknown one", async () => {
    const plain = await run("choose");
    const usual = plain[0].items.find((item) => item.part === "anchor")!.name.toLowerCase();
    const history = { [usual]: { lunch: 1, dinner: 1, breakfast: 1, snack: 1 } };
    const cards = await run("surprise", { foods: CLOSED,
      evidence: { accountId: "u1", computedAt: `${DATE}T00:00:00Z`, history } });
    expect(cards[0].items.find((item) => item.part === "anchor")!.name.toLowerCase()).not.toBe(usual);
  });
});

describe("filters run before the best-plate-per-anchor cut", () => {
  const ONE_ANCHOR = eats(F.eggs, F.rice, F.bread, F.toast, F.broccoli, F.spinach, F.oliveOil);

  it("a refill offers the same anchor's next plate when its best plate was said no to", async () => {
    const first = await run("choose", closed(ONE_ANCHOR));
    expect(first.length).toBeGreaterThan(0);
    const refill = await run("choose", closed(ONE_ANCHOR), {}, first.map((card) => card.ideaId!));
    expect(refill.length).toBeGreaterThan(0);
    for (const card of refill) {
      expect(first.map((shown) => shown.ideaId)).not.toContain(card.ideaId);
      expect(card.items.some((item) => item.name.startsWith("Eggs"))).toBe(true);
    }
  });

  it("15 min keeps an anchor whose best plate is slow but whose next plate is quick", async () => {
    // Tofu's best lunch plate is tofu + rice + spinach (rice: 20 min); tofu + bread is quick.
    const pool = eats(F.tofu, F.rice, F.bread, F.broccoli, F.spinach, F.oliveOil);
    const [best] = bestPerAnchor(rankPlates({ date: DATE, slot: "meal-2", occasion: "lunch", target: MAIN,
      foods: pool }).plates);
    expect(plateMinutes(best.rows.map((row) => row.food))).toBeGreaterThan(15);
    const quick = await run("quick15", closed(pool));
    expect(quick.length).toBe(1);
    expect(quick[0].prepMinutes).toBeLessThanOrEqual(15);
    expect(quick[0].items.map((item) => item.name)).toEqual(expect.arrayContaining(["Tofu, firm", "Bread, whole wheat"]));
  });
});

describe("Not this: refills never repeat", () => {
  it("excludes every idea said no to", async () => {
    const first = await run("choose");
    const ids = first.map((card) => card.ideaId!);
    const refill = await run("choose", closed(), {}, ids);
    expect(refill.length).toBeGreaterThan(0);
    for (const card of refill) expect(ids).not.toContain(card.ideaId);
  });
});

describe("Use what I have", () => {
  const onHand = (entries: OnHandEntry[]) => ({ onHand: async () => entries });

  it("an empty on-hand set says so, offers to add items, and falls back to Favorites", async () => {
    const result = await run("on_hand", closed(), onHand([]));
    expect(result.message).toBe(ON_HAND_EMPTY_MESSAGE);
    expect(result.offer).toBe("add_items");
    for (const card of result) expect(card.sourceNote).toBe(ON_HAND_COPY.favored);
  });

  it("builds from on-hand foods first and names where each came from", async () => {
    const result = await run("on_hand", closed(), onHand([
      { name: "eggs", source: "pantry_photo" }, { name: "bread", source: "list" },
      { name: "spinach", source: "pantry" }, { name: "avocado", source: "pantry" },
      { name: "tuna", source: "pantry" }, { name: "tortilla", source: "list" }, { name: "rice", source: "list" },
    ]));
    expect(result.length).toBeGreaterThan(0);
    expect(result.message).toBeUndefined();
    const allowed = new Set(["Eggs, whole, cooked", "Bread, whole wheat", "Spinach, cooked", "Avocado",
      "Tuna, canned in water", "Corn tortilla", "Rice, white, cooked"]);
    for (const card of result) {
      expect(card.items.every((item) => allowed.has(item.name))).toBe(true);
      expect(Object.values(ON_HAND_COPY)).toContain(card.sourceNote);
    }
    const eggs = result.find((card) => card.items.some((item) => item.name.startsWith("Eggs")));
    if (eggs) expect(eggs.sourceNote).toBe(ON_HAND_COPY.pantry_photo);
  });

  it("an on-hand food outside the admitted pool is never used", async () => {
    const result = await run("on_hand", closed(), onHand([{ name: "pork belly", source: "pantry" }]));
    for (const card of result) expect(card.items.some((item) => /pork/i.test(item.name))).toBe(false);
    expect(result.message).toBe(ON_HAND_NO_FIT_MESSAGE);
  });

  it("mixes in Favorites when on-hand foods alone make no plate", async () => {
    const result = await run("on_hand", closed(), onHand([{ name: "chicken", source: "list" }]));
    expect(result.length).toBeGreaterThan(0);
    for (const card of result) {
      expect(card.items.some((item) => item.name.startsWith("Chicken"))).toBe(true);
      expect(card.sourceNote).toBe(ON_HAND_COPY.list);
    }
  });
});

describe("every card can be placed", () => {
  it("drops a universe card when no ref resolves for its foods", async () => {
    const open = inputsFor(openSnapshot());
    const cards = await run("choose", open, { universeRefs: undefined });
    for (const card of cards) {
      expect(card.items.every((item) => /^[0-9a-f-]{36}$/.test(item.foodRefId ?? ""))).toBe(true);
    }
    expect(cards.some((card) => card.items.some((item) => item.foodRefId?.startsWith("universe:")))).toBe(false);
  });

  it("unresolved universe plates at the top never crowd out placeable Favored ideas", async () => {
    const favored = [
      ownFood("aaaaaaaa-0000-4000-8000-000000000001", "Chicken breast, roasted", "protein", [31, 0, 3.6]),
      ownFood("aaaaaaaa-0000-4000-8000-000000000002", "Rice, white, cooked", "carb", [2.7, 28, 0.3]),
      ownFood("aaaaaaaa-0000-4000-8000-000000000003", "Broccoli, steamed", "carb", [2.4, 7, 0.4]),
      ownFood("aaaaaaaa-0000-4000-8000-000000000004", "Olive oil", "fat", [0, 0, 100]),
    ];
    const pool = inputsFor(openSnapshot({ favored }), favored);
    const favoredIds = new Set(favored.map((row) => row.food.id));
    // The precondition: by the engine's own order, universe plates fill the first 12 anchors.
    const top = bestPerAnchor(rankPlates({ date: DATE, slot: "meal-2", occasion: "lunch", target: MAIN,
      foods: pool.foods, evidence: pool.evidence, taste: pool.taste, open: pool.ranking }).plates).slice(0, 12);
    expect(top.some((plate) => plate.rows.some((row) => !favoredIds.has(row.food.id)))).toBe(true);
    const cards = await run("choose", pool, { universeRefs: undefined,
      poolRefs: async () => Object.fromEntries(favored.map((row) => [row.food.id, row.food.id])) });
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.items.every((item) => favoredIds.has(item.foodRefId ?? ""))).toBe(true);
    }
  });

  it("resolves every universe id in one batched call", async () => {
    const resolver = vi.fn(async (_user: string, ids: readonly string[]) => universeRefsOf(ids));
    await run("choose", inputsFor(openSnapshot()), { universeRefs: resolver });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("a resolved universe card can be placed: its set_slot_meal action is a valid coach action", async () => {
    const cards = await run("choose", inputsFor(openSnapshot()));
    expect(cards.length).toBe(3);
    for (const card of cards) {
      const action = composedActions(card, "meal-2", { date: DATE, at: "12:30" }, () => crypto.randomUUID()).slot!;
      expect(action.kind).toBe("set_slot_meal");
      expect(coachActionSchema.safeParse(action).success).toBe(true);
      for (const item of card.items) {
        expect(item.foodRefId).toMatch(/^[0-9a-f-]{36}$/);
        expect(typeof item.catalogFoodRevisionId).toBe("number");
      }
    }
  });

  it("offers universe cards with real refs once the resolver answers", async () => {
    const cards = await run("choose", inputsFor(openSnapshot()));
    expect(cards.length).toBe(3);
    for (const card of cards) expect(card.items.every((item) => !item.foodRefId?.startsWith("universe:"))).toBe(true);
  });

  it("a failed resolver drops universe cards and never fails the chip", async () => {
    const cards = await run("choose", inputsFor(openSnapshot()),
      { universeRefs: async () => { throw new Error("db down"); } });
    expect(cards.every((card) => card.items.every((item) => !item.foodRefId?.startsWith("universe:")))).toBe(true);
  });
});

describe("Jev ranks and never blocks", () => {
  const open = (): PoolInputs => inputsFor(openSnapshot());
  const answers = (payload: { questions: Record<string, unknown> }) => Object.fromEntries(
    Object.keys(payload.questions).map((key, index) => [key, {
      type: "score" as const, score: index % 3, legend: { "0": "not", "1": "acceptable", "2": "natural" },
      probabilities: { "0": 0, "1": 0, "2": 1 }, confidence: 1,
    }]));

  it("uses one Jev ranking call over the admitted plates when five or more qualify", async () => {
    const jev = vi.fn(async (payload: { questions: Record<string, unknown> }) => answers(payload));
    const cards = await run("choose", open(), { systemOne: jev as unknown as SuggestPorts["systemOne"] });
    expect(jev).toHaveBeenCalledTimes(1);
    expect(cards.length).toBe(3);
  });

  it("a Jev failure leaves the formula order", async () => {
    const formula = await run("choose", open(), { systemOne: async () => null });
    const failed = await run("choose", open(), { systemOne: async () => { throw Object.assign(new Error("x"), { name: "AbortError" }); } });
    expect(failed.map((card) => card.ideaId)).toEqual(formula.map((card) => card.ideaId));
  });

  it("a non-abort Jev error leaves the formula order", async () => {
    const formula = await run("choose", open(), { systemOne: async () => null });
    const broken = await run("choose", open(), { systemOne: async () => { throw new TypeError("bad answer"); } });
    expect(broken.map((card) => card.ideaId)).toEqual(formula.map((card) => card.ideaId));
  });

  it("the coach suggest path also keeps formula order on a non-abort Jev error", async () => {
    const pool = inputsFor(openSnapshot());
    const coach = (systemOne: SuggestPorts["systemOne"]) => suggestOptions({ kind: "meal", count: 3, slot: "meal-2" },
      { userId: "u1", profile: TEST_PROFILE, target: async () => MAIN, searchFoods: async () => [],
        eatsNames: async () => [], openWorld: async () => pool, poolRefs: async () => ({}), systemOne });
    const formula = await coach(async () => null);
    const broken = await coach(async () => { throw new Error("HTTP 500"); });
    expect(broken.length).toBe(3);
    expect(broken.map((card) => card.items.map((item) => item.name))).toEqual(
      formula.map((card) => card.items.map((item) => item.name)));
  });

  it("a Jev timeout leaves the formula order, inside the hard deadline", async () => {
    const formula = await run("choose", open(), { systemOne: async () => null });
    const started = Date.now();
    const slow = await run("choose", open(), {
      systemOne: () => new Promise(() => undefined), jevDeadlineMs: 50,
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(slow.map((card) => card.ideaId)).toEqual(formula.map((card) => card.ideaId));
    expect(slow.every((card) => card.provenance?.source === "app")).toBe(true);
  });
});
