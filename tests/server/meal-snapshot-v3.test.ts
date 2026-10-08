/**
 * Phase 18 W8: `GET /api/foods/eligible?v=3` for an open food-world account
 * (lib/server/meal-snapshot-v3.ts), over the in-memory PostgREST double. Admission, the v2 parts,
 * the taste admission and `pref-2` run for real; only the evidence cache (an admin read) is faked.
 *
 * Covers: the body parses under the strict v3 contract; the admitted sets are the D4 admission's;
 * acceptance 5 (the largest body is at most 250 KB); acceptance 9 (no cohort, sex, age band, race or
 * ethnicity field); a token that moves while the body is built answers nothing under the old one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNIVERSE } from "@/lib/foods/universe/manifest";
import type { MealSnapshotV3, SnapshotFoodV3 } from "@/lib/meals/snapshot-v3";
import { HttpError } from "@/lib/server/auth";
import { fakeDb, type Row } from "@/tests/helpers/occasion-fake-db";
import { A, eatsEvidence, worldTables, type WorldOptions } from "@/tests/helpers/world-fixtures";

vi.mock("server-only", () => ({}));
const evidence = vi.hoisted(() => ({ answer: null as unknown }));
vi.mock("@/lib/coach/suggest-policy", async (original) => ({
  ...(await original<typeof import("@/lib/coach/suggest-policy")>()),
  loadSuggestionEvidence: async () => evidence.answer,
}));

const { mealSnapshotV3, checkByteBudget, snapshotV3Overages, resetSnapshotV3Overages } =
  await import("@/lib/server/meal-snapshot-v3");
const { parseMealSnapshotV3, SNAPSHOT_V3_MAX_BYTES } = await import("@/lib/meals/snapshot-v3");

const NOW = new Date("2026-10-06T15:00:00Z");
const NEUTRAL = () => ({ prior: { status: "neutral" as const, reason: "country_unset" as const }, cohort: "national" });

beforeEach(() => { evidence.answer = eatsEvidence(); });

function tables(options: WorldOptions = {}, extra: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  const base = worldTables(options);
  base.user_settings = base.user_settings.map((row) => ({ ...row, slot_times: {}, shift_minutes: 0, meals_per_day: 4,
    time_zone: "UTC", cuisines: ["mediterranean"], country_code: "US", sex: "female", birth_year: 1990 }));
  return { ...base, ...extra } as Record<string, Row[]>;
}

async function v3(options: WorldOptions = {}, deps: Parameters<typeof mealSnapshotV3>[3] = {}) {
  const fake = fakeDb(tables(options));
  return mealSnapshotV3(fake.client, A, NOW, { prior: NEUTRAL, ...deps });
}

describe("snapshot v3 for an open account", () => {
  it("parses under the strict contract, stamped with the admission token", async () => {
    const body = await v3({ world: "open" });
    const parsed = parseMealSnapshotV3(JSON.parse(JSON.stringify(body)));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ schemaVersion: 3, world: "open", accountId: A, rulesVersion: 5, evidenceVersion: 2,
      prefVersion: "pref-2", focusUntil: null, plateRules: [], admittedRefIds: ["ref-bread", "ref-chicken"] });
    expect(parsed!.admittedUniverseIds.length).toBeGreaterThan(100);
    // Every entry in `foods` is admitted; the Avoid family (salmon) is nowhere in the admitted sets.
    expect(parsed!.admittedUniverseIds.some((id) => id.includes("salmon"))).toBe(false);
    expect(Object.keys(parsed!.foods).some((id) => id.includes("salmon"))).toBe(false);
    expect(parsed!.foods.chicken).toMatchObject({ source: "favored", userRefId: "ref-chicken", universeId: null });
    expect(parsed!.foods.chicken.reasons).toContain("favored");
    expect(parsed!.foods.chicken.z.base).toBeGreaterThan(0);
  });

  it("answers the v2 body for a closed account", async () => {
    const body = await v3({ world: "closed" }) as unknown as Record<string, unknown>;
    expect(body.schemaVersion).toBe(2);
    expect(body.world).toBeUndefined();
  });

  it("carries no cohort, sex, age band, country, race or ethnicity field (acceptance 9)", async () => {
    const text = JSON.stringify(await v3({ world: "open", flags: ["kosher"] }, {
      prior: () => ({ prior: { status: "loaded", byCohort: new Map([["national", new Map([["2-milk", 0.2]])],
        ["female_30_39", new Map([["2-milk", 0.3]])]]) }, cohort: "female_30_39" }),
    }));
    for (const word of ["cohort", "female", "male", "sex", "birth", "age_band", "30_39", "country", "\"US\"", "race",
      "ethnic", "hispanic", "n_eff"]) {
      expect([word, text.toLowerCase().includes(word.toLowerCase())]).toEqual([word, false]);
    }
  });

  it("the largest body from the bounded universe pool alone, every item admitted with plate "
    + "evidence and reasons, is at most 250 KB (acceptance 5)", async () => {
    const body = await v3({ world: "open", flags: ["kosher"] }, {
      taste: async () => ({ profile: { m: 30, identities: UNIVERSE.map((entry, i) => ({ key: `u:${entry.id}`,
        name: entry.id, h: (i % 7) + 0.5, q: i % 3, days180: 3, episodes: 3, lastOn: "2026-10-05",
        provenance: { match: "universe" as const, estimated: false, sources: { log: 1, recipe: 0, tick: 0, mixed_dish: 0 },
          collapsed: 0, choices: { swap_pick: 0, plan_add: 0, shopping_manual: 0 } } })) }, identities: new Map() }),
    });
    const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
    console.info(`snapshot v3 largest body: ${bytes} bytes, ${Object.keys((body as { foods: object }).foods).length} foods`);
    expect(bytes).toBeLessThanOrEqual(SNAPSHOT_V3_MAX_BYTES);
    expect(parseMealSnapshotV3(JSON.parse(JSON.stringify(body)))?.plateRules).toEqual(["kosher_meat_dairy"]);
  });

  const bigFoods = (count: number, source: "favored" | "universe", prefix: string): Record<string, SnapshotFoodV3> => {
    const foods: Record<string, SnapshotFoodV3> = {};
    for (let i = 0; i < count; i += 1) {
      const universeId = `${prefix}-${i}`;
      // A universe entry's key must be `universe:<universeId>` (parseMealSnapshotV3's admission
      // check), same as the real server builder.
      const id = source === "universe" ? `universe:${universeId}` : universeId;
      foods[id] = { userRefId: source === "favored" ? `ref-${prefix}-${i}` : null, catalogRefId: null,
        universeId: source === "universe" ? universeId : null, source,
        z: { base: 0.12, occasion: { lunch: 0.2, dinner: -0.1 } }, reasons: ["favored", "eaten", "cuisine"],
        history: { lunch: 0.4 }, facets: { lunch: 0.6 }, plate: { meat: "present", dairy: "absent" } };
    }
    return foods;
  };
  const bodyOf = (foods: Record<string, SnapshotFoodV3>, admittedRefIds: string[],
    admittedUniverseIds: string[]): MealSnapshotV3 => ({ schemaVersion: 3, rankingVersion: "r", universeVersion: "u",
    universeHash: "h", prefVersion: "p", priorVersion: "population", graphVersion: "none", accountId: A,
    rulesVersion: 1, evidenceVersion: 1, computedAt: NOW.toISOString(), inputsHash: "hash", world: "open",
    focusUntil: null, plateRules: [], admittedUniverseIds, admittedRefIds, foods, excluded: [],
    eligible: { eligibleRefIds: admittedRefIds, eligibleFoodIds: [], eligibleCatalogFoodIds: [] } });

  it("acceptance 5's stated exception: a body over 250 KB is sent COMPLETE, never with a dropped "
    + "entry — dropping one would change ranking, kosher plate evidence or admission itself (Sol "
    + "re-plan, after r1/r2 BLOCKed an entry-dropping design)", () => {
    const favored = bigFoods(300, "favored", "favored");
    const universe = bigFoods(1000, "universe", "universe");
    const admittedRefIds = Object.keys(favored).map((id) => favored[id].userRefId!);
    const admittedUniverseIds = Object.values(universe).map((food) => food.universeId!);
    const body = bodyOf({ ...favored, ...universe }, admittedRefIds, admittedUniverseIds);
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(SNAPSHOT_V3_MAX_BYTES);
    const checked = checkByteBudget(body);
    // Byte-for-byte identical: nothing was dropped, trimmed or otherwise changed.
    expect(checked).toEqual(body);
    expect(parseMealSnapshotV3(JSON.parse(JSON.stringify(checked)))).not.toBeNull();
  });

  it("followups #6: counts an overage (log counter) without trimming anything", () => {
    resetSnapshotV3Overages();
    expect(snapshotV3Overages()).toBe(0);
    const favored = bigFoods(300, "favored", "favored");
    const universe = bigFoods(1000, "universe", "universe");
    const admittedRefIds = Object.keys(favored).map((id) => favored[id].userRefId!);
    const admittedUniverseIds = Object.values(universe).map((food) => food.universeId!);
    const body = bodyOf({ ...favored, ...universe }, admittedRefIds, admittedUniverseIds);
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(SNAPSHOT_V3_MAX_BYTES);

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    checkByteBudget(body);
    expect(snapshotV3Overages()).toBe(1);
    checkByteBudget(body);
    expect(snapshotV3Overages()).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("followups #6: a body within budget never bumps the overage counter", () => {
    resetSnapshotV3Overages();
    const favored = bigFoods(20, "favored", "favored");
    const universe = bigFoods(UNIVERSE.length, "universe", "universe");
    const admittedRefIds = Object.keys(favored).map((id) => favored[id].userRefId!);
    const admittedUniverseIds = Object.values(universe).map((food) => food.universeId!);
    const body = bodyOf({ ...favored, ...universe }, admittedRefIds, admittedUniverseIds);
    checkByteBudget(body);
    expect(snapshotV3Overages()).toBe(0);
  });

  it("the realistic case meets the 250 KB cap without the exception: a bounded universe pool "
    + "(124 items) plus a normal Favored list (20 foods) stays comfortably under it", () => {
    const favored = bigFoods(20, "favored", "favored");
    const universe = bigFoods(UNIVERSE.length, "universe", "universe");
    const admittedRefIds = Object.keys(favored).map((id) => favored[id].userRefId!);
    const admittedUniverseIds = Object.values(universe).map((food) => food.universeId!);
    const body = bodyOf({ ...favored, ...universe }, admittedRefIds, admittedUniverseIds);
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeLessThanOrEqual(SNAPSHOT_V3_MAX_BYTES);
    expect(checkByteBudget(body)).toEqual(body);
  });

  it("answers nothing under the old token when a rule write commits while the body is built", async () => {
    const t = tables({ world: "open" });
    const fake = fakeDb(t);
    const run = mealSnapshotV3(fake.client, A, NOW, { prior: NEUTRAL, taste: async () => {
      // Another device marks a food Avoid in the middle of the build: the rules clock moves.
      t.account_rules_clock[0].rules_rev = 6;
      return { profile: { m: 0, identities: [] }, identities: new Map() };
    } });
    await expect(run).rejects.toMatchObject({ status: 409, code: "rules_changed" });
    expect(HttpError).toBeDefined();
  });

  it("a failed taste read drops personal evidence only; the admitted sets are unchanged", async () => {
    const ok = await v3({ world: "open" });
    const failed = await v3({ world: "open" }, { taste: async () => { throw new Error("history down"); } });
    expect((failed as { admittedUniverseIds: string[] }).admittedUniverseIds)
      .toEqual((ok as { admittedUniverseIds: string[] }).admittedUniverseIds);
    expect((failed as { admittedRefIds: string[] }).admittedRefIds).toEqual((ok as { admittedRefIds: string[] }).admittedRefIds);
  });

  it("the real taste read runs on the account's own rows", async () => {
    const body = await v3({ world: "open" }, { taste: undefined });
    expect(parseMealSnapshotV3(JSON.parse(JSON.stringify(body)))).not.toBeNull();
  });
});
