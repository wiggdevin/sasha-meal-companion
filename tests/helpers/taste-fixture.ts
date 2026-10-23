/**
 * Phase 18 W3 acceptance fixture: account A's 30 days of history (logs, 2 consumed recipes with
 * their eaten slots and duplicate logs of one of them, 10 ticks, 1 mixed dish, manual shopping
 * lines), with account B's canary rows in every table. Read through the PostgREST double
 * (tests/helpers/occasion-fake-db.ts) and stub ports for the policy reads, so the real identity,
 * episode, admission and policy code runs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SuggestionEvidence, SuggestionFoodEvidence } from "@/lib/coach/suggest-policy";
import { readAvoidList } from "@/lib/server/avoid-list";
import type { PolicyProfile } from "@/lib/server/policy-profile";
import type { TastePorts } from "@/lib/server/taste-admission";
import { fakeDb, type Row } from "@/tests/helpers/occasion-fake-db";
import type { MixedDishInput } from "@/lib/server/taste-history";

export const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
/** Each account's one live shopping list. */
export const LIST_A = "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const LIST_B = "b1b1b1b1-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const TODAY = "2026-10-06";

/** Row ids are uuids, as in the database: the reader never sends a malformed id to a query. */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const catRef = (catalogId: number) => uuid(catalogId);
export const REF = { c901: catRef(901), c902: catRef(902), c903: catRef(903), c904: catRef(904), c906: catRef(906),
  dal: uuid(1001), bSecret: uuid(1002), creamy: uuid(1003) };
export const FOOD = { dal: uuid(2001), bSecret: uuid(2002) };
export const NOW = new Date("2026-10-06T15:00:00Z");
export const day = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000)
  .toISOString().slice(0, 10);

const MACROS = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

/** Shared catalog rows (no owner): SR chicken and banana, a branded yogurt, an FNDDS dish. */
const CATALOG: [number, string, string, string][] = [
  [901, "fdc_sr_legacy", "171477", "Chicken, broilers or fryers, breast, meat only, cooked, roasted"],
  [902, "fdc_sr_legacy", "173944", "Bananas, raw"],
  [903, "fdc_branded", "0001", "Greek yogurt, vanilla, Oikos"],
  [904, "fdc_fndds", "58106", "Lasagna with meat"],
  [906, "fdc_sr_legacy", "999906", "Bananas, ripe and slightly ripe, raw"],
];

let seq = 0;
function entry(userId: string, age: number, slot: string, items: [string, number | null][], extra: Row = {}) {
  const id = `entry-${userId.slice(0, 1)}-${seq += 1}`;
  return { entry: { id, user_id: userId, local_date: day(age), slot, deleted_at: null, note: "secret note",
    eaten_at: `${day(age)}T12:00:00Z`, ...extra },
  items: items.map(([ref, grams]) => ({ entry_id: id, food_ref_id: ref, grams })) };
}

function recipeLines(lines: { name: string; grams: number | null; foodRefId?: string; foodDbId?: string }[]) {
  return lines.map((line, i) => ({ seq: i + 1, name: line.name, foodRefId: line.foodRefId ?? null,
    foodDbId: line.foodDbId ?? null, grams: line.grams, quantity: 1, unit: "g" }));
}

const consumed = (revision: string, qty: number) => ({ eaten_at: "2026-09-21T12:30:00Z",
  changed_at: "2026-09-21T12:30:00Z", history_epoch: "11111111-1111-4111-8111-111111111111",
  consumed: { baseMealId: `recipe:${revision}`, title: "Recipe", components: [{ name: "Recipe", qty, unit: "whole",
    role: "free", macros: MACROS }] } });
const ticked = { eaten_at: "2026-10-01T08:00:00Z", changed_at: "2026-10-01T08:00:00Z" };
const component = (name: string, qty: number, unit: string, foodKey?: string) =>
  ({ name, qty, unit, role: "free", macros: MACROS, ...(foodKey ? { foodKey } : {}) });

