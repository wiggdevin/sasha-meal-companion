import { beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.hoisted(() => ({
  getRow: vi.fn(async (): Promise<Record<string, unknown> | undefined> => ({
    food_ref_id: "3f1b1a2c-0000-4000-8000-0000000000f1",
    status: "eats", role: null, no_cook: true, note: "works well", rev: 4,
  })),
  enqueueWithRow: vi.fn(async () => ({})),
  currentPrefStatus: vi.fn(async () => null),
  setFoodMembership: vi.fn(async () => null),
  reserveFoodMembershipIntent: vi.fn(() => ({})),
  isLatestFoodMembershipIntent: vi.fn(() => true),
}));

vi.mock("@/lib/sync/idb", () => ({
  getRow: sync.getRow, closeAllAccountDbs: async () => undefined,
}));
vi.mock("@/lib/sync/outbox", () => ({ enqueueWithRow: sync.enqueueWithRow }));
vi.mock("@/lib/foods/prefs-client", () => ({
  currentPrefStatus: sync.currentPrefStatus,
  setFoodMembership: sync.setFoodMembership,
  reserveFoodMembershipIntent: sync.reserveFoodMembershipIntent,
  isLatestFoodMembershipIntent: sync.isLatestFoodMembershipIntent,
}));
vi.mock("@/lib/store", () => ({
  getFoods: () => ({}), setFoodNote: vi.fn(), setFoodStatus: vi.fn(),
}));

import { groundedCoachActionSchema } from "@/lib/coach/actions";
import { applyFoodListMark } from "@/lib/coach/apply-prefs";
import {
  confirmMealComponentRole, type MealComponentRoleAdvice,
} from "@/lib/coach/role-advice";
import { resetTestAccount } from "@/tests/helpers/account";
import { AccountChanged, bindAccount, type AccountHandle } from "@/lib/device/account";

const ADVICE: MealComponentRoleAdvice = {
  foodRefId: "3f1b1a2c-0000-4000-8000-0000000000f1",
  suggestedRole: "fat_source",
  proposedRole: "fat",
  currentRole: null,
  reason: "The food is chiefly the meal's fat source.",
  confidence: 0.93,
  requiresConfirmation: true,
};

let h: AccountHandle;

beforeEach(async () => {
  vi.clearAllMocks();
  h = await resetTestAccount();
  sync.getRow.mockResolvedValue({
    food_ref_id: ADVICE.foodRefId,
    status: "eats", role: null, no_cook: true, note: "works well", rev: 4,
  });
  sync.currentPrefStatus.mockResolvedValue(null);
  sync.setFoodMembership.mockResolvedValue(null);
});

describe("meal-component role confirmation", () => {
  it("does not persist before the user explicitly confirms", async () => {
    const persistRole = vi.fn(async () => {});

    const result = await confirmMealComponentRole(ADVICE, {
      confirmed: false,
      currentRole: async () => null,
      persistRole,
    });

    expect(result).toEqual({ status: "awaiting_confirmation" });
    expect(persistRole).not.toHaveBeenCalled();
  });

  it("does not persist confirm-required advice through the automatic helper", async () => {
    const persistRole = vi.fn(async () => {});
    const result = await confirmMealComponentRole(ADVICE, {
      confirmed: true, currentRole: async () => null, persistRole,
    });
    expect(result).toEqual({ status: "awaiting_confirmation" });
    expect(persistRole).not.toHaveBeenCalled();
  });

  it("persists an automatic stored role only after confirmation", async () => {
    const persistRole = vi.fn(async () => {});

    const result = await confirmMealComponentRole({ ...ADVICE, requiresConfirmation: false }, {
      confirmed: true,
      currentRole: async () => null,
      persistRole,
    });

    expect(result).toEqual({ status: "persisted", role: "fat" });
    expect(persistRole).toHaveBeenCalledOnce();
    expect(persistRole).toHaveBeenCalledWith(ADVICE.foodRefId, "fat");
  });

  it("never overwrites a stored role, even after confirmation", async () => {
    const persistRole = vi.fn(async () => {});

    const result = await confirmMealComponentRole({ ...ADVICE, requiresConfirmation: false }, {
      confirmed: true,
      currentRole: async () => "protein",
      persistRole,
    });

    expect(result).toEqual({ status: "unchanged", role: "protein" });
    expect(persistRole).not.toHaveBeenCalled();
  });

  it("does not claim a non-storable advisory category was persisted", async () => {
    const persistRole = vi.fn(async () => {});

    const result = await confirmMealComponentRole(
      { ...ADVICE, suggestedRole: "mixed_dish", requiresConfirmation: false },
      { confirmed: true, currentRole: async () => null, persistRole },
    );

    expect(result).toEqual({ status: "not_storable" });
    expect(persistRole).not.toHaveBeenCalled();
  });

  it("uses the existing user-food preference outbox after confirmation", async () => {
    const result = await confirmMealComponentRole(
      { ...ADVICE, requiresConfirmation: false }, { confirmed: true },
    );

    expect(result).toEqual({ status: "persisted", role: "fat" });
    expect(sync.enqueueWithRow).toHaveBeenCalledOnce();
    const [, row, op] = sync.enqueueWithRow.mock.calls[0] as unknown as [
      unknown, Record<string, unknown>, Record<string, unknown>,
    ];
    expect(row).toMatchObject({ status: "eats", role: "fat", no_cook: true,
      note: "works well", rev: 5 });
    expect(op).toMatchObject({ entity: "user_food_prefs", entity_id: ADVICE.foodRefId,
      kind: "update", base_rev: 4 });
    // Audit 2026-10-10 P15 (W029): a field delta, never the mirror's status, note or no_cook.
    expect(op.payload).toEqual({ role: "fat" });
  });

  // PR #248 review r4 #1 sweep: the role write reads the bound account, so it waits for no switch.
  it("writes no role for B when the account changes during the automatic role-row read", async () => {
    const proposed = groundedCoachActionSchema.parse({
      kind: "add_to_eats", actionId: "turn-switch", flagged: [],
      name: "Tahini", foodRefId: ADVICE.foodRefId, catalogFoodRevisionId: 7,
      kcalPer100g: 595, proteinPer100g: 17, carbsPer100g: 21, fatPer100g: 54,
      verdict: "allowed", roleAdvice: { ...ADVICE, requiresConfirmation: false },
    });
    if (proposed.kind !== "add_to_eats") throw new Error("expected an Eats action");
    sync.getRow.mockImplementationOnce(async () => {
      bindAccount("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      return { food_ref_id: ADVICE.foodRefId, status: "eats", role: null, rev: 4 };
    });
    await expect(applyFoodListMark(proposed)).rejects.toBeInstanceOf(AccountChanged);
    expect(sync.enqueueWithRow).not.toHaveBeenCalled();
  });

  it("does not save a confirm-required role when the Eats action is applied", async () => {
    const proposed = groundedCoachActionSchema.parse({
      kind: "add_to_eats", actionId: "turn-action", flagged: [],
      name: "Tahini", foodRefId: ADVICE.foodRefId, catalogFoodRevisionId: 7,
      kcalPer100g: 595, proteinPer100g: 17, carbsPer100g: 21, fatPer100g: 54,
      verdict: "allowed", roleAdvice: ADVICE,
    });
    if (proposed.kind !== "add_to_eats") throw new Error("expected an Eats action");

    // Returning the action from the coach turn is advisory and writes nothing.
    expect(sync.enqueueWithRow).not.toHaveBeenCalled();

    await applyFoodListMark(proposed);

    expect(sync.setFoodMembership).toHaveBeenCalledWith(
      "Tahini", "eats", expect.objectContaining({ note: null, account: h }),
    );
    expect(sync.enqueueWithRow).not.toHaveBeenCalled();
  });

  it("keeps the existing role write for advice that needs no separate confirmation", async () => {
    const proposed = groundedCoachActionSchema.parse({
      kind: "add_to_eats", actionId: "automatic-role", flagged: [],
      name: "Tahini", foodRefId: ADVICE.foodRefId, catalogFoodRevisionId: 7,
      kcalPer100g: 595, proteinPer100g: 17, carbsPer100g: 21, fatPer100g: 54,
      verdict: "allowed", roleAdvice: { ...ADVICE, requiresConfirmation: false },
    });
    if (proposed.kind !== "add_to_eats") throw new Error("expected an Eats action");

    await applyFoodListMark(proposed);

    expect(sync.enqueueWithRow).toHaveBeenCalledOnce();
    const [, , op] = sync.enqueueWithRow.mock.calls[0] as unknown as [
      unknown, Record<string, unknown>, Record<string, unknown>,
    ];
    expect(op).toMatchObject({
      entity: "user_food_prefs", entity_id: ADVICE.foodRefId, kind: "update", base_rev: 4,
    });
  });

  it("keeps a first-time Eats mark when its ref row is not readable yet", async () => {
    sync.getRow.mockResolvedValue(undefined);
    const proposed = groundedCoachActionSchema.parse({
      kind: "add_to_eats", actionId: "first-mark", flagged: [],
      name: "Tahini", foodRefId: ADVICE.foodRefId, catalogFoodRevisionId: 7,
      kcalPer100g: 595, proteinPer100g: 17, carbsPer100g: 21, fatPer100g: 54,
      verdict: "allowed", roleAdvice: ADVICE,
    });
    if (proposed.kind !== "add_to_eats") throw new Error("expected an Eats action");

    const result = await applyFoodListMark(proposed);

    expect(result).toMatchObject({ status: "applied" });
    expect(sync.setFoodMembership).toHaveBeenCalledWith(
      "Tahini", "eats", expect.objectContaining({ note: null, account: h }),
    );
    expect(sync.enqueueWithRow).not.toHaveBeenCalled();
  });
});
