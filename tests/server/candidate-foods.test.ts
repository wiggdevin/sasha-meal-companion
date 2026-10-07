/**
 * Phase 18 W2b: lib/server/candidate-foods.ts, the D4 admission order on the server, over the
 * in-memory PostgREST double. Eligibility, rule review, the policy profile and the universe
 * admission run for real; only the evidence cache (an admin read) is faked.
 *
 * Acceptance 3: a failed rule, Avoid or evidence read admits 0 foods and returns an error code.
 * Acceptance 4 (server half): a rule change committed while an admission runs admits nothing under
 * the old revision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshness } from "@/lib/foods/world/freshness";
import { HttpError } from "@/lib/server/auth";
import { fakeDb, type Row } from "@/tests/helpers/occasion-fake-db";
import { A, eatsEvidence, worldTables, type WorldOptions } from "@/tests/helpers/world-fixtures";

const evidence = vi.hoisted(() => ({ answer: null as unknown }));
vi.mock("@/lib/coach/suggest-policy", async (original) => ({
  ...(await original<typeof import("@/lib/coach/suggest-policy")>()),
  loadSuggestionEvidence: async () => evidence.answer,
}));

const { candidateFoods } = await import("@/lib/server/candidate-foods");

beforeEach(() => { evidence.answer = eatsEvidence(); });

/** The double, with `failing` tables answering a database error on every read. */
function db(options: WorldOptions = {}, failing: string[] = []) {
  const fake = fakeDb(worldTables(options));
  const from = fake.client.from.bind(fake.client);
  (fake.client as unknown as { from: unknown }).from = (table: string) => {
    if (!failing.includes(table)) return from(table);
    const error = { message: `${table} is unavailable`, code: "XX000" };
    const failed: Record<string, unknown> = {};
    for (const name of ["select", "eq", "in", "order", "range", "is", "not", "limit"]) failed[name] = () => failed;
    failed.maybeSingle = async () => ({ data: null, error });
    failed.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error }).then(resolve);
    return failed;
  };
  return fake;
}

async function code(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return "admitted";
  } catch (error) {
    return error instanceof HttpError ? `${error.status} ${error.code}` : String(error);
  }
}

describe("closed and open admission", () => {
  it("a closed world admits the verified Eats only, stamped with the token", async () => {
    const result = await candidateFoods(db().client, A);
    expect(result).toMatchObject({ world: "closed", token: { rulesVersion: 5, evidenceVersion: 2 },
      admittedRefIds: ["ref-bread", "ref-chicken"], admittedUniverseIds: [] });
  });

  it("an open world adds universe items that pass the account's rules, less every Avoid family", async () => {
    const result = await candidateFoods(db({ world: "open", allergens: ["gluten"] }).client, A);
    expect(result.admittedRefIds).toEqual(["ref-chicken"]);
    expect(result.admittedUniverseIds).toContain("chicken-breast-roasted");
    for (const id of ["whole-wheat-bread", "white-bread", "rye-bread"]) expect(result.admittedUniverseIds).not.toContain(id);
    // "Rice, brown" on Avoid and the family mark "salmon" remove their whole families.
    for (const id of ["white-rice-cooked", "brown-rice-cooked", "basmati-rice-cooked", "salmon-wild-sockeye-cooked"]) {
      expect(result.admittedUniverseIds).not.toContain(id);
      expect(result.excluded).toContainEqual({ id, verdict: "blocked", reason: "avoid_family" });
    }
  });
});

describe("an unmapped identity or missing nutrition is unavailable (D4, Sol r1 BLOCK 2)", () => {
  it("never admits a verified ref with no readable name, another account's food or no usable nutrition", async () => {
    const fake = db();
    const tables = fake.tables;
    tables.user_foods.push({ id: "no-macros", user_id: A, name: "Mystery bar", per_100g: { protein: 5 } },
      { id: "zero", user_id: A, name: "Water", per_100g: { protein: 0, carbohydrate: 0, fat_total: 0 } },
      { id: "theirs", user_id: "someone-else", name: "Their food", per_100g: { protein: 9, carbohydrate: 9, fat_total: 9 } },
      { id: "unnamed", user_id: A, name: null, per_100g: { protein: 9, carbohydrate: 9, fat_total: 9 } });
    for (const food of tables.user_foods.slice(-4)) {
      tables.food_refs.push({ id: `ref-${food.id}`, kind: "user", catalog_food_id: null, user_food_id: food.id, user_foods: food });
    }
    tables.food_refs.push({ id: "ref-catalog-gone", kind: "catalog", catalog_food_id: 999, user_food_id: null, user_foods: null });
    const verified = ["ref-chicken", "ref-no-macros", "ref-zero", "ref-theirs", "ref-unnamed", "ref-catalog-gone", "ref-missing"];
    const eligible = async () => ({ eligibleRefIds: verified, eligibleFoodIds: [], eligibleCatalogFoodIds: [],
      excluded: [], rulesRevision: 2, preferenceFlags: [] });
    const result = await candidateFoods(fake.client, A, { eligible });
    expect(result.admittedRefIds).toEqual(["ref-chicken"]);
    expect(Object.fromEntries(result.excluded.map((row) => [row.id, row.reason]))).toEqual({
      "ref-no-macros": "nutrition_unknown", "ref-zero": "nutrition_unknown", "ref-theirs": "unmapped",
      "ref-unnamed": "unmapped", "ref-catalog-gone": "unmapped", "ref-missing": "unmapped" });
  });
});

