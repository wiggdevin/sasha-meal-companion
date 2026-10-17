/**
 * The wire form of a turn step: what the provider is SENT, and what a reply is PARSED with.
 *
 * Split out of lib/coach/turn.ts, which owns the reducer and the union. The two schemas here
 * differ in one way and one way only — the provider's requires every key — and the note on
 * `turnStepProviderSchema` says why that decides whether the coach produces cards at all.
 *
 * Pure. No I/O, no Supabase import.
 */

import { z } from "zod";
import {
  coachActionWireSchemaFor,
  flatCoachActionSchema,
  providerActionSchema,
} from "@/lib/coach/actions";
import { turnStepSchema, type TurnStep } from "@/lib/coach/turn";
import { memoryParseSchema, memoryWireSchema } from "@/lib/coach/memory";

/**
 * `name` carries no `.min(1)` here, and that is deliberate. Every key is required on the wire, so
 * the model sometimes fills an array it has nothing for with one blank-named placeholder — three
 * runs out of three against the live model, 2026-09-18, which our own parse then refused. A blank
 * name is dropped by `turnStepCandidate`; `turnStepSchema` below still requires a real one.
 */
const callShape = z.object({
  name: z.string().max(64),
  // Lowers to `{}`: the model may put any tool arguments here. The tool's own input schema in
  // lib/coach/registry.ts, applied by validateToolCall, is what actually checks them.
  args: z.unknown(),
});
const suggestionShape = z.object({
  name: z.string().max(120),
  // A plain string, not z.uuid(): the union re-checks it, and a `format` keyword is not worth
  // putting in front of the provider when the final validator is here anyway.
  foodRefId: z.string().max(64).nullable().optional(),
  // `.min(0)`, NOT `.positive()`: positive() lowers to `exclusiveMinimum`, which the live API
  // rejects with a 400 ("Unknown name exclusiveMinimum") - measured 2026-09-12. The union below
  // still refuses 0 grams.
  grams: z.number().min(0).max(2000).nullable().optional(),
});

/**
 * What we PARSE a reply with: lenient, because a reply that omits a key it had nothing to say
 * about is still a good reply, and because every caller that hand-builds one should not have to
 * spell out six empty fields.
 */
const flatTurnStep = z.object({
  kind: z.enum(["tool", "final", "abort"]),
  calls: z.array(callShape).max(6).optional(),
  // `actions` and `suggestions` come BEFORE `text` on purpose: Gemini fills a structured object in
  // schema order, and deciding the action before describing it is the order the prompt asks for.
  actions: z.array(flatCoachActionSchema).max(3).optional(),
  suggestions: z.array(suggestionShape).max(8).optional(),
  text: z.string().max(4000).optional(),
  memory: memoryParseSchema.optional(),
  // No `.min(1)`: the model fills a required key it has nothing for with "" (live, 2026-09-18).
  // `turnStepCandidate` drops an empty one, and `turnStepSchema` still refuses an abort without.
  // No `.max`: an over-long reason failed the whole turn (live smoke, 2026-10-02); the candidate
  // trims it to 200 and the provider schema still sends the limit as a hint.
  reason: z.string().optional(),
});

/**
 * What the PROVIDER is sent, and the two schemas differ in exactly one way: here every key is
 * REQUIRED, with an empty value allowed.
 *
 * lib/ai/gemini-config.ts sends this as `responseSchema` with `responseMimeType:
 * application/json`, which is constrained decoding: the model must emit the keys the schema
 * requires. While `actions`, `suggestions` and `memory` were optional, the live model emitted
 * `kind` and `text` and nothing else - on the old action kinds as much as the new ones - and
 * wrote the action it wanted to take into the prose instead ("[actions] {...} [/actions]",
 * measured 2026-09-18). Marking them required AND nullable did not fix it; `nullable: true`
 * appears to make Gemini treat a required key as skippable. Required with an empty value allowed
 * does: an empty array and an empty string are how the model says "not this variant", and
 * `turnStepCandidate` reads them as absent. Memory uses an empty array for that case.
 *
 * `reason` loses its `.min(1)` here for the same reason; the union still refuses an abort
 * without one.
 */
export const turnStepProviderSchema = z.object({
  kind: z.enum(["tool", "final", "abort"]),
  calls: z.array(callShape).max(6),
  actions: z.array(providerActionSchema).max(3),
  suggestions: z.array(suggestionShape).max(8),
  text: z.string().max(4000),
  memory: memoryWireSchema,
  reason: z.string().max(200),
});

/** The empty wire reply: every key present, every one saying "not this variant". */
export const EMPTY_WIRE_STEP = {
  calls: [], actions: [], suggestions: [], text: "", memory: [], reason: "",
} as const;

export type WireTurnStep = z.infer<typeof flatTurnStep>;

