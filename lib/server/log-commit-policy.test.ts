/**
 * Phase 13 slice 2 follow-ups (GPT-6 Sol round 15, recorded at landing): the label commit's policy
 * check and the idempotent retry. Same fake client as lib/server/log.test.ts, no network.
 */
import { describe, expect, it, vi } from "vitest";
import { DRAFT_ID, ENTRY_ID, fakeClient, ITEM_ID, PER_100G, req, type Row } from "@/tests/helpers/log-fake-client";
import type { CommitResult } from "@/lib/log-commit-client";
import { outcomeFor } from "@/lib/log/outcome";
import { LABEL_FOOD_PLACEHOLDER_REF } from "./log-label-food";
import { RULES_UNREADABLE_MESSAGE } from "@/lib/coach/log-policy";
import { applyLogEntry } from "./log";

// No service-role client here, so loadSuggestionEvidence answers "unavailable" and the commit is
// judged on the base evidence it read itself — the path every test in this file pins. Since Phase
// 18 W2a (review r1 BLOCK 2) every non-blocked item judged that way also carries UNREAD: the
// stored evidence (a hold included) was never seen.
const UNREAD = { path: "items.0", message: RULES_UNREADABLE_MESSAGE };
vi.mock("@/lib/server/admin", () => ({
  adminClient: () => { throw new Error("no admin client in this test"); },
}));

const LABEL_ITEM = { id: ITEM_ID, seq: 0, food_ref_id: LABEL_FOOD_PLACEHOLDER_REF, qty: 1,
  unit: "whole", grams: 90 };

/** `stored` = the rows a first commit already wrote: its seq-0 item and the label food it saved. */
function labelDb(profile: Row, applied: unknown = { status: "applied", rev: 1 },
  stored: { tags: string[]; text: string; name?: string } | null = null) {
  return fakeClient({
    tables: {
      food_refs: [{ id: "ref-for-label", kind: "user", user_food_id: "user_foods-new" }],
      constraint_profiles: [{ user_id: "u1", avoid_food_ref_ids: [], banned_categories: [],
        custom_rules: [], ...profile }],
      log_entries: [{ id: ENTRY_ID, rev: 1 }],
      log_items: stored ? [{ ...LABEL_ITEM, entry_id: ENTRY_ID, food_ref_id: "ref-for-label" }] : [],
      user_foods: stored ? [{ id: "user_foods-new", name: stored.name ?? "Trail mix", kind: "label_scan",
        allergen_tags: stored.tags, ingredients_text: stored.text }] : [],
    },
    rpc: { apply_sync_op: applied, get_or_create_food_ref: "ref-for-label" },
  });
}

async function commitLabel(db: ReturnType<typeof labelDb>, label: Row) {
  const out = await applyLogEntry(db.client, "u1", req([{ ...LABEL_ITEM }],
    { method: "label", draft_id: DRAFT_ID, save_label_as_food: true }),
  { labelFood: { per100g: PER_100G, allergenTags: [], ...label } });
  expect(out).toMatchObject({ status: "ok" });
  return (out as { flagged?: { path: string; message: string }[] }).flagged;
}

/**
 * sol BLOCK (s2 round 3, deferred to t2b): the label commit judged the placeholder item on its
 * tags alone — never the label's verbatim ingredient text or its product name — so it could
 * neither clear a complete label the capture card cleared nor catch a product named tuna.
 */
describe("applyLogEntry — a label commit gets the capture card's strict completeness check", () => {
  it("leaves an incomplete ingredient list unverified for an avoided allergen", async () => {
    const flagged = await commitLabel(labelDb({ avoid_allergens: ["peanut"] }),
      { name: "Crackers", ingredientsText: "Water, sugar" });
    expect(flagged).toEqual([{ path: "items.0", message: "unverified:allergen:peanut" }, UNREAD]);
  });

  it("clears a complete verbatim ingredient list that names no avoided allergen", async () => {
    const flagged = await commitLabel(labelDb({ avoid_allergens: ["peanut"] }),
      { name: "Crackers", ingredientsText: "Water, sugar, salt." });
    // No peanut finding; only the unread-evidence mark.
    expect(flagged).toEqual([UNREAD]);
  });

  it("marks a product NAMED tuna unverified for a pregnancy profile", async () => {
    const flagged = await commitLabel(labelDb({ avoid_allergens: [], conditions: ["pregnant"] }),
      { name: "Canned tuna", ingredientsText: "Water, sugar, salt." });
    expect(flagged).toHaveLength(2);
    expect(flagged?.[0].message).toMatch(/^unverified:tuna_mercury:/);
    expect(flagged?.[1]).toEqual(UNREAD);
  });
});