describe("inputs the column triggers missed (Sol r2): a held admission goes stale, a fresh one follows", () => {
  it("an Avoid mark's food_ref_id swap moves the token and the fresh admission excludes the new family", async () => {
    const fake = db({ world: "open" });
    const held = await candidateFoods(fake.client, A);
    expect(held.admittedUniverseIds).toContain("chicken-breast-roasted");
    expect(held.admittedUniverseIds).not.toContain("white-rice-cooked");
    const thigh = { id: "thigh", user_id: A, name: "Chicken, thigh", per_100g: { protein: 25, carbohydrate: 0, fat_total: 8 } };
    fake.tables.user_foods.push(thigh);
    fake.tables.food_refs.push({ id: "ref-thigh", kind: "user", catalog_food_id: null, user_food_id: "thigh", user_foods: thigh });
    const avoid = fake.tables.user_food_prefs.find((row) => row.status === "avoid")!;
    avoid.food_ref_id = "ref-thigh";
    fake.tables.account_rules_clock[0].rules_rev = 6; // what the trigger does (food-world-clocks-db.test.ts)
    const fresh = await candidateFoods(fake.client, A);
    expect(freshness(held.token, fresh.token)).toEqual({ fresh: false, reason: "stale" });
    expect(fresh.admittedUniverseIds).not.toContain("chicken-breast-roasted");
    expect(fresh.admittedUniverseIds).toContain("white-rice-cooked");
  });

  it("a catalog description or nutrient change is followed by the fresh admission", async () => {
    const fake = db();
    fake.tables.food_refs.push({ id: "ref-cat", kind: "catalog", catalog_food_id: 77, user_food_id: null, user_foods: null });
    const revision = { id: 7, catalog_food_id: 77, description: "Lentils, cooked", is_active: true,
      catalog_food_nutrients: [{ nutrient_code: "protein", amount_per_100g: 9 },
        { nutrient_code: "carbohydrate", amount_per_100g: 20 }, { nutrient_code: "fat_total", amount_per_100g: 0.4 }] };
    fake.tables.catalog_food_revisions.push(revision);
    const eligible = async () => ({ eligibleRefIds: ["ref-cat"], eligibleFoodIds: [], eligibleCatalogFoodIds: [77],
      excluded: [], rulesRevision: 2, preferenceFlags: [] });
    expect((await candidateFoods(fake.client, A, { eligible })).admittedRefIds).toEqual(["ref-cat"]);
    revision.description = "Salmon, cooked"; // the account avoids the salmon family
    expect((await candidateFoods(fake.client, A, { eligible })).excluded)
      .toContainEqual({ id: "ref-cat", verdict: "blocked", reason: "avoid_family" });
    revision.description = "Lentils, cooked";
    revision.catalog_food_nutrients[0].amount_per_100g = null as unknown as number;
    expect((await candidateFoods(fake.client, A, { eligible })).excluded)
      .toContainEqual({ id: "ref-cat", verdict: "unverified", reason: "nutrition_unknown" });
  });
});

describe("a failed read admits nothing (W2b acceptance 3)", () => {
  it.each([
    ["the constraint profile", ["constraint_profiles"]],
    ["the Avoid list", ["user_food_prefs"]],
    ["the family Avoid marks", ["food_membership_revisions"]],
    ["the settings row", ["user_settings"]],
    ["the profile instances", ["user_dietary_profiles"]],
    ["the rules clock", ["account_rules_clock"]],
    ["the evidence clock", ["evidence_clock"]],
  ])("%s", async (_label, failing) => {
    expect(await code(candidateFoods(db({ world: "open" }, failing).client, A)))
      .toMatch(/^(503 admission_unavailable|503 rules_version_unavailable)$/);
  });

  it("the Eats evidence", async () => {
    evidence.answer = { status: "unavailable", preferenceFlags: [], byIdentity: {} };
    expect(await code(candidateFoods(db({ world: "open" }).client, A))).toBe("503 admission_unavailable");
  });
});

describe("a rule change during admission (W2b acceptance 4, server half)", () => {
  it("admits nothing under the old revision when another device's write commits mid-read", async () => {
    const fake = db({ world: "open" });
    const clock = (fake.tables.account_rules_clock as Row[])[0];
    const eligible = async (...args: Parameters<typeof import("@/lib/server/eligible-foods").eligibleFoods>) => {
      const { eligibleFoods } = await import("@/lib/server/eligible-foods");
      const answer = await eligibleFoods(...args);
      clock.rules_rev = 6; // the other device's Avoid mark commits now
      return answer;
    };
    expect(await code(candidateFoods(fake.client, A, { eligible }))).toBe("409 rules_changed");
    // The next request reads under the new revision.
    expect((await candidateFoods(fake.client, A)).token).toEqual({ rulesVersion: 6, evidenceVersion: 2 });
  });

  it("an evidence write mid-read counts the same", async () => {
    const fake = db({ world: "open" });
    const clock = (fake.tables.evidence_clock as Row[])[0];
    const eligible = async (...args: Parameters<typeof import("@/lib/server/eligible-foods").eligibleFoods>) => {
      const { eligibleFoods } = await import("@/lib/server/eligible-foods");
      const answer = await eligibleFoods(...args);
      clock.evidence_rev = 3;
      return answer;
    };
    expect(await code(candidateFoods(fake.client, A, { eligible }))).toBe("409 rules_changed");
  });
});