/** Empty the way a required wire field says "nothing here": "", 0, null, or only empties. */
function blank(value: unknown): boolean {
  if (value === undefined || value === null || value === 0) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.every(blank);
  if (typeof value === "object") return Object.values(value).every(blank);
  return false;
}

/**
 * Keys a placeholder may still carry a value in: `slot` is an enum, so the provider schema forces
 * one in, and `date` is the day the model is told to write on every action. Neither names a thing
 * to do on its own once the action has failed its own schema.
 */
const PLACEHOLDER_KEYS = new Set(["kind", "slot", "date"]);

/** A refused action that carries nothing but its kind, a slot and a date: a placeholder. */
function placeholderAction(action: Record<string, unknown>): boolean {
  return Object.entries(action).every(([key, value]) => PLACEHOLDER_KEYS.has(key) || blank(value));
}

/**
 * The flat reply as a candidate union member, or the rule it broke as a fixed code. All the
 * strictness lives in `turnStepSchema`, so a `final` with no text, an `abort` with no reason or a
 * suggestion carrying a non-uuid id is refused by exactly one schema. Pure.
 */
export function turnStepCandidate(
  wire: WireTurnStep, today?: string,
): { ok: true; step: TurnStep } | { ok: false; reason: string } {
  const candidate: Record<string, unknown> = { kind: wire.kind };
  // Empty is how a required field says "not this variant" — see the note on flatTurnStep. Each
  // key is also read only where its own variant wants it: now that every key is required, a model
  // that fills `reason` on a `final` is describing its own choice, not aborting, and carrying that
  // into the union made a perfectly good reply fail ("the reply is not one of the three turn
  // steps", live, 2026-09-18).
  // A blank-named placeholder is the model filling a required array it had nothing for.
  const named = <T extends { name: string }>(rows: T[] | undefined) =>
    (rows ?? []).filter((row) => row.name.trim() !== "");
  const calls = named(wire.calls);
  if (wire.kind === "tool" && calls.length) candidate.calls = calls;
  if (wire.kind === "abort" && wire.reason) candidate.reason = wire.reason.slice(0, 200);
  if (wire.kind !== "final") {
    const parsed = turnStepSchema.safeParse(candidate);
    if (parsed.success) return { ok: true, step: parsed.data };
    return { ok: false, reason: wire.kind === "tool" ? "tool_without_named_calls" : "abort_without_reason" };
  }
  if (wire.text) candidate.text = wire.text;
  const suggestions = named(wire.suggestions);
  if (suggestions.length) candidate.suggestions = suggestions;
  if (wire.actions?.length) {
    const actionSchema = coachActionWireSchemaFor(today);
    const kept: unknown[] = [];
    for (const [index, action] of wire.actions.entries()) {
      const parsed = actionSchema.safeParse(action);
      if (parsed.success) kept.push(parsed.data);
      // W087: a refused action with nothing in it is the model filling the required array, like
      // a blank-named suggestion. Dropping it keeps the reply; refusing it threw the whole turn
      // away as "coach unavailable". A refused action with any content still refuses the turn.
      // The index and the kind only: the kind is the schema's own enum, never the model's prose.
      else if (!placeholderAction(action)) {
        return { ok: false, reason: `action_${index}_${action.kind}_unsupported` };
      }
    }
    if (kept.length) candidate.actions = kept;
  }
  if (wire.memory?.length) candidate.memory = wire.memory;
  const parsed = turnStepSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, step: parsed.data };
  const field = parsed.error.issues[0]?.path[0];
  return { ok: false, reason: `final_${typeof field === "string" ? field : "shape"}_invalid` };
}

/**
 * The schema the adapter validates with — flat on the outside so it lowers to one Gemini object,
 * the union on the inside so every variant rule still applies. The mapping is a transform, not a
 * step a caller does after the fact: `generateStructured` fails the parse, writes
 * `ai_calls.status = "schema_invalid"` and counts it toward the schema-failure circuit when the
 * union refuses a wire-valid reply, instead of recording the weaker flat parse as `ok`.
 */
export function turnStepWireSchemaFor(today?: string): z.ZodType<TurnStep> {
  // `params.reason` names the variant rule the reply broke; lib/ai/call.ts schemaIssueSummary
  // writes it into the ai_calls row and the coach's failure log (W087).
  const refuse = (ctx: z.RefinementCtx, reason: string) => ctx.addIssue({
    code: "custom", message: "the reply is not one of the three turn steps", params: { reason } });
  return flatTurnStep
    .superRefine((wire, ctx) => {
      const candidate = turnStepCandidate(wire, today);
      if (!candidate.ok) refuse(ctx, candidate.reason);
    })
    .transform((wire, ctx): TurnStep => {
      const candidate = turnStepCandidate(wire, today);
      if (!candidate.ok) {
        refuse(ctx, candidate.reason);
        return z.NEVER;
      }
      return candidate.step;
    });
}

export const turnStepWireSchema = turnStepWireSchemaFor();
