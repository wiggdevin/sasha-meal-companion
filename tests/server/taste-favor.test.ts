/**
 * Phase 18 D6: `POST /api/foods/favor` and the taste item's `favorable` run one plan: the item's
 * refs, each family's FULL write set, every member judged, marks read owner-scoped (the session
 * client cannot see them), then one all-or-nothing write. Runs the real history, admission and
 * plan code over the PostgREST double with the in-memory RPC doubles (tests/helpers/favor-fakes.ts).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { accountTaste } from "@/lib/server/taste-admission";
import {
  favorableResolver, favorTasteKey, parseTasteKey, type FavorPorts,
} from "@/lib/server/taste-favor";
import { bumpClock, clockOf, favorPorts, sessionClient, type FavorCall } from "@/tests/helpers/favor-fakes";
import type { Row } from "@/tests/helpers/occasion-fake-db";
import { A, B, NOW, REF, TODAY, catRef, tastePorts, tasteTables, type FixturePorts } from "@/tests/helpers/taste-fixture";

let tables: Record<string, Row[]>;
let ports: FixturePorts;
let favor: FavorPorts & { calls: FavorCall[] };

const client = () => sessionClient(tables);
const post = (key: unknown, userId = A) => favorTasteKey(client(), userId, key, TODAY, favor, NOW);
const rejection = (key: unknown, userId = A) => post(key, userId).then(() => null,
  (error: { status: number; code: string }) => ({ status: error.status, code: error.code }));
const taste = (userId = A) => accountTaste(client(), userId, TODAY, ports, NOW, favorableResolver(client(), userId, favor, NOW));
const favorable = async (key: string) => (await taste()).items.find((item) => item.key === key)?.favorable;
const owned = (userId: string) => JSON.stringify(Object.fromEntries(Object.entries(tables)
  .map(([table, rows]) => [table, rows.filter((row) => row.user_id === userId)])));
const marks = () => tables.food_membership_revisions.filter((row) => row.user_id === A);

/** A same-family catalog food the fixture's evidence tags with milk ("creamy"). */
function addCreamyBananas() {
  tables.catalog_foods.push({ id: 907, source: "fdc_branded", source_id: "0907" });
  tables.catalog_food_revisions.push({ id: 9070, catalog_food_id: 907, description: "Bananas, creamy", is_active: true });
  tables.food_refs.push({ id: catRef(907), kind: "catalog", catalog_food_id: 907, user_food_id: null });
}

/** An own food made from the SR chicken, logged today: the chicken item now spans two families. */
function addOwnChicken(name: string) {
  const food = "00000000-0000-4000-8000-000000003001";
  const ref = "00000000-0000-4000-8000-000000003002";
  tables.user_foods.push({ id: food, user_id: A, name, catalog_food_id: 901 });
  tables.food_refs.push({ id: ref, kind: "user", catalog_food_id: null, user_food_id: food });
  tables.log_entries.push({ id: "entry-mine", user_id: A, local_date: TODAY, slot: "meal-2", deleted_at: null });
  tables.log_items.push({ entry_id: "entry-mine", food_ref_id: ref, grams: 150 });
  return ref;
}

beforeEach(() => {
  tables = tasteTables();
  tables.account_rules_clock = [{ user_id: A, rules_rev: 40 }, { user_id: B, rules_rev: 90 }];
  ports = tastePorts(tables);
  favor = favorPorts(tables, ports);
});

describe("favorable and POST agree", () => {
  it("favorable on every item is exactly 'POST answers 200'", async () => {
    const items = (await taste()).items;
    expect(items.map((item) => [item.key, item.favorable])).toEqual([
      ["u:banana", true], ["u:chicken-breast-roasted", true], ["f:mom's dal", true], ["f:greek yogurt", true],
      ["u:broccoli-cooked", false], ["u:spinach-raw", false], ["u:spinach-cooked", false]]);
    for (const item of items) expect((await rejection(item.key)) === null, item.key).toBe(item.favorable);
  });

  it("parses only the two identity shapes, normalized", () => {
    expect(parseTasteKey("u:banana")).toEqual({ kind: "u", id: "banana" });
    expect(parseTasteKey("f:mom's dal")).toEqual({ kind: "f", family: "mom's dal" });
    for (const bad of ["banana", "u:", "u:not-a-food", "f:", "f:Greek Yogurt", "f:greek yogurt, plain", "food:banana",
      "catalog:901", `f:${"a".repeat(200)}`, 7, null, {}]) expect(parseTasteKey(bad), String(bad)).toBeNull();
  });
});

describe("the family write set", () => {
  it("an allowed Bananas ref beside a milk-blocked 'Bananas, creamy': not favorable, 422, nothing written", async () => {
    addCreamyBananas();
    ports.profile = { ...ports.profile, avoid_allergens: ["milk"] };
    const before = JSON.stringify(tables);
    expect(await favorable("u:banana")).toBe(false);
    expect(await rejection("u:banana")).toEqual({ status: 422, code: "nothing_to_favor" });
    expect(favor.calls).toEqual([]);
    expect(JSON.stringify(tables)).toBe(before);
  });

  it("writes the allowed family's full set when the item's other family is blocked", async () => {
    const mine = addOwnChicken("Creamy roast chicken (mine)");
    ports.profile = { ...ports.profile, avoid_allergens: ["milk"] };
    expect(await post("u:chicken-breast-roasted")).toEqual({ favored: true, refs: 1, skippedAvoid: 0, rulesRevision: 7 });
    expect(favor.calls.map((call) => call.write.families)).toEqual([[{ name_norm: "chicken", ref_ids: [REF.c901] }]]);
    expect(marks().map((row) => row.name_norm)).toEqual(["chicken"]);
    expect(tables.user_food_prefs.some((pref) => pref.food_ref_id === mine && pref.user_id === A)).toBe(false);
  });

  it("writes the whole family set with the item's ref, and only after every check", async () => {
    addCreamyBananas();
    expect(await post("u:banana")).toMatchObject({ favored: true, refs: 1 });
    expect(favor.calls[0].write).toEqual({ keyFamily: "banana", families: [{ name_norm: "bananas",
      ref_ids: [REF.c902, REF.c906, catRef(907)].sort() }], allowed: [REF.c902, REF.c906, catRef(907)].sort(),
    rulesVersion: 40, evidenceVersion: 500 });
    expect(marks()).toEqual([{ user_id: A, name_norm: "bananas", rev: 1, status: "eats", favor_rev: 1 }]);
  });
});

