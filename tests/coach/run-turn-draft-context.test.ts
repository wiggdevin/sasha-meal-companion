import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTurn } from "@/tests/coach/fixtures/run-turn";
import type { LogDraftBlockV1 } from "@/lib/coach/ui-blocks";

const THREAD = "3f1b1a2c-0000-4000-8000-000000000020";

/**
 * A client double that actually filters, unlike tests/coach/run-turn.test.ts's `db()` (which
 * returns a whole table for every read and is only safe with one row per table). This thread has
 * two prior rows plus the new turn's own messageId, and `storedTurn`'s idempotent-replay read
 * needs to tell them apart by id, or it mistakes an earlier row for this turn's own stored reply.
 */
function db(tables: Record<string, Record<string, unknown>[]>) {
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    let limit = 1000;
    let descending = false;
    let minSeq = -Infinity;
    let maxSeq = Infinity;
    const result = () => {
      let data = (tables[table] ?? []).filter((row) => Object.entries(filters)
        .every(([field, value]) => row[field] === value
          || (field === "deleted_at" && value === null && row[field] === undefined)))
        .filter((row) => typeof row.seq !== "number" || (row.seq >= minSeq && row.seq <= maxSeq));
      if (descending) data = [...data].reverse();
      return { data: data.slice(0, limit), error: null };
    };
    const chain = {
      select: () => chain,
      eq: (field: string, value: unknown) => { filters[field] = value; return chain; },
      is: (field: string, value: unknown) => { filters[field] = value; return chain; },
      gte: (_field: string, value: number) => { minSeq = value; return chain; },
      lte: (_field: string, value: number) => { maxSeq = value; return chain; },
      order: (_field: string, opts: { ascending: boolean }) => {
        descending = !opts.ascending; return chain;
      },
      limit: (n: number) => { limit = n; return chain; },
      maybeSingle: async () => ({ data: result().data[0] ?? null, error: null }),
      insert: (row: Record<string, unknown>) => { (tables[table] ??= []).push(row); return chain; },
      update: () => chain,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
    };
    return chain;
  };
  return { from, rpc: async () => ({ data: [], error: null }) } as never;
}

const ports = {
  dayTotals: async () => ({ local_date: "2026-09-20", nutrients: [] }),
  weekTotals: async () => [],
  activeTargets: async () => ({ kcal_train: 2200, protein_g: 135 }),
  latestEstimate: async () => ({ status: "burn_in", tdeeKcal: null }),
  searchFoods: async () => [{ foodRefId: "3f1b1a2c-0000-4000-8000-00000000001a", name: "bison patty",
    brand: null, kcalPer100g: 200, prefStatus: "eats" as const }],
  getConstraints: async () => ({ avoid_allergens: [] }),
  recentGut: async () => [],
  newDraftId: () => "draft-1",
};

/** Evidence 2026-09-20: a photo attachment's log_draft, still pending when the next turn arrives. */
const photoDraft = (): LogDraftBlockV1 => ({
  kind: "log_draft", v: 1, id: "draft-1", source: "capture", method: "photo",
  localDate: "2026-09-20", slot: "coffee",
  draft: {
    draftId: "draft-1", method: "photo",
    items: [
      { seq: 0, label: "Toast with butter and jam", foodRefId: null, catalogFoodRevisionId: null,
        grams: 60, qty: 60, unit: "g", portionId: null, confidence: 0.8,
        policy: { verdict: "unverified" }, alternatives: [], autoResolved: true },
      { seq: 1, label: "Scrambled eggs", foodRefId: null, catalogFoodRevisionId: null,
        grams: 120, qty: 120, unit: "g", portionId: null, confidence: 0.8,
        policy: { verdict: "unverified" }, alternatives: [], autoResolved: true },
      { seq: 2, label: "Sausage patty", foodRefId: null, catalogFoodRevisionId: null,
        grams: 85, qty: 85, unit: "g", portionId: null, confidence: 0.8,
        policy: { verdict: "unverified" }, alternatives: [], autoResolved: true },
      { seq: 3, label: "Sauteed mushrooms", foodRefId: null, catalogFoodRevisionId: null,
        grams: 50, qty: 50, unit: "g", portionId: null, confidence: 0.8,
        policy: { verdict: "unverified" }, alternatives: [], autoResolved: true },
    ],
    notes: [], spend: { usedToday: 0, softCap: 10 },
  },
  policy: { blocked: false }, status: "pending",
});

describe("the model turn sees a still-open photo draft (evidence 2026-09-20)", () => {
  beforeEach(() => {
    vi.stubEnv("COACH_ENABLED", "1");
    vi.stubEnv("TYPESAFE_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends the draft's own items in the transcript, not just the prior reply's prose", async () => {
    const tables = {
      coach_threads: [{ id: THREAD, user_id: "u1", title: "Breakfast", kind: "chat",
        deleted_at: null }],
      coach_messages: [
        { id: "m1", thread_id: THREAD, user_id: "u1", role: "user", content: "Sent a photo",
          seq: 1, tool_calls: { attachments: [{ kind: "capture", method: "photo" }] } },
        { id: "m2", thread_id: THREAD, user_id: "u1", role: "assistant",
          content: "Here's what I found — check the portion and log it.", seq: 2,
          tool_calls: { blocks: [photoDraft()] } },
      ],
    };
    // "ok", not a claim of a logged meal: this test is about the PROMPT the model is sent, not
    // the claim-without-action retry guard (lib/server/coach-turn/final-step.ts).
    const generate = vi.fn().mockResolvedValueOnce({ kind: "final", text: "ok" });
    await runTurn(db(tables), db(tables), "u1", {
      threadId: THREAD, messageId: "3f1b1a2c-0000-4000-8000-000000000021",
      text: "it was actually bison patty not sausage, all the rest was correct, please log it",
    }, { generate: generate as never, ports, now: () => 0, newId: () => "id-1" });

    expect(generate).toHaveBeenCalledTimes(1);
    const promptText = (generate.mock.calls[0][0] as { payload: { parts: { text: string }[] } })
      .payload.parts[0].text;
    expect(promptText).toContain("PENDING DRAFT");
    expect(promptText).toContain("Toast with butter and jam, 60 g");
    expect(promptText).toContain("Scrambled eggs, 120 g");
    expect(promptText).toContain("Sausage patty, 85 g");
    expect(promptText).toContain("Sauteed mushrooms, 50 g");
    expect(promptText).toContain("coffee");
  });
});
