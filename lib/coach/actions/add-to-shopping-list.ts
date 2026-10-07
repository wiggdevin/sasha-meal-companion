/**
 * `add_to_shopping_list`: manual items the user asks to buy, added to the shopping list that
 * covers today (owner ask 2026-10-02, "make shopping super useful").
 *
 * Shopping is gated per account (`lib/server/recipe-access.ts` `recipeAccessEnabled`): the prompt
 * only describes this kind when `lib/coach/prompt.ts` is told the account has access, and
 * `lib/coach/apply-shopping.ts` fails with a clear reason instead of writing anything when it does
 * not. Items are plain strings, never logged food. They are NOT exempt from the hard-rule reply
 * scan by name: only the reply's own "added X to your list" sentence is set aside, and the cards
 * that merely mirror the items are dropped (lib/coach/shopping-confirmation.ts, audits 2026-10-02).
 */

import { z } from "zod";
import { groundedBaseSchema, type GroundedBase } from "@/lib/coach/actions/fields";
import { passThrough } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec } from "@/lib/coach/actions/spec";
import type { ShoppingLine } from "@/lib/shopping/types";

const shoppingItemName = z.string().min(1).max(160);
/** Eight per action: `stringArgs` with maxItems 20 made Google reject the whole coach schema
 *  (OpenRouter 400 INVALID_ARGUMENT, live 2026-10-02); 8 is accepted. */
const MAX_ITEMS = 8;
const names = () => z.array(shoppingItemName).min(1).max(MAX_ITEMS);

const input = z.object({ kind: z.literal("add_to_shopping_list"), names: names() });

type Types = {
  kind: "add_to_shopping_list";
  input: z.infer<typeof input>;
  action: GroundedBase & { kind: "add_to_shopping_list"; names: string[] };
  /** Undo deletes every line this action created, each exactly as the write returned it. */
  token: { kind: "add_to_shopping_list"; lines: ShoppingLine[] };
};

export const addToShoppingList: ActionSpec<Types> = {
  kind: "add_to_shopping_list",
  input,
  wire: {
    named: [],
    // No named field is spent: `stringArgs` already exists on every kind, and the 30-property
    // live schema budget (tests/coach/provider-schema.test.ts) has no room for another one.
    stringsRest: { field: "names", max: MAX_ITEMS },
    // The parse-only form of `names` (no provider property): the model loop re-parses the step the
    // adapter already mapped, and without it every shopping reply failed as "not one of the three
    // turn steps" (live 2026-10-02).
    fields: { names: z.array(shoppingItemName).max(MAX_ITEMS) },
    stringsDoc: " — the shopping items to add, each in the user's own words",
  },
  replay: z.object({ ...groundedBaseSchema, kind: z.literal("add_to_shopping_list"),
    names: names() }),
  // No food grounding: a shopping item is a plain string, never a catalog row, never logged food.
  ground: async (value) => passThrough(value),
  history: (action) => ` ${action.names.join(", ")}`,
  prompt: { rank: 120, lines: [
    "  add_to_shopping_list { stringArgs: [...names] } — add items to the user's current shopping",
    "    list, one per name (\"eggs\", \"oat milk\"). Only offered when Shopping is set up for this",
    "    account. Never a grams amount, never a dish to cook — just the words they asked to buy.",
  ] },
  example: { rank: 120, lines: () => [
    '  User: "add eggs and oat milk to my shopping list"',
    '  Final: { "kind": "final", "text": "Added eggs and oat milk to your list.", '
      + '"actions": [{ "kind": "add_to_shopping_list", "stringArgs": ["eggs", "oat milk"] }] }',
  ] },
  card: {
    title: (action) => action.names.length === 1
      ? `Added ${action.names[0]} to your list`
      : `Added ${action.names.length} items to your list`,
    pending: (action) => action.names.length === 1
      ? `Adding ${action.names[0]} to your list`
      : `Adding ${action.names.length} items to your list`,
    lines: (action) => action.names.map((name) => ({ name, grams: null })),
  },
};
