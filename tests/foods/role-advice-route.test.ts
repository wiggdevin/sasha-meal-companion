import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/typesafe", () => ({ systemOne: vi.fn(async () => null) }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));

const { systemOne } = await import("@/lib/ai/typesafe");
const { requireUser } = await import("@/lib/server/auth");
const { POST } = await import("@/app/api/foods/role/advice/route");
const { MEAL_COMPONENT_ROLES } = await import("@/lib/coach/role-advice");
const { choiceAnswer, fakeClient } = await import("@/tests/helpers/role-advice-fakes");
type Row = Record<string, unknown>;

const NEW_FOOD = "11111111-1111-4111-8111-111111111111";
const SET_FOOD = "22222222-2222-4222-8222-222222222222";
const NOT_MEMBER = "33333333-3333-4333-8333-333333333333";

const TABLES = (): Record<string, Row[]> => ({
  user_food_prefs: [
    { user_id: "u1", food_ref_id: NEW_FOOD, status: "eats", role: null },
    { user_id: "u1", food_ref_id: SET_FOOD, status: "avoid", role: "carb" },
  ],
  food_refs: [
    { id: NEW_FOOD, catalog_food_id: 9, user_food_id: null, user_foods: null },
    { id: SET_FOOD, catalog_food_id: null, user_food_id: "uf", user_foods: {
      name: "Toast", per_100g: { protein: 9, carbohydrate: 49, fat_total: 3 } } },
    { id: NOT_MEMBER, catalog_food_id: 9, user_food_id: null, user_foods: null },
  ],
  catalog_food_revisions: [{ catalog_food_id: 9, is_active: true, description: "Chicken, breast",
    prep_state: "cooked", catalog_food_nutrients: [
      { nutrient_code: "protein", amount_per_100g: 31 },
      { nutrient_code: "carbohydrate", amount_per_100g: 0 },
      { nutrient_code: "fat_total", amount_per_100g: 3.6 }] }],
});

function post(body: unknown) {
  return POST(new Request("https://app.test/api/foods/role/advice", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  vi.mocked(requireUser).mockReset();
  vi.mocked(systemOne).mockReset();
});

describe("POST /api/foods/role/advice (Foods › add-food)", () => {
  it("advises a new member food with no stored role, and writes nothing", async () => {
    const db = fakeClient(TABLES());
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db.client });
    vi.mocked(systemOne).mockResolvedValue(choiceAnswer("protein_anchor") as never);

    const res = await post({ foodRefIds: [NEW_FOOD] });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [{ foodRefId: NEW_FOOD, roleAdvice: {
      foodRefId: NEW_FOOD, suggestedRole: "protein_anchor", proposedRole: "protein",
      currentRole: null, reason: MEAL_COMPONENT_ROLES.protein_anchor, confidence: 0.9,
      requiresConfirmation: true,
    } }] });
    const [payload, options] = vi.mocked(systemOne).mock.calls[0] as unknown as [
      { purpose: string; state: { food: { name: string } } }, { userId: string }];
    expect(payload.purpose).toBe("meal-component-role");
    expect(payload.state.food.name).toBe("Chicken, breast");
    expect(options.userId).toBe("u1");
    expect(db.writes).toEqual([]);
  });

  it("gives no advice when the role is already set or the food is not on a list", async () => {
    const db = fakeClient(TABLES());
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db.client });
    vi.mocked(systemOne).mockResolvedValue(choiceAnswer("protein_anchor") as never);

    const res = await post({ foodRefIds: [SET_FOOD, NOT_MEMBER] });

    await expect(res.json()).resolves.toEqual({
      items: [{ foodRefId: SET_FOOD }, { foodRefId: NOT_MEMBER }] });
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("answers 200 with no advice when a read fails or Jev is unavailable", async () => {
    const failing = fakeClient(TABLES(), { failTable: "food_refs" });
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: failing.client });
    const res = await post({ foodRefIds: [NEW_FOOD] });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [{ foodRefId: NEW_FOOD }] });

    const db = fakeClient(TABLES());
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db.client });
    vi.mocked(systemOne).mockImplementation(async () => { throw new Error("down"); });
    const down = await post({ foodRefIds: [NEW_FOOD] });
    expect(down.status).toBe(200);
    await expect(down.json()).resolves.toEqual({ items: [{ foodRefId: NEW_FOOD }] });
  });

  it("refuses a malformed or oversized request", async () => {
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: fakeClient({}).client });
    expect((await post({ foodRefIds: ["not-a-uuid"] })).status).toBe(400);
    expect((await post({ foodRefIds: Array.from({ length: 7 }, () => NEW_FOOD) })).status).toBe(400);
  });
});
