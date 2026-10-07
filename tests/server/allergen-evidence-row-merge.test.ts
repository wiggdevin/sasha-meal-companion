/**
 * sol FIX (review round 2): `readAllergenEvidence`'s row-by-row read (`fetchEvidenceRows`) used
 * to key its result by `allergenKey(row.allergen)` and OVERWRITE whichever entry was already
 * there — so two stored rows for the same food_key that `allergenKey` normalizes to the SAME
 * canonical key (e.g. a raw 'tree nut' row beside a canonical 'tree-nut' row — the exact
 * duplicate the 20261118090000_allergen_evidence.sql legacy backfill could write before this
 * round's migration fix) left the answer to whichever one an unordered select happened to return
 * last, not to the stronger of the two. Every other place two evidence values for the same
 * allergen meet (lib/policy/allergens.ts mergeEvidence) merges monotonically — listed wins over
 * not_listed wins over no_evidence — and the read of stored rows must never do worse than that.
 */
import { describe, expect, it } from "vitest";
import { readAllergenEvidence } from "@/lib/server/allergen-evidence";

const KEY = "catalog_revision:70";

function clientWithRows(rows: { food_key: string; allergen: string; level: string;
  label_complete: boolean }[]) {
  const from = () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, in: () => chain, order: () => chain, range: () => chain,
      then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    });
    return chain;
  };
  return { from } as never;
}

describe("readAllergenEvidence: two stored rows for the same food_key that normalize to the " +
  "same allergen key merge monotonically, regardless of which one a plain select returns last", () => {
  it("keeps 'listed' when the raw-spelling row is listed and arrives AFTER the no_evidence " +
    "canonical row", async () => {
    const client = clientWithRows([
      { food_key: KEY, allergen: "tree-nut", level: "no_evidence", label_complete: false },
      { food_key: KEY, allergen: "tree nut", level: "listed", label_complete: false },
    ]);
    const result = await readAllergenEvidence(client, [KEY]);
    expect(result.get(KEY)?.["tree-nut"]).toEqual({ level: "listed", labelComplete: false });
  });

  it("keeps 'listed' when the raw-spelling row is listed and arrives BEFORE the no_evidence " +
    "canonical row — order must not matter", async () => {
    const client = clientWithRows([
      { food_key: KEY, allergen: "tree nut", level: "listed", label_complete: false },
      { food_key: KEY, allergen: "tree-nut", level: "no_evidence", label_complete: false },
    ]);
    const result = await readAllergenEvidence(client, [KEY]);
    expect(result.get(KEY)?.["tree-nut"]).toEqual({ level: "listed", labelComplete: false });
  });

  it("keeps 'not_listed' over a 'no_evidence' duplicate, either order", async () => {
    const client = clientWithRows([
      { food_key: KEY, allergen: "crustacean shellfish", level: "not_listed", label_complete: true },
      { food_key: KEY, allergen: "crustacean", level: "no_evidence", label_complete: false },
    ]);
    const result = await readAllergenEvidence(client, [KEY]);
    expect(result.get(KEY)?.crustacean).toEqual({ level: "not_listed", labelComplete: true });
  });
});
