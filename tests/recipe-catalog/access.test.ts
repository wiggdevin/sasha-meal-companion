import { describe, expect, it } from "vitest";
import { recipeAccessEnabled } from "@/lib/server/recipe-access";

const USER = "11111111-1111-4111-8111-111111111111";
describe("recipe pilot account gate", () => {
  it("is closed in production without an explicit allowlist", () => {
    expect(recipeAccessEnabled(USER, { NODE_ENV: "production", SUPABASE_URL: "https://db.example",
      NEXT_PUBLIC_SUPABASE_URL: undefined, RECIPE_PLANNING_USER_IDS: undefined })).toBe(false);
  });
  it("opens only listed UUIDs or explicit wildcard", () => {
    const env = { NODE_ENV: "production", SUPABASE_URL: "https://db.example",
      NEXT_PUBLIC_SUPABASE_URL: undefined, RECIPE_PLANNING_USER_IDS: USER };
    expect(recipeAccessEnabled(USER, env)).toBe(true);
    expect(recipeAccessEnabled("22222222-2222-4222-8222-222222222222", env)).toBe(false);
    expect(recipeAccessEnabled(USER, { ...env, RECIPE_PLANNING_USER_IDS: "*" })).toBe(true);
  });
  it("opens the isolated local stack only outside production", () => {
    expect(recipeAccessEnabled(USER, { NODE_ENV: "development", SUPABASE_URL: "http://127.0.0.1:3105",
      NEXT_PUBLIC_SUPABASE_URL: undefined, RECIPE_PLANNING_USER_IDS: undefined })).toBe(true);
  });
});
