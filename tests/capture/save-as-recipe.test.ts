/**
 * W125: "Save as recipe" keeps the meal just logged as a one-serving recipe, from the server's own
 * stored items when it answered, and never with a food its rules did not clear (R6).
 */
import { describe, expect, it } from "vitest";
import { applyEdits, keptItems } from "@/lib/capture-client";
import { captureRecipe, recipeName } from "@/lib/capture/save-as-recipe";
import type { DraftItem } from "@/lib/capture/types";
import type { CommitResult } from "@/lib/log-commit-client";

function item(seq: number, label: string, foodRefId: string | null,
  verdict: "allowed" | "blocked" | "unverified" = "allowed"): DraftItem {
  return { seq, label, foodRefId, catalogFoodRevisionId: foodRefId ? 100 + seq : null, grams: 50 * seq,
    qty: 1, unit: "whole", portionId: null, confidence: 0.9, policy: { verdict }, alternatives: [],
    autoResolved: true };
}

const ITEMS = [item(1, "Chicken", "ref-chicken"), item(2, "Rice", "ref-rice"), item(3, "Broccoli", "ref-broc")];

function ok(rows: { seq: number; ref: string; grams: number; rev: number | null }[]): CommitResult {
  return { status: "ok", entry_id: "e", rev: 1, totals: { local_date: "2026-10-17", nutrients: [],
    micro_coverage_pct: 0 },
  items: rows.map((r) => ({ id: `i${r.seq}`, entry_id: "e", seq: r.seq, food_ref_id: r.ref, qty: r.grams,
    unit: "g", grams: r.grams, portion_id: null, food_revision_id: r.rev, was_edited: false,
    confidence: null, snapshot: {} })) } as unknown as CommitResult;
}

describe("captureRecipe", () => {
  it("builds one serving from the server's stored refs, revisions and grams", () => {
    const kept = keptItems(applyEdits(ITEMS, {}));
    const result = ok([{ seq: 1, ref: "ref-chicken", grams: 50, rev: 101 },
      { seq: 2, ref: "ref-rice", grams: 100, rev: 102 }, { seq: 3, ref: "ref-broc", grams: 150, rev: 103 }]);
    const { input, left } = captureRecipe(kept, result, { title: "  Sunday bowl ", labelSeq: null });
    expect(left).toEqual([]);
    expect(input).toEqual({ name: "Sunday bowl", servings: 1, items: [
      { seq: 1, foodRefId: "ref-chicken", qty: 50, unit: "g", grams: 50, state: "raw", foodRevisionId: 101 },
      { seq: 2, foodRefId: "ref-rice", qty: 100, unit: "g", grams: 100, state: "raw", foodRevisionId: 102 },
      { seq: 3, foodRefId: "ref-broc", qty: 150, unit: "g", grams: 150, state: "raw", foodRevisionId: 103 },
    ] });
  });

  it("uses the label food's minted ref from the answer, and leaves it out of a queued save", () => {
    const label = [item(1, "Seeded crackers", null)];
    const kept = keptItems(applyEdits(label, {}));
    const answered = captureRecipe(kept, ok([{ seq: 1, ref: "ref-minted", grams: 50, rev: null }]),
      { labelSeq: 1 });
    expect(answered.input?.items[0]).toMatchObject({ foodRefId: "ref-minted", foodRevisionId: null });
    const queued = captureRecipe(kept, { status: "queued" }, { labelSeq: 1 });
    expect(queued).toEqual({ input: null, left: ["Seeded crackers"] });
  });

  it("leaves out a food its rules did not clear, and names it (R6)", () => {
    const kept = keptItems(applyEdits([item(1, "Chicken", "ref-chicken"),
      item(2, "Peanut sauce", "ref-peanut", "blocked"), item(3, "Mystery", "ref-x", "unverified")], {}));
    const { input, left } = captureRecipe(kept, { status: "queued" }, { labelSeq: null });
    expect(input?.items.map((i) => i.foodRefId)).toEqual(["ref-chicken"]);
    expect(left).toEqual(["Peanut sauce", "Mystery"]);
  });

  it("names an untitled recipe from its foods", () => {
    const kept = keptItems(applyEdits(ITEMS, {}));
    expect(recipeName(undefined, kept)).toBe("Chicken, Rice and Broccoli");
    expect(recipeName("", kept.slice(0, 1))).toBe("Chicken");
  });
});