/**
 * sol BLOCK (s2 round 3, deferred to t2b): a flagged commit whose response is lost is retried with
 * the same entry_id, apply_sync_op answers `duplicate`, and that branch used to answer a bare `ok`
 * — so lib/log/outcome.ts read the retry as unflagged and the allergen warning never reached them.
 */
describe("applyLogEntry — an idempotent retry keeps the allergen mark", () => {
  it("returns the same flagged entries on the duplicate branch, and the sheet says so", async () => {
    const label = { name: "Trail mix", ingredientsText: "peanuts, raisins, almonds" };
    const first = await commitLabel(labelDb({ avoid_allergens: ["peanut"] }), label);
    const retry = await commitLabel(labelDb({ avoid_allergens: ["peanut"] },
      { status: "duplicate" }, { tags: ["peanut"], text: label.ingredientsText }), label);
    expect(first).toEqual([{ path: "items.0", message: "blocked:allergen:peanut" }]);
    expect(retry).toEqual(first);
    const outcome = outcomeFor({ status: "ok", entry_id: ENTRY_ID, rev: 1, items: [],
      totals: {}, flagged: retry } as unknown as CommitResult);
    expect(outcome.message).toBe("Logged, and marked off-plan for your rules: peanut.");
  });

  it("judges the STORED row on a retry, never the retry body", async () => {
    const stored = { tags: ["peanut"], text: "peanuts, raisins, almonds" };
    const retry = await commitLabel(labelDb({ avoid_allergens: ["peanut"] },
      { status: "duplicate" }, stored), { name: "Crackers", ingredientsText: "Water, sugar, salt." });
    expect(retry).toEqual([{ path: "items.0", message: "blocked:allergen:peanut" }]);
  });

  /**
   * sol BLOCK (t2b review): the retry re-ran the policy with only the stored row's tags, never its
   * name or ingredient text, so a stored "Canned tuna" label with no tuna tag lost its §9 R1 mark
   * whenever the facet evidence was unavailable, and the retry answered an unflagged ok.
   */
  it("keeps the stored label's tuna mark when the facet evidence is unavailable", async () => {
    const label = { name: "Canned tuna", ingredientsText: "Water, salt." };
    const profile = { avoid_allergens: [], conditions: ["pregnant"] };
    const retry = await commitLabel(labelDb(profile, { status: "duplicate" },
      { tags: [], text: label.ingredientsText, name: label.name }), label);
    expect(retry).toHaveLength(2);
    expect(retry?.[0]).toMatchObject({ path: "items.0" });
    expect(retry?.[0].message).toMatch(/^unverified:tuna_mercury:/);
    expect(retry?.[1]).toEqual(UNREAD);
  });
});

/**
 * 2026-10-02 DeepSeek audit (F2, MED): a stored "label_scan" user food never reached `packaged`
 * (or `foodBrand`) into the commit's own policy check, so a previously scanned, unbranded product
 * with a plain-sounding name — the exact shape a blank-`brands` Open Food Facts label leaves
 * (lib/server/off-map.ts) — could log clean through lib/policy/whole-foods.ts's whole-food reading
 * of its name, instead of staying unverified like the search/detail/barcode lanes.
 */
describe("applyLogEntry — a stored label-scan food never gets whole-food clearance (F2)", () => {
  const REF = "30000000-0000-4000-8000-0000000000aa";

  it("stays unverified for an avoided allergen even with a plain-sounding name and no brand", async () => {
    const db = fakeClient({
      tables: {
        food_refs: [{ id: REF, kind: "user", user_food_id: "user_foods-new" }],
        constraint_profiles: [{ user_id: "u1", avoid_allergens: ["dairy"],
          avoid_food_ref_ids: [], banned_categories: [], custom_rules: [] }],
        log_entries: [{ id: ENTRY_ID, rev: 1 }],
        user_foods: [{ id: "user_foods-new", name: "Chicken breast", brand: null,
          kind: "label_scan", allergen_tags: [], ingredients_text: null }],
      },
      rpc: { apply_sync_op: { status: "applied", rev: 1 } },
    });
    const item = { id: ITEM_ID, seq: 0, food_ref_id: REF, qty: 1, unit: "whole", grams: 90 };
    const out = await applyLogEntry(db.client, "u1", req([item]));
    expect(out).toMatchObject({ status: "ok" });
    expect((out as { flagged?: { path: string; message: string }[] }).flagged)
      .toEqual([{ path: "items.0", message: "unverified:allergen:dairy" }, UNREAD]);
  });
});
