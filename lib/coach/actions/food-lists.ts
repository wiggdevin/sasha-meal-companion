/**
 * The four food-list marks — `add_to_avoid`, `remove_from_avoid`, `add_to_eats`,
 * `remove_from_eats` — share everything but their words: one grounding (widened to every
 * same-name catalog row), one apply and one Undo, so they share one file.
 */

import { z } from "zod";
import {
  foodName, groundedBaseSchema, groundedNamedFoodSchema, roleAdviceSchema, sameNameRefs,
  type GroundedBase, type GroundedNamedFood, type GroundedRoleAdvice,
} from "@/lib/coach/actions/fields";
import { displayName } from "@/lib/coach/actions/copy";
import { act, clarification, clarify, flagged, groundNamedFood } from "@/lib/coach/actions/ground-kit";
import type { ActionSpec, ExamplePart, GroundKit, PromptPart } from "@/lib/coach/actions/spec";
import { foodArgs, type IntentArgInput, type MissingArgs } from "@/lib/coach/intent-args";

type ListKind = "add_to_avoid" | "remove_from_avoid" | "add_to_eats" | "remove_from_eats";

/**
 * The four kinds this file defines, as a runtime list: every one of them is a repeatable,
 * undo-safe mark on one list, the shape the final step's 3-action cap (lib/coach/turn.ts
 * turnStepSchema, lib/coach/wire.ts turnStepProviderSchema) is most likely to fill without room
 * for everything the user named (evidence 2026-09-20: "add all those to my eats list" after a
 * six-item reply added only 3, with nothing said about the other three).
 */
export const LIST_MARK_KINDS: readonly ListKind[] =
  ["add_to_avoid", "remove_from_avoid", "add_to_eats", "remove_from_eats"];

/** What a `user_food_prefs` row held before a mark touched it; null when it held nothing. */
export type PrefBefore = { status: "eats" | "avoid"; note: string | null;
  role?: "protein" | "carb" | "fat"; noCook?: boolean } | null;

type ListTypes<K extends ListKind> = {
  kind: K;
  input: { kind: K; name: string; foodRefId?: string };
  action: GroundedBase & { kind: K;
    /**
     * The OTHER `food_ref` ids for the same food by name (readiness pass 2026-09-18). A mark on
     * "Watermelon, raw" alone left the catalog's five other watermelon rows unmarked, and the
     * next grounding ranked one of those first. Empty when the server could not widen it.
     */
    alsoFoodRefIds?: string[];
    /** Advisory until this same list action is explicitly confirmed on the phone. */
    roleAdvice?: GroundedRoleAdvice } & GroundedNamedFood;
  token: { kind: K; foodRefId: string;
    /**
     * Every ref the mark reached — the grounded one first — with the status each row carried
     * BEFORE it. Undo puts each row back to its own state, so a sibling already marked Eats
     * stays Eats. Absent on a token minted before this existed; the grounded ref alone then.
     */
    refs?: { refId: string; previous: PrefBefore }[];
    localId: string | null; previous: PrefBefore;
    name?: string;
    appliedNote?: string | null;
    /** The membership revision this mark wrote; the server's Undo runs only while it is current. */
    markRev?: number;
    localPrevious?: { status: "eats" | "avoid" | "neutral"; note: string | null } | null };
  intentArgs: MissingArgs & { name?: string };
};

async function groundListMark<K extends ListKind>(
  input: ListTypes<K>["input"], kit: GroundKit,
) {
  const { userId, profile, ports } = kit;
  // The search runs here rather than inside groundNamedFood so the chosen row's own
  // description is in hand: a mark is widened by the CATALOG's name for the food, not by theirs.
  const [hit] = await ports.searchFoods(userId, input.name, 1);
  const food = hit === undefined
    ? null : await groundNamedFood(userId, input.name, null, profile, ports, hit);
  if (food === null) return clarify<ListTypes<K>["action"]>(clarification(input.name));
  const sameName = (await ports.sameNameRefIds?.(userId, hit.name)) ?? [];
  return act((actionId) => ({ ...input, ...food,
    // Membership is keyed by the catalog's canonical name, not the user's looser search words.
    name: hit.name, actionId,
    // A list mark is about the food itself: a blocked verdict is not a reason to hold it
    // back, so it carries no marks of its own.
    flagged: input.kind === "add_to_avoid" || input.kind === "remove_from_eats"
      ? [] : flagged([food]),
    alsoFoodRefIds: sameName.filter((id) => id !== food.foodRefId) }));
}

