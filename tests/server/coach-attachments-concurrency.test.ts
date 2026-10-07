/**
 * sol FIX (review round 1, finding #1): `barcodeDraft`'s coach-attachment hot path used to await
 * `loadUserProfile` on its own before its Promise.all, even though only the cheap in-memory merge
 * (`mergeScannedAllergenFacts`) needs it — its two DB reads (readAllergenChecks,
 * readAllergenEvidence, via `readScannedAllergenSources`) do not. That turned two sequential DB
 * waves (the revision read, then everything else together) into three, raising p95 for every
 * coach-turn barcode attachment with no behavior gained.
 *
 * This proves the shape, not the timing: every read after the revision read — the barcode/ref/pref
 * lookups, the profile read and the allergen-evidence/check reads — must be ISSUED in the same
 * tick, before any of them has resolved. A regression back to a serial `await loadUserProfile`
 * would issue only the profile call in that window, failing this test.
 */
import { describe, expect, it } from "vitest";
import { barcodeDraft } from "@/lib/server/coach-attachments";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const REVISION = {
  id: 70, catalog_food_id: 7, description: "Chicken, breast, roasted", brand: null,
  category: "Poultry Products", policy_categories: [], quality_class: "analytical",
  quality_flags: [], catalog_versions: { version_label: "fdc-2026-09" },
  catalog_food_nutrients: [], catalog_portions: [],
  catalog_ingredients: [{ seq: 1, name: "chicken", allergen_tags: [], raw_text: "Chicken." }],
};

/** Every concurrent-wave table gets a chain that returns immediately (call order matters, not
 *  its own resolution): recording the call at `.from(table)` time, then resolving off a shared
 *  per-table deferred so the test controls exactly when each one settles. */
function makeClient(calls: string[], sources: Record<string, Deferred<unknown>>) {
  const from = (table: string) => {
    if (table === "catalog_food_revisions") {
      return { select: () => ({ eq: () => ({
        maybeSingle: async () => ({ data: REVISION, error: null }) }) }) };
    }
    calls.push(table);
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const method of ["select", "eq", "in", "limit", "order", "range"]) chain[method] = self;
    chain.maybeSingle = () => sources[table].promise;
    chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      sources[table].promise.then(onFulfilled, onRejected);
    return chain;
  };
  return { from } as never;
}

describe("barcodeDraft: the coach attachment hot path", () => {
  it("issues the barcode, ref, pref, profile and allergen-evidence/check reads in one wave, " +
    "never gating any of them behind profile resolving first", async () => {
    const calls: string[] = [];
    const tables = ["catalog_barcodes", "food_refs", "user_food_prefs", "constraint_profiles",
      "food_allergen_evidence", "user_allergen_checks"];
    const sources = Object.fromEntries(tables.map((t) => [t, deferred<unknown>()]));
    const client = makeClient(calls, sources);

    const pending = barcodeDraft(client, "u1",
      { kind: "barcode", gtin14: "00000000000000", revisionId: "70", foodRefId: "ref-1" } as never);

    // Give the revision read (already resolved) and the synchronous code after it room to run,
    // without ever resolving any of the six waved reads.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    for (const table of tables) {
      expect(calls, `${table} must be issued before any waved read resolves`).toContain(table);
    }

    // Now let everything resolve with data that clears every mismatch/error check, so the
    // function can complete and the test also proves the fix did not break the result.
    sources.catalog_barcodes.resolve({ data: { catalog_food_id: 7, source: "fdc_sr_legacy" }, error: null });
    sources.food_refs.resolve({ data: { id: "ref-1", catalog_food_id: 7 }, error: null });
    sources.user_food_prefs.resolve({ data: null, error: null });
    sources.constraint_profiles.resolve({ data: null, error: null });
    sources.food_allergen_evidence.resolve({ data: [], error: null });
    sources.user_allergen_checks.resolve({ data: [], error: null });

    const draft = await pending;
    expect(draft).toMatchObject({ status: "resolved", match: { foodRefId: "ref-1" } });
  });
});