/** Fresh tables for one test: mutate them freely. */
export function tasteTables(): Record<string, Row[]> {
  seq = 0;
  const logs = [
    // Banana at meal 1 every third day: 10 days.
    ...Array.from({ length: 10 }, (_, i) => entry(A, i * 3, "meal-1", [[REF.c902, 118]])),
    // Chicken at meal 2 on four days; a 5 g taste on day 9 counts nothing.
    ...[1, 2, 5, 8].map((age) => entry(A, age, "meal-2", [[REF.c901, 150]])),
    entry(A, 9, "meal-4", [[REF.c901, 5]]),
    // Mom's dal, an own food logged as a unit (unknown mass), on three days.
    ...[4, 10, 20].map((age) => entry(A, age, "meal-3", [[REF.dal, null]])),
    // The branded yogurt beside the banana on two days.
    ...[6, 7].map((age) => entry(A, age, "meal-1", [[REF.c903, 170]])),
    // The mixed dish.
    entry(A, 12, "meal-3", [[REF.c904, 300]]),
    // Recipe 1 was eaten at meal 2 on day 15; two logs of the same meal duplicate it.
    entry(A, 15, "meal-2", [[REF.c901, 130]]),
    entry(A, 15, "meal-2", [[REF.c901, 130]]),
    // Account B's canaries: its own food, and a shared catalog food on A's days.
    entry(B, 1, "meal-2", [[REF.bSecret, 200], [REF.c901, 150]]),
    entry(B, 3, "meal-1", [[REF.c902, 118]]),
  ];
  const planDays: Row[] = [];
  const planDay = (userId: string, age: number) => {
    let row = planDays.find((r) => r.user_id === userId && r.local_date === day(age));
    if (!row) {
      row = { user_id: userId, local_date: day(age), item_overrides: {}, eaten_slots: {} };
      planDays.push(row);
    }
    return row as { item_overrides: Row; eaten_slots: Row };
  };
  // Ten ticks at meal 5: five generated plates with keys, five older ones matched by name.
  for (let age = 0; age < 5; age += 1) {
    const row = planDay(A, age);
    row.item_overrides["meal-5"] = { baseMealId: "gen", components: [component("Chicken breast", 4, "oz", "catalog:901"),
      component("Banana", 1, "whole", "food:banana"), component("Lemon", 1, "whole", "food:lemon")] };
    row.eaten_slots["meal-5"] = ticked;
  }
  for (let age = 5; age < 10; age += 1) {
    const row = planDay(A, age);
    row.item_overrides["meal-5"] = { baseMealId: "gen", components: [component("Mom's dal", 1, "cup"),
      component("Greek yogurt, plain", 170, "g")] };
    row.eaten_slots["meal-5"] = ticked;
  }
  // Not ticks: a cleared slot that is marked eaten, and a planned slot never eaten.
  planDay(A, 11).item_overrides["meal-5"] = { baseMealId: null, components: [component("Banana", 1, "whole")],
    cleared: true };
  planDay(A, 11).eaten_slots["meal-5"] = ticked;
  planDay(A, 13).item_overrides["meal-5"] = { baseMealId: "gen", components: [component("Banana", 1, "whole")] };
  // The two consumed recipes.
  planDay(A, 15).eaten_slots["meal-2"] = consumed("rev-1", 1);
  planDay(A, 22).eaten_slots["meal-3"] = consumed("rev-2", 2);
  // B's tick of its own food, with a key naming A's own food (never resolved for B either).
  planDay(B, 2).item_overrides["meal-5"] = { baseMealId: "gen", components: [component("B secret stew", 300, "g",
    `food:${FOOD.bSecret}`)] };
  planDay(B, 2).eaten_slots["meal-5"] = ticked;
  const selection = (userId: string, age: number, slot: string, revision: string, fraction: number, lines: Row[]) =>
    ({ user_id: userId, local_date: day(age), slot_id: slot, recipe_revision_id: revision,
      serving_fraction: fraction, ingredient_snapshot: lines, superseded_at: null });
  return {
    log_entries: logs.map((log) => log.entry),
    log_items: logs.flatMap((log) => log.items),
    plan_days: planDays,
    recipe_plan_selections: [
      selection(A, 15, "meal-2", "rev-1", 1, recipeLines([
        { name: "Chicken breast", grams: 120, foodRefId: REF.c901 },
        { name: "Broccoli", grams: 80, foodDbId: "broccoli-cooked" },
        { name: "Olive oil", grams: 5, foodDbId: "olive-oil" },
        { name: "Lemon", grams: 20, foodDbId: "lemon" }])),
      selection(A, 22, "meal-3", "rev-2", 1, recipeLines([
        { name: "Egg noodles", grams: 100, foodDbId: "egg-noodles-cooked" },
        { name: "Spinach", grams: 30, foodDbId: "spinach-raw" },
        { name: "Salt", grams: null }])),
      selection(B, 15, "meal-2", "rev-1", 1, recipeLines([{ name: "B secret stew", grams: 400 }])),
    ],
    // Every line sits on a live list; a line counts only while its list is live.
    shopping_periods: [
      { id: LIST_A, user_id: A, deleted_at: null },
      { id: LIST_B, user_id: B, deleted_at: null },
    ],
    shopping_lines: [
      { user_id: A, period_id: LIST_A, origin: "manual", name: "Bananas", identity: { foodRefId: REF.c902 }, deleted_at: null, rev: 1,
        updated_at: `${day(3)}T10:00:00.000Z` },
      { user_id: A, period_id: LIST_A, origin: "manual", name: "Greek yogurt, plain", identity: null, deleted_at: null, rev: 1,
        updated_at: `${day(2)}T10:00:00.000Z` },
      { user_id: A, period_id: LIST_A, origin: "plan", name: "Bananas", identity: { foodRefId: REF.c902 }, deleted_at: null, rev: 1,
        updated_at: `${day(1)}T10:00:00.000Z` },
      { user_id: A, period_id: LIST_A, origin: "manual", name: "Bananas", identity: { foodRefId: REF.c902 },
        deleted_at: "2026-10-01T00:00:00Z", rev: 2, updated_at: `${day(1)}T10:00:00.000Z` },
      { user_id: B, period_id: LIST_B, origin: "manual", name: "B secret stew", identity: null, deleted_at: null, rev: 1,
        updated_at: `${day(1)}T10:00:00.000Z` },
    ],
    user_food_prefs: [
      { user_id: A, food_ref_id: REF.c901, status: "eats" },
      { user_id: A, food_ref_id: REF.dal, status: "eats" },
      { user_id: B, food_ref_id: REF.bSecret, status: "eats" },
      { user_id: B, food_ref_id: REF.c906, status: "avoid" },
    ],
    food_refs: [
      ...CATALOG.map(([id]) => ({ id: catRef(id), kind: "catalog", catalog_food_id: id, user_food_id: null })),
      { id: REF.dal, kind: "user", catalog_food_id: null, user_food_id: FOOD.dal },
      { id: REF.bSecret, kind: "user", catalog_food_id: null, user_food_id: FOOD.bSecret },
    ],
    user_foods: [
      { id: FOOD.dal, user_id: A, name: "Mom's dal", catalog_food_id: null },
      { id: FOOD.bSecret, user_id: B, name: "B secret stew", catalog_food_id: null },
    ],
    catalog_foods: CATALOG.map(([id, source, sourceId]) => ({ id, source, source_id: sourceId })),
    catalog_food_revisions: CATALOG.map(([id, , , description]) => ({ id: id * 10, catalog_food_id: id,
      description, is_active: true })),
  };
}

