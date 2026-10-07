/**
 * C8 (AI-integration audit 2026-10-04, P2 #16): every surface that carries model-produced content
 * says so. A saved coach row's provenance is derived when it is read, from facts the row holds —
 * the stamp the turn wrote into tool_calls, else model_id / ai_call_id / deflected — never guessed.
 */
import { describe, expect, it } from "vitest";
import type { ComposedMeal } from "@/lib/coach/compose";
import { cardProvenance, messageProvenance, toMessageView } from "@/lib/coach/message-view";
import { uiBlockSchema } from "@/lib/coach/ui-blocks";
import { BY_APP, parseProvenance } from "@/lib/provenance";

const MODEL = { ai: true, source: "model" } as const;
const APP = { ai: false, source: "app" } as const;
const JEV_INTENT = { ai: true, source: "jev", purpose: "coach-intent" } as const;

const row = (fields: Record<string, unknown>) => ({
  id: "m1", role: "assistant" as const, content: "Reply", seq: 2, tool_calls: {}, ...fields,
});

const card: ComposedMeal = {
  wish: "Option", slot: null, items: [],
  totals: { kcal: 300, protein: 20, carbs: 30, fat: 9 },
  target: { kcal: 300, protein: 20, carbs: 30, fat: 9 },
  flagged: [], fitsTarget: true,
};

describe("the provenance shape", () => {
  it("accepts the three forms and refuses a mixed or invented one", () => {
    expect(parseProvenance({ ai: true, source: "model", purpose: "coach" })).not.toBeNull();
    expect(parseProvenance({ ai: true, source: "jev" })).not.toBeNull();
    expect(parseProvenance(BY_APP)).toEqual(APP);
    expect(parseProvenance({ ai: false, source: "model" })).toBeNull();
    expect(parseProvenance({ ai: true, source: "app" })).toBeNull();
    expect(parseProvenance({ ai: true, source: "human" })).toBeNull();
    expect(parseProvenance(null)).toBeNull();
  });
});

describe("a saved coach row's provenance", () => {
  it("uses the stamp the turn saved, which beats the columns", () => {
    expect(messageProvenance(row({ tool_calls: { provenance: JEV_INTENT } }))).toEqual(JEV_INTENT);
    expect(messageProvenance(row({ tool_calls: { provenance: APP }, model_id: "m" }))).toEqual(APP);
  });

  it("reads a model reply from its model_id or its ai_call_id", () => {
    expect(messageProvenance(row({ model_id: "gemini-x", ai_call_id: null }))).toEqual(MODEL);
    expect(messageProvenance(row({ model_id: null, ai_call_id: "call-1" }))).toEqual(MODEL);
  });

  it("reads a deflection and the weekly fallback (empty model_id) as the app's", () => {
    expect(messageProvenance(row({ deflected: true, model_id: null }))).toEqual(APP);
    expect(messageProvenance(row({ tool_calls: [], model_id: "", ai_call_id: null }))).toEqual(APP);
  });

  it("reads a legacy Jev fast path, but not a legacy suggestion fast path it cannot tell apart", () => {
    expect(messageProvenance(row({ model_id: null,
      tool_calls: { fastPath: true, intent: "shift_schedule", actions: [] } }))).toEqual(JEV_INTENT);
    // A Plan sheet's structured request (no Jev) and a Jev suggestion both saved this shape.
    expect(messageProvenance(row({ model_id: null,
      tool_calls: { fastPath: true, intent: "suggest_options" } }))).toBeUndefined();
  });

  it("reads a legacy attachment row from its draft: capture is a model read, a barcode is not", () => {
    expect(messageProvenance(row({ model_id: null,
      tool_calls: { blocks: [{ kind: "log_draft", source: "capture" }] } }))).toEqual(MODEL);
    expect(messageProvenance(row({ model_id: null,
      tool_calls: { blocks: [{ kind: "log_draft", source: "barcode" }] } }))).toEqual(APP);
  });

  it("gives no provenance to a user row or a row that cannot tell", () => {
    expect(messageProvenance(row({ role: "user", model_id: "m" }))).toBeUndefined();
    expect(messageProvenance(row({ model_id: null, tool_calls: { historySources: [] } })))
      .toBeUndefined();
    expect(toMessageView(row({ model_id: null }))).not.toHaveProperty("provenance");
  });
});

describe("blocks and cards read back with their own provenance", () => {
  it("labels the next-action chip as the app's even under a model reply", () => {
    const view = toMessageView(row({ model_id: "gemini-x", tool_calls: { blocks: [
      { kind: "next_action_chip", v: 1, id: "c1", action: "log_meal", label: "Log your next meal" },
    ] } }));
    expect(view.provenance).toEqual(MODEL);
    expect(view.blocks?.[0]).toMatchObject({ kind: "next_action_chip", provenance: APP });
    // The phone re-parses blocks with the strict schema: the labelled chip still passes.
    expect(uiBlockSchema.safeParse(view.blocks?.[0]).success).toBe(true);
  });

  it("never trusts a provenance claim stored on a block", () => {
    const view = toMessageView(row({ model_id: "gemini-x", tool_calls: { blocks: [
      { kind: "quick_replies", v: 1, id: "q1", options: ["Yes", "No"], provenance: APP },
    ] } }));
    expect(view.blocks?.[0]).toMatchObject({ provenance: MODEL });
  });

  it("labels a suggestion card from its stamp, else from the rank note Jev wrote", () => {
    expect(cardProvenance({ ...card, provenance: APP, rankNote: "fits 90 %, natural meal" }))
      .toEqual(APP);
    expect(cardProvenance({ ...card, rankNote: "fits 90 %, natural meal" }))
      .toEqual({ ai: true, source: "jev", purpose: "suggest-options" });
    expect(cardProvenance({ ...card, rankNote: "fits 90 %" })).toEqual(APP);
    // A compose_meal card carries no rank note: it inherits its message's provenance.
    expect(cardProvenance(card)).toBeUndefined();
    const view = toMessageView(row({ model_id: "gemini-x", tool_calls: {
      composed: [{ ...card, rankNote: "fits 90 %" }, card] } }));
    expect(view.composed?.map((meal) => meal.provenance)).toEqual([APP, undefined]);
  });
});
