/**
 * Phase 13 §5, finding #11: `recordAllergenEvidence`'s `withEvidence` counter feeds the coverage
 * metric `lib/foods/facet-warm.ts` logs per warm. Scoped to an account's own avoided fixed-
 * vocabulary allergens (`avoidedFixed`), a food counts as covered only when EVERY one of them has
 * evidence — not "any of the ten fixed keys", which cannot reveal a false exclusion against an
 * account's own rules.
 */
import { describe, expect, it, vi } from "vitest";
import { recordAllergenEvidence } from "@/lib/server/allergen-evidence";

function writer() {
  const rows: unknown[] = [];
  const from = (_table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, in: () => chain, order: () => chain, range: () => chain,
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
      upsert: vi.fn(async (value: unknown) => { rows.push(...(value as unknown[])); return { error: null }; }),
    });
    return chain;
  };
  return { client: { from } as never, rows };
}

const DAIRY_ONLY = { foodKey: "k1", userId: null, ingredientsText: "Milk, sugar", labelComplete: false };
const DAIRY_AND_PEANUT =
  { foodKey: "k1", userId: null, ingredientsText: "Milk, peanuts, sugar", labelComplete: false };

describe("recordAllergenEvidence: coverage scoped to the account's own avoided allergens", () => {
  it("without a scope, counts any evidence for any fixed key as covered (the catalog-wide default)",
    async () => {
      const { client } = writer();
      const result = await recordAllergenEvidence(client, [DAIRY_ONLY]);
      expect(result.withEvidence).toBe(1);
    });

  it("scoped to the account's rules, a food is NOT covered when one of them has no evidence",
    async () => {
      const { client } = writer();
      // Dairy gets evidence; peanut, which this account also avoids, gets none — the exact false
      // exclusion the old "any fixed key" metric could not see.
      const result = await recordAllergenEvidence(client, [DAIRY_ONLY], ["dairy", "peanut"]);
      expect(result.withEvidence).toBe(0);
    });

  it("counts a food covered once every one of the account's avoided fixed allergens has evidence",
    async () => {
      const { client } = writer();
      const result = await recordAllergenEvidence(client, [DAIRY_AND_PEANUT], ["dairy", "peanut"]);
      expect(result.withEvidence).toBe(1);
    });

  it("an account avoiding nothing in the fixed vocabulary is vacuously covered", async () => {
    const { client } = writer();
    const result = await recordAllergenEvidence(client,
      [{ foodKey: "k1", userId: null, ingredientsText: null, labelComplete: false }], []);
    expect(result.withEvidence).toBe(1);
  });

  it("an account-defined allergen outside the fixed vocabulary never enters the scope (it has no " +
    "stored evidence key to check)", async () => {
    const { client } = writer();
    const result = await recordAllergenEvidence(client, [DAIRY_ONLY], ["dairy", "mustard"]);
    expect(result.withEvidence).toBe(1);
  });

  describe("round 10 finding #4: an account that avoids ONLY a custom allergen", () => {
    it("is not reported as covered — a bare 100% would be a false, unearned signal, since this " +
      "store can never hold evidence for an allergen outside the fixed vocabulary", async () => {
      const { client } = writer();
      const result = await recordAllergenEvidence(client, [DAIRY_ONLY], ["mustard"]);
      expect(result.withEvidence).toBe(0);
    });

    it("stays uncovered even when the food's own text happens to carry a fixed-vocabulary " +
      "allergen too — mustard itself is still never evidenced", async () => {
      const { client } = writer();
      const result = await recordAllergenEvidence(client, [DAIRY_AND_PEANUT], ["mustard"]);
      expect(result.withEvidence).toBe(0);
    });

    it("an account that genuinely avoids nothing at all (an empty list, not a custom-only one) " +
      "stays vacuously covered — this is not a general 'always uncovered when requireKeys is " +
      "empty' rule", async () => {
        const { client } = writer();
        const result = await recordAllergenEvidence(client, [DAIRY_ONLY], []);
        expect(result.withEvidence).toBe(1);
      });
  });

  describe("sol FIX (review round 1, finding #8): withEvidence must not survive a failed write", () => {
    it("reports withEvidence 0 when the upsert itself fails — the pre-write count was never " +
      "actually persisted, so a caller trusting it would log coverage for evidence that does " +
      "not exist in the store", async () => {
        const from = (_table: string) => {
          const chain: Record<string, unknown> = {};
          Object.assign(chain, {
            select: () => chain, in: () => chain, order: () => chain, range: () => chain,
            then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
              Promise.resolve({ data: [], error: null }).then(resolve),
            upsert: vi.fn(async () => ({ error: { message: "write failed" } })),
          });
          return chain;
        };
        const result = await recordAllergenEvidence({ from } as never, [DAIRY_ONLY]);
        expect(result).toEqual({ written: 0, errors: 1, withEvidence: 0 });
      });
  });
});
