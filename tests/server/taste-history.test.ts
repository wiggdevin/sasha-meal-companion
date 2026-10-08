/**
 * Phase 18 W3 acceptance (docs/specs/phase-18-open-world-foods.md §10 W3), through the real server
 * read, identity, episode, admission and policy code over the PostgREST double.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { H_HALF_LIFE_DAYS, M_HALF_LIFE_DAYS } from "@/lib/meals/taste";
import { accountTaste, type TasteResponse } from "@/lib/server/taste-admission";
import { favorableResolver } from "@/lib/server/taste-favor";
import { favorPorts } from "@/tests/helpers/favor-fakes";
import { ID_BATCH } from "@/lib/server/date-chunks";
import {
  A, B, NOW, REF, TODAY, day, tasteDb, tastePorts, tasteTables, type FixturePorts,
} from "@/tests/helpers/taste-fixture";
import type { Row } from "@/tests/helpers/occasion-fake-db";

const GOLDEN = JSON.parse(readFileSync(new URL("../meals/__golden__/taste-w3.golden.json", import.meta.url),
  "utf8")) as TasteResponse;

let tables: Record<string, Row[]>;
let ports: FixturePorts;
beforeEach(() => {
  tables = tasteTables();
  ports = tastePorts(tables);
});

const read = (userId = A) => {
  const { client } = tasteDb(tables);
  return accountTaste(client, userId, TODAY, ports, NOW, favorableResolver(client, userId, favorPorts(tables, ports), NOW));
};
const item = (body: TasteResponse, key: string) => body.items.find((row) => row.key === key);
const decay = (ages: number[], halfLife: number, weight = 1) =>
  ages.reduce((sum, age) => sum + weight * 0.5 ** (age / halfLife), 0);
const r4 = (value: number) => Math.round(value * 10_000) / 10_000;

describe("W3 acceptance 1: a fixed history gives exact deduplicated H, Q and M (golden file)", () => {
  it("matches the golden file exactly", async () => {
    expect(await read()).toEqual(GOLDEN);
  });

  it("counts each recipe meal once: the consumed recipe and two logs of the same meal are one episode", async () => {
    const chicken = item(await read(), "u:chicken-breast-roasted")!;
    // Days 0–4 (keyed ticks), 1, 2, 5, 8 (logs), 15 (recipe + duplicate logs); the 5 g taste on day 9 adds nothing.
    expect(chicken.days180).toBe(8);
    expect(chicken.provenance.sources).toEqual({ log: 5, recipe: 1, tick: 5, mixed_dish: 0 });
    expect(chicken.provenance.collapsed).toBe(2);
    expect(chicken.h).toBe(r4(decay([0, 1, 2, 3, 4, 5, 8, 15], H_HALF_LIFE_DAYS)));
    expect(chicken.favored).toBe(true);
  });

  it("weighs a name family at half and a mixed dish's estimated input at half again", async () => {
    const body = await read();
    expect(item(body, "f:greek yogurt")).toMatchObject({ name: "Greek yogurt, plain", days180: 5, q: 0.5,
      h: r4(decay([5, 6, 7, 8, 9], H_HALF_LIFE_DAYS, 0.5)) });
    expect(item(body, "u:broccoli-cooked")).toMatchObject({ days180: 2,
      h: r4(decay([15], H_HALF_LIFE_DAYS) + decay([12], H_HALF_LIFE_DAYS, 0.5)),
      provenance: expect.objectContaining({ estimated: true, sources: { log: 0, recipe: 1, tick: 0, mixed_dish: 1 } }) });
    // A ref-less universe line is judged by the W2b gate. Egg noodles carry an unknown allergen key,
    // which no rule of this account reads, so they count (owner direction 2026-10-08: every eaten
    // ingredient feeds the profile unless the account's rules exclude it).
    expect(item(body, "u:egg-noodles-cooked")).toBeDefined();
    // The dish itself is not an identity once its inputs are known.
    expect(body.items.some((row) => row.key.includes("lasagna"))).toBe(false);
  });

  it("drops items under 10 g, recipe lines with no grams and non-countable foods", async () => {
    const keys = (await read()).items.map((row) => row.key);
    expect(keys).not.toContain("u:olive-oil");
    expect(keys).not.toContain("u:lemon");
    expect(keys.some((key) => key.includes("salt"))).toBe(false);
  });

  it("M counts 31 independent episodes over 26 days with a 90-day half-life", async () => {
    const body = await read();
    expect(body.episodes).toBe(31);
    expect(body.m).toBeCloseTo(GOLDEN.m, 4);
    expect(body.m).toBeLessThan(31);
    expect(M_HALF_LIFE_DAYS).toBe(90);
  });

  it("Q dates a choice by its creation: an edit never revives an old line", async () => {
    // Created 200 days ago (outside the window) and edited today: rev 2, updated_at today.
    tables.shopping_lines.push({ user_id: A, origin: "manual", name: "Bananas", identity: { foodRefId: REF.c902 },
      deleted_at: null, rev: 2, updated_at: `${TODAY}T09:00:00.000Z` });
    expect(item(await read(), "u:banana")!.q).toBe(1);
  });

  it("Q counts live manual shopping lines only", async () => {
    const banana = item(await read(), "u:banana")!;
    expect(banana.q).toBe(1);
    expect(banana.provenance.choices.shopping_manual).toBe(1);
  });
});

describe("W3 acceptance 2: deleting or moving an entry changes the values on the next read", () => {
  it("a deleted log stops counting", async () => {
    const before = item(await read(), "f:mom's dal")!;
    const dal = tables.log_items.filter((row) => row.food_ref_id === REF.dal).map((row) => row.entry_id);
    tables.log_entries.find((row) => row.id === dal[0])!.deleted_at = "2026-10-06T10:00:00Z";
    const after = item(await read(), "f:mom's dal")!;
    expect(after.days180).toBe(before.days180 - 1);
    expect(after.h).toBeLessThan(before.h);
  });

  it("a moved log counts on its new date", async () => {
    const chicken = tables.log_items.find((row) => row.food_ref_id === REF.c901 && row.grams === 150)!;
    tables.log_entries.find((row) => row.id === chicken.entry_id)!.local_date = day(40);
    const after = item(await read(), "u:chicken-breast-roasted")!;
    // Day 1 still has its keyed tick; day 40 is a new eaten day.
    expect(after.days180).toBe(9);
    expect(after.h).not.toBe(item(GOLDEN, "u:chicken-breast-roasted")!.h);
  });

  it("an unticked slot stops counting", async () => {
    const row = tables.plan_days.find((r) => r.user_id === A && r.local_date === day(9))!;
    (row.eaten_slots as Row)["meal-5"] = { eaten_at: null, changed_at: "2026-10-06T10:00:00Z" };
    expect(item(await read(), "f:greek yogurt")!.days180).toBe(4);
  });
});

describe("W3 acceptance 3: another account's rows never appear", () => {
  it("B's foods, ticks, recipes and shopping lines are absent, and B's rows change nothing for A", async () => {
    const withB = await read();
    expect(JSON.stringify(withB)).not.toMatch(/secret|b-secret/i);
    for (const table of Object.keys(tables)) {
      tables[table] = tables[table].filter((row) => row.user_id !== B);
    }
    expect(await read()).toEqual(withB);
  });

  it("every read of an account-owned table carries the explicit user_id filter", async () => {
    const db = tasteDb(tables);
    await accountTaste(db.client, A, TODAY, ports, NOW);
    const owned = ["log_entries", "plan_days", "recipe_plan_selections", "shopping_lines", "user_food_prefs",
      "user_foods"];
    const reads = db.queries.filter((q) => owned.includes(q.table));
    expect(new Set(reads.map((q) => q.table))).toEqual(new Set(owned));
    for (const q of reads) expect(q.filters).toContain("eq:user_id");
  });

  it("B reading its own account sees its own rows only, under its own Avoid list", async () => {
    const b = await read(B);
    // B avoids a banana family member, so its banana log is held out; its own stew and chicken count.
    expect(b.items.map((row) => row.key).sort()).toEqual(["f:b secret stew", "u:chicken-breast-roasted"]);
    expect(b.items.find((row) => row.key === "u:chicken-breast-roasted")?.days180).toBe(1);
    expect(JSON.stringify(b)).not.toMatch(/dal|yogurt|noodles/i);
  });
});

describe("W3 acceptance 4: Avoid and blocking rules hold evidence out; removing them restores it", () => {
  it("an Avoid mark on any member of the family removes the food, and removing the mark restores it", async () => {
    tables.user_food_prefs.push({ user_id: A, food_ref_id: REF.c906, status: "avoid" });
    const avoided = await read();
    expect(item(avoided, "u:banana")).toBeUndefined();
    expect(avoided.episodes).toBeLessThan(GOLDEN.episodes);
    tables.user_food_prefs.pop();
    expect(await read()).toEqual(GOLDEN);
  });

  it("an allergen rule that blocks the food removes it from H, Q and M; removing the rule restores it", async () => {
    ports.profile = { ...ports.profile, avoid_allergens: ["milk"] };
    const ruled = await read();
    expect(item(ruled, "f:greek yogurt")).toBeUndefined();
    // Day 7 meal 1 held only the yogurt: that episode no longer counts.
    expect(ruled.episodes).toBe(GOLDEN.episodes - 1);
    ports.profile = { ...ports.profile, avoid_allergens: [] };
    expect(await read()).toEqual(GOLDEN);
  });

  it("a tick keyed to a catalog food that an account food was made from is judged on that account food too", async () => {
    // Sol W3 r1 probe: a milk-containing account food made from the SR chicken, ticked on day 20.
    const OWN = "0b9c2f7e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
    tables.user_foods.push({ id: OWN, user_id: A, name: "Chicken breast, creamy", catalog_food_id: 901 });
    tables.food_refs.push({ id: REF.creamy, kind: "user", catalog_food_id: null, user_food_id: OWN });
    const tick = (age: number, foodKey: string) => {
      const row = { user_id: A, local_date: day(age), eaten_slots: { "meal-6": { eaten_at: "2026-10-01T08:00:00Z",
        changed_at: "2026-10-01T08:00:00Z" } }, item_overrides: { "meal-6": { baseMealId: "gen", components: [
        { name: "Chicken breast, creamy", qty: 150, unit: "g", role: "protein", macros: {}, foodKey }] } } };
      tables.plan_days.push(row);
    };
    tick(20, "catalog:901");
    tick(25, `food:${OWN}`);
    const open = item(await read(), "u:chicken-breast-roasted")!;
    expect(open.days180).toBe(10);
    ports.profile = { ...ports.profile, avoid_allergens: ["milk"] };
    const ruled = item(await read(), "u:chicken-breast-roasted")!;
    // Neither creamy tick counts; nor do the day 0–4 ticks keyed to the same catalog food, since an
    // account food made from it is blocked. The plain catalog logs (days 1, 2, 5, 8, 15) still do.
    expect(ruled.days180).toBe(5);
    expect(ruled.provenance.sources.tick).toBe(0);
    ports.profile = { ...ports.profile, avoid_allergens: [] };
    expect(item(await read(), "u:chicken-breast-roasted")).toEqual(open);
  });

  it("an Avoid-marked mixed dish contributes no evidence for its inputs either", async () => {
    tables.user_food_prefs.push({ user_id: A, food_ref_id: REF.c904, status: "avoid" });
    const body = await read();
    expect(item(body, "u:spinach-cooked")).toBeUndefined();
    expect(item(body, "u:broccoli-cooked")).toMatchObject({ days180: 1, provenance: expect.objectContaining({
      estimated: false, sources: { log: 0, recipe: 1, tick: 0, mixed_dish: 0 } }) });
    tables.user_food_prefs.pop();
    expect(await read()).toEqual(GOLDEN);
  });

  it("an unreadable rule check admits nothing (fail closed)", async () => {
    ports.evidence = async () => ({ status: "unavailable", preferenceFlags: [], byIdentity: {} });
    const body = await read();
    expect(body.items).toEqual([]);
    expect(body.m).toBe(0);
  });

  it("a pending rule review answers 409, like the eligible set", async () => {
    ports.reviewRequired = async () => true;
    await expect(read()).rejects.toMatchObject({ status: 409, code: "rule_review_required" });
  });
});

describe("W3 acceptance 5: every read is bounded by date chunks and id batches", () => {
  it("date-keyed reads carry a closed window inside the 180 days; id reads stay within a batch", async () => {
    for (let i = 0; i < 260; i += 1) {
      const id = `bulk-${i}`;
      tables.log_entries.push({ id, user_id: A, local_date: day(i % 30), slot: "meal-6", deleted_at: null });
      tables.log_items.push({ entry_id: id, food_ref_id: REF.c902, grams: 100 });
    }
    const db = tasteDb(tables);
    await accountTaste(db.client, A, TODAY, ports, NOW);
    for (const q of db.queries.filter((x) => ["log_entries", "plan_days", "recipe_plan_selections"].includes(x.table))) {
      expect(q.filters).toEqual(expect.arrayContaining(["eq:user_id", "gte:local_date", "lte:local_date"]));
    }
    for (const q of db.queries.filter((x) => x.table === "shopping_lines")) {
      expect(q.filters).toEqual(expect.arrayContaining(["eq:user_id", "gte:updated_at", "lte:updated_at"]));
    }
    expect(db.inSizes.length).toBeGreaterThan(0);
    for (const { size } of db.inSizes) expect(size).toBeLessThanOrEqual(ID_BATCH);
    expect(db.inSizes.filter((x) => x.table === "log_items").length).toBeGreaterThanOrEqual(3);
    for (const batch of ports.evidenceCalls) expect(batch.length).toBeLessThanOrEqual(ID_BATCH);
  });

  it("rows older than the window never count", async () => {
    tables.log_entries.push({ id: "old", user_id: A, local_date: day(180), slot: "meal-1", deleted_at: null });
    tables.log_items.push({ entry_id: "old", food_ref_id: REF.c904, grams: 300 });
    expect(await read()).toEqual(GOLDEN);
  });
});
