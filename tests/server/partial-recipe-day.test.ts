/**
 * #21 on the server's own readers: the progress export's partial count survives the API's
 * 1,000-row cap, ref lookups are batched, and the coach's day text says "at least" / "at most"
 * when a logged entry is a partly measured recipe serving.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { partialRecipeCoverageByRef, partialRecipeItemsByDate, ID_BATCH } =
  await import("@/lib/server/log-recipe-coverage");
const { loggedEntries, toDayContext } = await import("@/lib/server/day-context");
const { renderCoachContext } = await import("@/lib/server/coach-context");
const { resolveDay } = await import("@/lib/resolve");
const { defaultSettings } = await import("@/lib/store");

type Row = Record<string, unknown>;
const CAP = 1000;

/** PostgREST-like: eq/is/in/gte/lte filter, and every answer is cut at the 1,000-row cap. */
function fakeClient(tables: Record<string, Row[]>) {
  const inSizes: number[] = [];
  const from = vi.fn((table: string) => {
    const filters: ((row: Row) => boolean)[] = [];
    const keep = (col: string, test: (v: unknown) => boolean) =>
      filters.push((row) => !(col in row) || test(row[col]));
    const result = () => ({ data: (tables[table] ?? []).filter((row) => filters.every((f) => f(row)))
      .slice(0, CAP), error: null });
    const builder: Record<string, unknown> = {
      select: () => builder, order: () => builder,
      eq: (col: string, v: unknown) => { keep(col, (x) => x === v); return builder; },
      is: (col: string, v: unknown) => { keep(col, (x) => x === v); return builder; },
      maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
      in: (col: string, vs: unknown[]) => { inSizes.push(vs.length); keep(col, (x) => vs.includes(x)); return builder; },
      gte: (col: string, v: string) => { keep(col, (x) => String(x) >= v); return builder; },
      lte: (col: string, v: string) => { keep(col, (x) => String(x) <= v); return builder; },
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return builder;
  });
  return { client: { from } as never, inSizes };
}

const recipeTables = {
  food_refs: [{ id: "ref-partial", user_food_id: "recipe-partial" }, { id: "ref-plain", user_food_id: null }],
  recipes: [{ id: "recipe-partial", rev: 1,
    recipe_revisions: [{ rev: 1, nutrients_per_serving: { energy_kcal: 50, coverage: 0.5 } }] }],
};

describe("progress export partial count past the row cap", () => {
  it("counts a partial serving that sits after the first 1,000 entries", async () => {
    const entry = (date: string, ref: string) => ({ user_id: "u1", local_date: date, deleted_at: null,
      log_items: [{ food_ref_id: ref }] });
    const log_entries = [
      ...Array.from({ length: 700 }, () => entry("2026-10-01", "ref-plain")),
      ...Array.from({ length: 700 }, () => entry("2026-10-02", "ref-plain")),
      entry("2026-10-02", "ref-partial"), entry("2026-10-02", "ref-partial"),
    ];
    const { client } = fakeClient({ ...recipeTables, log_entries });
    const counts = await partialRecipeItemsByDate(client, "u1", "2026-10-01", "2026-10-02");
    expect(counts).toEqual(new Map([["2026-10-02", 2]]));
  });
});

describe("ref lookups", () => {
  it("read ids in batches, never one unbounded .in()", async () => {
    const refs = Array.from({ length: ID_BATCH * 2 + 50 }, (_, i) => `ref-${i}`);
    const { client, inSizes } = fakeClient({
      food_refs: [...refs.map((id) => ({ id, user_food_id: null })), ...recipeTables.food_refs],
      recipes: recipeTables.recipes });
    const map = await partialRecipeCoverageByRef(client, [...refs, "ref-partial"]);
    expect(map).toEqual(new Map([["ref-partial", 0.5]]));
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(ID_BATCH);
  });
});

describe("coach day text with a partly measured recipe serving", () => {
  const DATE = "2026-10-01";
  const entry = (id: string, kcal: number, nutritionPartial?: true) => ({
    id, foodId: "meal", name: id, qty: 1, grams: 100, portionLabel: "100 g", at: `${DATE}T12:00:00Z`,
    macros: { kcal, protein: 10, carbs: 10, fat: 5 }, ...(nutritionPartial ? { nutritionPartial } : {}) });
  const context = (extras: ReturnType<typeof entry>[]) => {
    const store = { version: 1, firstOpenedAt: `${DATE}T00:00:00.000Z`, settings: defaultSettings(),
      foods: {}, days: { [DATE]: { date: DATE, extras } } } as never;
    return toDayContext(resolveDay(store, DATE), "UTC", []);
  };
  const render = (day: ReturnType<typeof context>) => renderCoachContext({
    now: `${DATE}T15:00:00.000Z`, tz: "UTC", date: DATE, day,
    lists: { eats: [], avoid: [], eatsMore: 0, avoidMore: 0 }, recipes: [], recipesMore: 0, profile: null,
  } as never);

  it("says at least for the eaten total and the partial entry", () => {
    const day = context([entry("Stew", 50, true), entry("Apple", 95)]);
    expect(day.consumedPartial).toBe(true);
    expect(day.entries[0]).toMatchObject({ partial: true });
    expect(day.entries[0].macros.startsWith("at least ")).toBe(true);
    expect(day.entries[1].macros.startsWith("at least")).toBe(false);
    expect(render(day)).toContain('"eaten_so_far":"at least 145 kcal');
  });

  it("keeps the plain wording on a fully measured day", () => {
    const day = context([entry("Apple", 95)]);
    expect(day.consumedPartial).toBe(false);
    expect(render(day)).toContain('"eaten_so_far":"95 kcal');
    expect(day.stillToEat.startsWith("at most")).toBe(false);
  });
});

describe("server readers use the recorded flag (round 3)", () => {
  // The recipe behind ref-partial is COMPLETE now; the stored items say what they were.
  const completed = { ...recipeTables, recipes: [{ id: "recipe-partial", rev: 2, user_id: "u1",
    recipe_revisions: [{ rev: 2, nutrients_per_serving: { coverage: 1 } }] }] };
  const item = (nutrition_partial: boolean | null) =>
    ({ seq: 0, grams: 100, food_ref_id: "ref-partial", snapshot: {}, nutrition_partial });

  it("progress counts a serving recorded partial although its recipe was completed since", async () => {
    const log_entries = [
      { id: "e1", user_id: "u1", local_date: "2026-10-01", deleted_at: null, log_items: [item(true)] },
      { id: "e2", user_id: "u1", local_date: "2026-10-01", deleted_at: null, log_items: [item(false)] },
    ];
    const { client } = fakeClient({ ...completed, log_entries });
    expect(await partialRecipeItemsByDate(client, "u1", "2026-10-01", "2026-10-01"))
      .toEqual(new Map([["2026-10-01", 1]]));
  });

  it("the coach's logged entries carry the recorded mark", async () => {
    const log_entries = [
      { id: "e1", user_id: "u1", local_date: "2026-10-01", deleted_at: null, eaten_at: "2026-10-01T12:00:00Z",
        slot: "snack", note: null, log_items: [item(true)] },
      { id: "e2", user_id: "u1", local_date: "2026-10-01", deleted_at: null, eaten_at: "2026-10-01T13:00:00Z",
        slot: "snack", note: null, log_items: [item(false)] },
    ];
    const { client } = fakeClient({ ...completed, log_entries, catalog_food_revisions: [], user_foods: [] });
    const logged = await loggedEntries(client, "u1", "2026-10-01");
    expect(logged.map(({ entry }) => entry.nutritionPartial)).toEqual([true, undefined]);
  });

  it("says at most for what is left, and flags remaining as an upper bound", () => {
    const day = toDayContext({ date: "2026-10-01", dayType: "rest", slots: [],
      targets: { kcal: 2000, protein: 120, carbs: 200, fat: 60 },
      consumed: { kcal: 500, protein: 20, carbs: 50, fat: 20 },
      extras: [{ id: "e1", foodId: "meal", name: "Stew", qty: 1, grams: 100, portionLabel: "100 g",
        at: "2026-10-01T12:00:00Z", macros: { kcal: 500, protein: 20, carbs: 50, fat: 20 },
        nutritionPartial: true }] } as never, "UTC", []);
    expect(day.stillToEat.startsWith("at most 1500 kcal left, at most 100 g protein, "
      + "at most 150 g carbs, at most 40 g fat")).toBe(true);
    const text = renderCoachContext({ now: "2026-10-01T15:00:00.000Z", tz: "UTC", date: "2026-10-01",
      day, lists: { eats: [], avoid: [], eatsMore: 0, avoidMore: 0 }, recipes: [], recipesMore: 0,
      profile: null } as never);
    expect(text).toContain('"remaining_is_upper_bound":true');
    expect(text).toContain('"still_to_eat":"at most 1500 kcal left');
  });
});

describe("owner scope on the fallback read", () => {
  it("never judges another account's recipe", async () => {
    const { client } = fakeClient({ food_refs: recipeTables.food_refs, recipes: [{ id: "recipe-partial",
      rev: 1, user_id: "someone-else",
      recipe_revisions: [{ rev: 1, nutrients_per_serving: { coverage: 0.5 } }] }] });
    expect(await partialRecipeCoverageByRef(client, ["ref-partial"], "u1")).toEqual(new Map());
    expect(await partialRecipeCoverageByRef(client, ["ref-partial"], "someone-else"))
      .toEqual(new Map([["ref-partial", 0.5]]));
  });
});

describe("an unreadable food_refs read in the coach's day (review round 7)", () => {
  it("marks no entry partial and reports the day as not fully checked", async () => {
    const failingRefs = (tables: Record<string, Row[]>) => {
      const { client } = fakeClient(tables);
      const real = (client as unknown as { from: (t: string) => unknown }).from;
      // Only the coverage read of food_refs (it asks for the kind) fails; name lookups stay up.
      return { from: (table: string) => {
        const builder = real(table) as { select: (cols?: string) => unknown };
        if (table !== "food_refs") return builder;
        return { ...builder, select: (cols = "") => cols.includes("user_foods(kind)")
          ? { in: () => Promise.resolve({ data: null, error: new Error("down") }) }
          : builder.select(cols) };
      } } as never;
    };
    const log_entries = [{ id: "e1", user_id: "u1", local_date: "2026-10-01", deleted_at: null,
      eaten_at: "2026-10-01T12:00:00Z", slot: "snack", note: null,
      log_items: [{ seq: 0, grams: 100, food_ref_id: "ref-plain", snapshot: {}, nutrition_partial: null }] }];
    let unchecked = false;
    const logged = await loggedEntries(failingRefs({ log_entries, catalog_food_revisions: [], user_foods: [] }),
      "u1", "2026-10-01", () => { unchecked = true; });
    expect(unchecked).toBe(true);
    expect(logged[0].entry.nutritionPartial).toBeUndefined();
  });
});

describe("both food_refs reads down (review round 8 probe)", () => {
  it("still returns the day: unknown names, nothing partial, and the day reported unchecked", async () => {
    const { client } = fakeClient({ log_entries: [{ id: "e1", user_id: "u1", local_date: "2026-10-01",
      deleted_at: null, eaten_at: "2026-10-01T12:00:00Z", slot: "snack", note: null,
      log_items: [{ seq: 0, grams: 100, food_ref_id: "ref-plain", snapshot: {}, nutrition_partial: null }] }] });
    const real = (client as unknown as { from: (t: string) => unknown }).from;
    const down = { from: (table: string) => table === "food_refs"
      ? { select: () => ({ in: () => Promise.resolve({ data: null, error: new Error("food_refs unavailable") }) }) }
      : real(table) } as never;
    let unchecked = false;
    const logged = await loggedEntries(down, "u1", "2026-10-01", () => { unchecked = true; });
    expect(unchecked).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0].entry.items?.[0].name).toBe("(unknown food)");
    expect(logged[0].entry.nutritionPartial).toBeUndefined();
  });
});