/** Per-ref policy facts: plain whole foods judged as food; the yogurt names milk. */
function facts(name: string, tags: string[], status?: string): SuggestionFoodEvidence {
  // A complete label that does not list milk clears it; the yogurt's lists it.
  const milk = { level: tags.includes("milk") ? "listed" : "not_listed", labelComplete: true } as const;
  return { allergenTags: tags, allergenEvidence: { milk }, checkedAllergens: [], ingredientsText: null, foodName: name,
    foodBrand: null, packaged: false, policyCategories: [],
    facets: { human_food: { p: 0.99, rubricVersion: 1, judgedAt: "2026-10-01T00:00:00Z" } },
    noCook: null, onEatsList: status === "eats", onAvoidList: status === "avoid", role: null };
}

export type FixturePorts = TastePorts & { profile: PolicyProfile; evidenceCalls: string[][];
  /** The lasagna's raw W4 inputs (a test may add to them). */
  mixedInputs: MixedDishInput[] };

/** Ports over the fixture's tables: the real Avoid read, a stub profile and evidence. */
export function tastePorts(tables: Record<string, Row[]>): FixturePorts {
  const ports: FixturePorts = {
    profile: { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], conditions: [], notes: null,
      profileRules: { items: [], asOf: NOW } },
    evidenceCalls: [],
    reviewRequired: async () => false,
    policy: async () => ({ profile: ports.profile, rev: 7 }),
    avoid: readAvoidList,
    evidence: async (userId, items) => {
      ports.evidenceCalls.push(items.map((item) => item.foodRefId));
      const byIdentity: SuggestionEvidence["byIdentity"] = {};
      for (const { foodRefId } of items) {
        const ref = tables.food_refs.find((row) => row.id === foodRefId);
        const pref = tables.user_food_prefs.find((row) => row.user_id === userId && row.food_ref_id === foodRefId);
        const name = ref?.user_food_id
          ? String(tables.user_foods.find((row) => row.id === ref.user_food_id)?.name ?? "")
          : String(tables.catalog_food_revisions.find((row) => row.catalog_food_id === ref?.catalog_food_id)
            ?.description ?? "");
        byIdentity[`ref:${foodRefId}`] = facts(name, /yogurt|creamy|matrixfruit/i.test(name) ? ["milk"] : [],
          pref?.status as string | undefined);
      }
      return { status: "ready", preferenceFlags: [], byIdentity };
    },
    mixedInputs: [{ foodDbId: "broccoli-cooked", gramsPerGram: 0.4 }, { foodDbId: "spinach-cooked", gramsPerGram: 0.05 },
      { foodDbId: "olive-oil", gramsPerGram: 0.02 }],
    mixedDishInputs: async (ids) => new Map(ids.includes(904) ? [[904, ports.mixedInputs]] : []),
  };
  return ports;
}

export function tasteDb(tables: Record<string, Row[]>): { client: SupabaseClient; queries: ReturnType<typeof fakeDb>["queries"];
  inSizes: { table: string; size: number }[] } {
  const fake = fakeDb(tables);
  const inSizes: { table: string; size: number }[] = [];
  const from = fake.client.from.bind(fake.client);
  (fake.client as unknown as { from: unknown }).from = (table: string) => {
    const builder = from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
    const inner = builder.in;
    builder.in = (column: unknown, values: unknown) => {
      inSizes.push({ table, size: (values as unknown[]).length });
      return inner(column, values);
    };
    return builder;
  };
  return { client: fake.client, queries: fake.queries, inSizes };
}
