import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resetTestAccount } from "@/tests/helpers/account";
import { starterFood } from "./starter";
import { uuidV5 } from "./uuid5";
import { repairLegacyWheyNutrition } from "./starter-nutrition-repair";

const namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("legacy whey nutrition repair", () => {
  it("updates only the attested empty row at its current revision", async () => {
    const account = await resetTestAccount();
    const food = starterFood("whey-protein-powder", "avoid");
    const row = { id: await uuidV5(namespace,
      `legacy-food:${account.userId}:${food.id}`), kind: "custom", name: food.name,
    brand: null, ingredients_text: null, allergen_tags: [], catalog_food_id: null,
    deleted_at: null, per_100g: {}, rev: 1 };
    const filters: unknown[][] = [];
    let updated: Record<string, unknown> = {};
    const query = {
      update: vi.fn((value: Record<string, unknown>) => { updated = value; return query; }),
      eq: vi.fn((...args: unknown[]) => { filters.push(args); return query; }),
      is: vi.fn((...args: unknown[]) => { filters.push(args); return query; }),
      select: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: { id: row.id, rev: 2 }, error: null })),
    };
    const client = { from: vi.fn(() => query) } as unknown as SupabaseClient;

    const result = await repairLegacyWheyNutrition(account, row, client);
    expect(result?.energy_kcal).toBeGreaterThan(0);
    expect(updated).toMatchObject({ rev: 2, per_100g: result });
    expect(filters).toContainEqual(["user_id", account.userId]);
    expect(filters).toContainEqual(["id", row.id]);
    expect(filters).toContainEqual(["rev", 1]);
    expect(filters).toContainEqual(["per_100g", "{}"]);
    expect(filters).toContainEqual(["allergen_tags", "{}"]);

    query.update.mockClear();
    expect(await repairLegacyWheyNutrition(account, { ...row, brand: "edited" }, client)).toBeNull();
    expect(query.update).not.toHaveBeenCalled();
  });
});
