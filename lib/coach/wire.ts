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

/**
 * The flat reply as a candidate union member, or the union's complaint. All the strictness lives
 * in `turnStepSchema`, so a `final` with no text, an `abort` with no reason or a suggestion
 * carrying a non-uuid id is refused by exactly one schema. Pure.
 */
export function turnStepCandidate(
  wire: WireTurnStep, today?: string,
): { ok: true; step: TurnStep } | null {
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
    return parsed.success ? { ok: true, step: parsed.data } : null;
  }
  if (wire.text) candidate.text = wire.text;
  const suggestions = named(wire.suggestions);
  if (suggestions.length) candidate.suggestions = suggestions;
  if (wire.actions?.length) {
    const actionSchema = coachActionWireSchemaFor(today);
    const actions = wire.actions.map((action) => actionSchema.safeParse(action));
    if (actions.some((action) => !action.success)) return null;
    candidate.actions = actions.map((action) => action.data);
  }
  if (wire.memory?.length) candidate.memory = wire.memory;
  const parsed = turnStepSchema.safeParse(candidate);
  return parsed.success ? { ok: true, step: parsed.data } : null;
}

/**
 * The schema the adapter validates with — flat on the outside so it lowers to one Gemini object,
 * the union on the inside so every variant rule still applies. The mapping is a transform, not a
 * step a caller does after the fact: `generateStructured` fails the parse, writes
 * `ai_calls.status = "schema_invalid"` and counts it toward the schema-failure circuit when the
 * union refuses a wire-valid reply, instead of recording the weaker flat parse as `ok`.
 */
export function turnStepWireSchemaFor(today?: string): z.ZodType<TurnStep> {
  return flatTurnStep
    .superRefine((wire, ctx) => {
      if (turnStepCandidate(wire, today) === null) {
        ctx.addIssue({ code: "custom", message: "the reply is not one of the three turn steps" });
      }
    })
    .transform((wire, ctx): TurnStep => {
      const candidate = turnStepCandidate(wire, today);
      if (candidate === null) {
        ctx.addIssue({ code: "custom", message: "the reply is not one of the three turn steps" });
        return z.NEVER;
      }
      return candidate.step;
    });
}

export const turnStepWireSchema = turnStepWireSchemaFor();
