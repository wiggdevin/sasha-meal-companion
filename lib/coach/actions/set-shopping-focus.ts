/**
 * `set_shopping_focus`: "use my shopping list" / turn it off (Phase 18 W11, D7). Shopping is
 * gated per account the same way `add_to_shopping_list` is
 * (`lib/server/recipe-access.ts` `recipeAccessEnabled`): the prompt only describes this kind when
 * the account has access, and the apply path fails with a clear reason and writes nothing when it
 * does not (acceptance 4).
 *
 * `days` is the account's own choice of how far out to turn it on (1 to 31, D7's stated maximum);
 * 0 (the positional placeholder, like every other unnamed numeric field) means the D7 default —
 * the open shopping period's own end, or 7 days out. The server (never the model) computes the
 * actual `shopping_focus_until` timestamp and clamps it. `on`/`off` travels as a string, not a
 * boolean: no shared named-field slot is spent (wire-fields.ts's 30-property budget), the same
 * positional `numericArgs`/`stringArgs` mechanism `update_profile`'s enums already use.
 */

import { z } from "zod";
import { describedEnum, groundedBaseSchema, type GroundedBase } from "@/lib/coach/actions/fields";
import { passThrough } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";
import { FOCUS_MAX_DAYS } from "@/lib/shopping/focus";

const ON_OFF = ["on", "off"] as const;

const input = z.object({
  kind: z.literal("set_shopping_focus"),
  on: z.boolean(),
  days: z.number().int().min(1).max(FOCUS_MAX_DAYS).optional(),
});

type Types = {
  kind: "set_shopping_focus";
  input: z.infer<typeof input>;
  action: GroundedBase & { kind: "set_shopping_focus"; on: boolean; days?: number };
  /** Undo names the server's write; the server restores the value it recorded (compare-and-set). */
  token: { kind: "set_shopping_focus"; actionId: string };
};

export const setShoppingFocus: ActionSpec<Types> = {
  kind: "set_shopping_focus",
  input,
  wire: {
    named: [],
    strings: ["on"],
    numbers: ["days"],
    fields: { on: describedEnum(ON_OFF), days: z.number().int().min(0).max(FOCUS_MAX_DAYS) },
    stringsDoc: " with empty placeholders",
    numbersDoc: " with zero placeholders",
    // The provider sends "on"/"off"; the typed action is a plain boolean everywhere else.
    candidate: (candidate) => ({ ...candidate,
      on: candidate.on === "on" ? true : candidate.on === "off" ? false : candidate.on }),
  },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("set_shopping_focus"),
    on: z.boolean(), days: z.number().int().min(1).max(FOCUS_MAX_DAYS).optional() }),
  ground: async (value) => passThrough(value),
  history: (action) => action.on
    ? ` on${action.days ? ` for ${action.days} days` : ""}` : " off",
  prompt: { rank: 125, lines: [
    "  set_shopping_focus uses stringArgs [onOrOff] (\"on\" or \"off\") and numericArgs [days]",
    "    (1-31, 0 for the default). Turns \"use my shopping list\" on or off. Only offered when",
    "    Shopping is set up for this account.",
  ] },
  example: { rank: 125, lines: () => [
    '  User: "use my shopping list for meals this week"',
    '  Final: { "kind": "final", "text": "Turned on \\"use my shopping list\\".", '
      + '"actions": [{ "kind": "set_shopping_focus", "stringArgs": ["on"] }] }',
    '  User: "stop using my shopping list"',
    '  Final: { "kind": "final", "text": "Turned off \\"use my shopping list\\".", '
      + '"actions": [{ "kind": "set_shopping_focus", "stringArgs": ["off"] }] }',
  ] },
  card: {
    title: (action) => action.on ? "Turned on \"use my shopping list\"" : "Turned off \"use my shopping list\"",
    pending: (action) => action.on ? "Turning on \"use my shopping list\"" : "Turning off \"use my shopping list\"",
    lines: () => [],
  },
};
