/**
 * Phase 18 W2b, acceptance 6: a closed account's v1 and v2 `GET /api/foods/eligible` bodies are
 * byte-identical to `main`; W8 acceptance 1: its `?v=3` body is that same v2 body. The golden files under ./fixtures were written by this test on
 * origin/main at 1ffe893, before any W2b code existed (`UPDATE_GOLDEN=1`), and are compared as
 * raw response text here. The account is closed, has a stored condition that was never
 * confirmed, an Avoid mark, a diet flag and Eats that evidence clears or excludes: every input the
 * W2b gate reads, none of which may change a closed account's answer.
 *
 * Only I/O is faked: the request identity, the rate limiter, the evidence cache (admin reads) and
 * the database (an in-memory PostgREST double). The route, eligibility, rule review, policy
 * profile and snapshot code all run for real.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeDb, type Row } from "@/tests/helpers/occasion-fake-db";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const db = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: async () => undefined }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: async () => ({ userId: A, client: db.client }),
}));
vi.mock("@/lib/coach/suggest-policy", async (original) => ({
  ...(await original<typeof import("@/lib/coach/suggest-policy")>()),
  loadSuggestionEvidence: async () => ({ status: "ready", preferenceFlags: [], byIdentity: {
    "ref:ref-eggs": facts([]), "ref:ref-toast": facts(["peanut"]), "ref:ref-banana": facts([]),
    "ref:cat-501": facts([]),
  } }),
}));

function facts(tags: string[]) {
  const clear = tags.includes("peanut") ? {} : { peanut: { level: "not_listed", labelComplete: true } };
  return { allergenTags: tags, allergenEvidence: clear, checkedAllergens: [], ingredientsText: null, policyCategories: [],
    facets: { human_food: { p: 1, rubricVersion: 1, judgedAt: "2026-10-01" } }, noCook: null, onEatsList: true, onAvoidList: false, role: "protein" };
}

const own = (id: string, name: string, per100: [number, number, number], catalog: number | null = null) => ({
  id, user_id: A, name, catalog_food_id: catalog,
  per_100g: { protein: per100[0], carbohydrate: per100[1], fat_total: per100[2] },
});
const FOODS = [own("eggs", "Eggs, whole, cooked", [12.6, 0.7, 9.5]),
  own("toast", "Toast, whole wheat", [13, 43, 4.5]), own("banana", "Banana", [1.1, 23, 0.3])];

function tables(): Record<string, Row[]> {
  return {
    constraint_profiles: [{ user_id: A, rev: 4, conditions: ["celiac"], notes: null,
      avoid_allergens: ["peanut"], avoid_food_ref_ids: [], banned_categories: [], custom_rules: [],
      rule_review_required: false, rule_reviewed_at: null, condition_review_required: false }],
    user_dietary_profiles: [],
    user_settings: [{ user_id: A, slot_times: {}, shift_minutes: 0, meals_per_day: 3, time_zone: "UTC",
      diet_prefs: { flags: ["vegetarian"] }, changed_at: "2026-10-01T00:00:00.000Z", food_world: "closed" }],
    user_food_prefs: [
      ...FOODS.map((food) => ({ user_id: A, food_ref_id: `ref-${food.id}`, status: "eats", role: null })),
      { user_id: A, food_ref_id: "cat-501", status: "eats", role: null },
      { user_id: A, food_ref_id: "ref-avoided", status: "avoid", role: null },
    ],
    food_refs: [...FOODS.map((food) => ({ id: `ref-${food.id}`, kind: "user", catalog_food_id: null,
      user_food_id: food.id, user_foods: food })),
    { id: "cat-501", kind: "catalog", catalog_food_id: 501, user_food_id: null, user_foods: null }],
    catalog_food_revisions: [{ id: 9001, catalog_food_id: 501, description: "Tuna, canned in water",
      is_active: true, catalog_food_nutrients: [{ nutrient_code: "protein", amount_per_100g: 25 }] }],
    target_profiles: [], log_entries: [], log_items: [],
  };
}

const FIXTURES = path.join(process.cwd(), "tests/foods/fixtures");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

async function body(version: string | null): Promise<string> {
  db.client = fakeDb(tables()).client;
  const { GET } = await import("@/app/api/foods/eligible/route");
  const url = `https://app.test/api/foods/eligible${version ? `?v=${version}` : ""}`;
  const res = await GET(new Request(url));
  expect(res.status).toBe(200);
  return res.text();
}

function golden(name: string, text: string): void {
  const file = path.join(FIXTURES, name);
  if (UPDATE) writeFileSync(file, text);
  expect(existsSync(file)).toBe(true);
  expect(text).toBe(readFileSync(file, "utf8"));
}

describe("a closed account's eligible bodies are byte-identical to main (W2b acceptance 6)", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-05T15:00:00Z")); });
  afterAll(() => { vi.useRealTimers(); });

  it("v1", async () => {
    golden("closed-world-eligible-v1.json", await body(null));
  });

  it("v2", async () => {
    golden("closed-world-eligible-v2.json", await body("2"));
  });

  // Phase 18 W8: the phone asks `?v=3`; a closed account's answer is main's v2 body, byte for byte.
  it("v3 for a closed account is main's v2 body", async () => {
    expect(UPDATE).toBe(false);
    golden("closed-world-eligible-v2.json", await body("3"));
  });
});