function listMark<K extends ListKind>(kind: K, copy: {
  title: (name: string) => string; pending: (name: string) => string; reply: (name: string) => string;
  eats: boolean; prompt?: PromptPart; example?: ExamplePart;
}): ActionSpec<ListTypes<K>> {
  return {
    kind,
    input: z.object({ kind: z.literal(kind), name: foodName,
      ...(copy.eats ? { foodRefId: z.uuid().optional() } : {}) }) as z.ZodType<ListTypes<K>["input"]>,
    wire: copy.eats
      ? { named: ["name"], strings: ["foodRefId"], fields: { foodRefId: z.string().max(64) },
        docLabel: "add/remove Eats", stringsDoc: " only when known" }
      : { named: ["name"] },
    replay: groundedNamedFoodSchema.extend({ ...groundedBaseSchema, kind: z.literal(kind),
      alsoFoodRefIds: sameNameRefs, roleAdvice: roleAdviceSchema }),
    ground: (input, kit) => groundListMark(input, kit),
    history: (action) => ` ${action.name}`,
    ...(copy.prompt ? { prompt: copy.prompt } : {}),
    ...(copy.example ? { example: copy.example } : {}),
    intent: {
      extract: ({ foodsMentioned }: IntentArgInput) => {
        const argConfidence: Record<string, number> = foodsMentioned?.length ? { name: 1 } : {};
        return { args: foodArgs(foodsMentioned), argConfidence };
      },
    },
    fastPath: {
      candidate: (args) => args.name ? { kind, name: args.name } : null,
      reply: (action) => copy.reply(action.name),
    },
    card: {
      title: (action) => copy.title(action.name),
      pending: (action) => copy.pending(action.name),
      lines: (action) => [{ name: action.name, grams: null }],
    },
  };
}

export const addToAvoid = listMark("add_to_avoid", {
  eats: false,
  title: (name) => `Added ${name} to your avoid list`,
  pending: (name) => `Adding ${name} to your avoid list`,
  reply: (name) => `Adding ${name} to your Avoid list.`,
  // The one line introduces all four marks.
  prompt: { rank: 100, lines: [
    "  add_to_avoid / remove_from_avoid / add_to_eats / remove_from_eats { name } — your two",
    "    exclusive food lists. Use the action whose words match your request; never invert one.",
  ] },
  example: { rank: 10, lines: () => [
    '  User: "Add watermelon to my avoid list"',
    '  Final: { "kind": "final", "text": "Watermelon is on your avoid list now.", "actions": [{ "kind": "add_to_avoid", "name": "watermelon" }], "memory": [] }',
  ] },
});

export const removeFromAvoid = listMark("remove_from_avoid", {
  eats: false,
  title: (name) => `Took ${name} off your avoid list`,
  pending: (name) => `Removing ${name} from your avoid list`,
  reply: (name) => `Removing ${name} from your Avoid list.`,
});

/**
 * D13 (Phase 18 W13): the wire kind, every field name and the sync op stay `eats` — only the
 * copy a person reads changes, from "Eats" to "Favored". Removing says "no longer favored"
 * rather than "off your list", because an open-world account's food can still appear without the
 * mark (D13: "Favored favors and never limits").
 */
export const addToEats = listMark("add_to_eats", {
  eats: true,
  title: (name) => `${displayName(name)} → Favored`,
  pending: (name) => `Adding ${name} to your Favored list`,
  reply: (name) => `Adding ${name} to your Favored list.`,
  example: { rank: 70, lines: () => [
    '  User: "put salmon back on my eats list"',
    '  Final: { "kind": "final", "text": "Salmon is on your Favored list.", "actions": [{ "kind": "add_to_eats", "name": "salmon" }] }',
  ] },
});

export const removeFromEats = listMark("remove_from_eats", {
  eats: true,
  // Sol round 2 BLOCK: this clears the mark to neutral; it never puts the food on Avoid, and the
  // card must not say it does (the food stays eligible for plans).
  title: (name) => `Took ${displayName(name)} off Favored`,
  pending: (name) => `Marking ${name} no longer favored`,
  reply: (name) => `${name} is no longer favored.`,
  example: { rank: 80, lines: () => [
    '  User: "take salmon off my eats list"',
    '  Final: { "kind": "final", "text": "Salmon is no longer favored.", "actions": [{ "kind": "remove_from_eats", "name": "salmon" }] }',
  ] },
});
