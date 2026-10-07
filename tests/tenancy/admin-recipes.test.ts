/** Privileged preview issuance must stay bound to the authenticated account. */
import "./local-only";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewRecipe } from "@/lib/server/recipe-plan";
import { seedPilotCatalog } from "@/lib/server/recipe-catalog-seed";
import { HAS_BRANCH, HAS_DB, adminClient, ensureUser, userClient, type TestUser }
  from "../helpers/supabase";
import { accountSnapshot, purge } from "./seed";

describe.skipIf(!HAS_BRANCH || !HAS_DB)("recipe plan admin canary", () => {
  let a: TestUser;
  let b: TestUser;
  let recipeId = "";

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await purge([a.id, b.id]);
    await seedPilotCatalog(adminClient());
    const recipe = await adminClient().from("recipe_catalog").select("id")
      .eq("slug", "lentil-carrot-tomato-stew").single();
    if (recipe.error || !recipe.data) throw recipe.error ?? new Error("recipe missing");
    recipeId = recipe.data.id;
    for (const [userId, kcal] of [[a.id, 2000], [b.id, 3131]] as const) {
      const target = await adminClient().from("target_profiles").insert({
        user_id: userId, effective_from: "2099-04-01", rev: 1,
        kcal_train: kcal, kcal_rest: kcal, authored_by: "user", mode: "grams",
        protein_g_min: 100, protein_g: 100, fat_g: 70, carb_g: 200,
        training_macros: { kcal, protein: 100, fat: 70, carbs: 200 },
        rest_macros: { kcal, protein: 100, fat: 70, carbs: 200 },
      });
      if (target.error) throw target.error;
    }
  });

  afterAll(async () => { if (a && b) await purge([a.id, b.id]); });

  it("issues A's preview from A's target and leaves B's canary rows unchanged", async () => {
    const asA = await userClient(a);
    const asB = await userClient(b);
    const input = { date: "2099-04-01", slotId: "meal-1" as const, servingFraction: 1 };
    const bPreview = await previewRecipe(asB, b.id, recipeId, input);
    expect(bPreview.authority.targetRevisionId).toBeTruthy();
    const bBefore = accountSnapshot(b.id);
    const aPreview = await previewRecipe(asA, a.id, recipeId, input);
    expect(aPreview.authority.targetRevisionId).not.toBe(bPreview.authority.targetRevisionId);
    expect(aPreview.mealTarget?.kcal).not.toBe(bPreview.mealTarget?.kcal);
    expect(accountSnapshot(b.id)).toEqual(bBefore);
    const aRow = await adminClient().from("recipe_plan_previews").select("user_id")
      .eq("id", aPreview.previewId).single();
    expect(aRow.data?.user_id).toBe(a.id);
  });
});