describe("marks the session client cannot see", () => {
  it("an existing eats mark at rev 100: 200, no write, and idempotent", async () => {
    tables.food_membership_revisions.push({ user_id: A, name_norm: "bananas", status: "eats", rev: 100 });
    const before = JSON.stringify(tables);
    for (let i = 0; i < 2; i += 1) {
      expect(await post("u:banana")).toEqual({ favored: true, refs: 1, skippedAvoid: 0, rulesRevision: 7 });
    }
    expect(JSON.stringify(tables)).toBe(before);
  });

  it("a second favor writes nothing", async () => {
    await post("u:chicken-breast-roasted");
    const after = JSON.stringify(tables);
    await post("u:chicken-breast-roasted");
    expect(JSON.stringify(tables)).toBe(after);
  });

  it("a hidden Avoid family mark: favorable false, 422, nothing written", async () => {
    tables.food_membership_revisions.push({ user_id: A, name_norm: "bananas", status: "avoid", rev: 3 });
    expect(await favorable("u:banana")).toBe(false);
    expect(await rejection("u:banana")).toEqual({ status: 422, code: "nothing_to_favor" });
    expect(favor.calls).toEqual([]);
  });

  it("an Avoid mark on the key's own family (no ref under that name) also stops it", async () => {
    tables.food_membership_revisions.push({ user_id: A, name_norm: "chicken breast", status: "avoid", rev: 2 });
    expect(await favorable("u:chicken-breast-roasted")).toBe(false);
    expect(await rejection("u:chicken-breast-roasted")).toEqual({ status: 422, code: "nothing_to_favor" });
  });

  it("another account's Avoid of the same family is not this account's", async () => {
    tables.food_membership_revisions.push({ user_id: B, name_norm: "bananas", status: "avoid", rev: 9 });
    const before = owned(B);
    expect(await post("u:banana")).toMatchObject({ favored: true });
    expect(owned(B)).toBe(before);
  });
});

describe("drift between the plan and the write", () => {
  it("a rule added after the judgement, before the write: 409 rules_changed, no eats write", async () => {
    const plan = favor.memberships;
    favor.memberships = async (userId, families) => {
      ports.profile = { ...ports.profile, avoid_allergens: ["milk"] };
      bumpClock(tables, A);
      return plan(userId, families);
    };
    const error = await post("f:greek yogurt").catch((e: { status: number; code: string; rulesVersion: number }) => e);
    expect(error).toMatchObject({ status: 409, code: "rules_changed", rulesVersion: 41 });
    expect(tables.user_food_prefs.some((row) => row.user_id === A && row.food_ref_id === REF.c903)).toBe(false);
    expect(marks()).toEqual([]);
  });

  it("a family write set that changed after the plan: 409 rules_changed, nothing written", async () => {
    const write = favor.write;
    favor.write = async (userId, request) => {
      addCreamyBananas();
      return write(userId, request);
    };
    expect(await rejection("u:banana")).toEqual({ status: 409, code: "rules_changed" });
    expect(marks()).toEqual([]);
    expect(clockOf(tables, A)).toBe(40);
  });

  it("waits for a pending rule review: 409, nothing written", async () => {
    ports.reviewRequired = async () => true;
    expect(await rejection("u:banana")).toEqual({ status: 409, code: "rule_review_required" });
    expect(favor.calls).toEqual([]);
  });
});

describe("unknown keys and other accounts", () => {
  it("answers 404 for a malformed key, one outside the taste answer, or an item with no ref", async () => {
    for (const key of ["banana", "u:not-a-food", "f:Greek Yogurt", "f:never eaten", "u:turkey-breast-roasted",
      "u:broccoli-cooked", 42]) {
      expect(await rejection(key), String(key)).toEqual({ status: 404, code: "unknown_key" });
    }
    expect(favor.calls).toEqual([]);
  });

  it("a rule-blocked food is not in the taste answer: 404", async () => {
    ports.profile = { ...ports.profile, avoid_allergens: ["milk"] };
    expect(await rejection("f:greek yogurt")).toEqual({ status: 404, code: "unknown_key" });
  });

  it("A cannot favor B's food, and B cannot favor A's, by a crafted key", async () => {
    const before = { a: owned(A), b: owned(B) };
    expect(await rejection("f:b secret stew", A)).toEqual({ status: 404, code: "unknown_key" });
    expect(await rejection("f:mom's dal", B)).toEqual({ status: 404, code: "unknown_key" });
    expect(owned(A)).toBe(before.a);
    expect(owned(B)).toBe(before.b);
    await post("u:chicken-breast-roasted", B);
    expect(favor.calls.every((call) => call.userId === B)).toBe(true);
    expect(owned(A)).toBe(before.a);
  });
});
