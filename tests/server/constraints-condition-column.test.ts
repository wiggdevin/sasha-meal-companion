/**
 * Phase 18 W2b (Sol r1 BLOCK 5): code deployed before migration 20261213090000 still reads the
 * constraint profile. A missing `condition_review_required` column (Postgres 42703) is logged and
 * read as false; every other read error still fails.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getProfile, getRuleReviewStatus } from "@/lib/server/constraints";

const ROW = { rev: 3, conditions: ["Celiac"], notes: null, avoid_allergens: ["gluten"], avoid_food_ref_ids: [],
  banned_categories: [], custom_rules: [], rule_review_required: false, rule_reviewed_at: null };

function client(error: { code: string; message: string } | null, withColumn = false): { client: SupabaseClient; reads: string[] } {
  const reads: string[] = [];
  const from = () => ({ select: (columns: string) => {
    reads.push(columns);
    const missing = columns.includes("condition_review_required");
    const query = { eq: () => query, maybeSingle: async () => (missing && error ? { data: null, error }
      : { data: withColumn ? { ...ROW, condition_review_required: true } : ROW, error: null }) };
    return query;
  } });
  return { client: { from } as unknown as SupabaseClient, reads };
}

afterEach(() => vi.restoreAllMocks());

describe("getProfile before the food_world migration", () => {
  it("reads the marker as false when the column is missing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = client({ code: "42703", message: "column does not exist" });
    const read = await getProfile(fake.client, "a");
    expect(read).toMatchObject({ rev: 3, conditionReview: false, profile: { avoid_allergens: ["gluten"] } });
    expect(fake.reads).toHaveLength(2);
    expect(log).toHaveBeenCalledOnce();
    expect(await getRuleReviewStatus(fake.client, "a")).toEqual({ required: false, candidateAllergens: [],
      candidateCategories: [], rev: 3 });
  });

  it("reads the marker when the column exists", async () => {
    expect((await getProfile(client(null, true).client, "a")).conditionReview).toBe(true);
  });

  it("still fails on any other read error", async () => {
    await expect(getProfile(client({ code: "57014", message: "timeout" }).client, "a")).rejects.toThrow();
  });
});
