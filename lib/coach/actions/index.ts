/**
 * Coach actions cross the model boundary as names and grams; the server grounds every named food
 * before the client sees it. This module is the action REGISTRY: each kind is described once, in
 * lib/coach/actions/<kind>.ts, and registered in ACTION_SPECS below. Every union, schema, switch
 * and list that used to be kept per kind is derived from that array; apply/undo is bound per kind
 * in lib/coach/actions/apply.ts.
 *
 * ORDER MATTERS: it is the provider's `kind` enum order and the order of the positional-argument
 * docs, both pinned byte for byte by tests/coach/action-golden.
 *
 * Pure. No I/O, no Supabase import.
 */

import type { z } from "zod";
import { buildActionSchemas } from "@/lib/coach/actions/schemas";
import { addToShoppingList } from "@/lib/coach/actions/add-to-shopping-list";
import { deleteEntry } from "@/lib/coach/actions/delete-entry";
import {
  addToAvoid, addToEats, removeFromAvoid, removeFromEats,
} from "@/lib/coach/actions/food-lists";
import { logMeal } from "@/lib/coach/actions/log-meal";
import { logWater } from "@/lib/coach/actions/log-water";
import { logWeight } from "@/lib/coach/actions/log-weight";
import { moveEntry } from "@/lib/coach/actions/move-entry";
import { moveSlot } from "@/lib/coach/actions/move-slot";
import { saveRecipe } from "@/lib/coach/actions/save-recipe";
import { setShoppingFocus } from "@/lib/coach/actions/set-shopping-focus";
import { setSlotMeal } from "@/lib/coach/actions/set-slot-meal";
import { setTargets } from "@/lib/coach/actions/set-targets";
import { restoreSlot, skipSlot } from "@/lib/coach/actions/skip-slot";
import { shiftSchedule } from "@/lib/coach/actions/shift-schedule";
import { addSlotItem, removeSlotItem, setSlotItem } from "@/lib/coach/actions/slot-items";
import { updateProfile } from "@/lib/coach/actions/update-profile";
import type { ActionSpec, SpecTypes, TypesOf } from "@/lib/coach/actions/spec";

export const ACTION_SPECS = [
  logMeal, addSlotItem, removeSlotItem, setSlotItem, moveSlot,
  // T6 §3 — the sentences the user actually says.
  addToAvoid, removeFromAvoid, setSlotMeal, deleteEntry, moveEntry,
  saveRecipe, shiftSchedule, logWater, logWeight, updateProfile,
  setTargets, addToEats, removeFromEats, addToShoppingList,
  // Day rebalancing (2026-10-03): skip one meal for one date, or bring it back.
  skipSlot, restoreSlot,
  // W11: "use my shopping list" / off, with Undo.
  setShoppingFocus,
] as const;

export type RegisteredTypes = TypesOf<(typeof ACTION_SPECS)[number]>;
export type ActionKind = RegisteredTypes["kind"];
type LooseOf<D> = D extends { loose: infer L } ? L
  : D extends { input: infer I } ? I : never;

/** The grounded action the client applies, the card draws and the history replays. */
export type CoachAction = RegisteredTypes["action"];
/** The undo token each kind's apply returns; its shape is what the phone has stored. */
export type ActionUndoToken = RegisteredTypes["token"];
type CanonicalCoachActionInput = RegisteredTypes["input"];
/** Direct callers may still hand us old rows; parsing canonicalizes both meal action families. */
export type CoachActionInput = LooseOf<RegisteredTypes>;
/** The intent pre-pass's arguments, for every kind whose spec reads them. */
export type ActionIntentArgs = {
  [D in RegisteredTypes as D extends { intentArgs: object } ? D["kind"] : never]:
    D extends { intentArgs: infer A } ? A : never;
};

export const ACTION_KINDS = ACTION_SPECS.map((spec) => spec.kind) as unknown as
  readonly [ActionKind, ...ActionKind[]];

const BY_KIND = new Map<string, ActionSpec<SpecTypes>>(
  ACTION_SPECS.map((spec) => [spec.kind, spec]));

/** The spec for a kind, or undefined for a kind this build does not know (design §8.5). */
export function actionSpecFor(kind: string): ActionSpec<SpecTypes> | undefined {
  return BY_KIND.get(kind);
}

const SCHEMAS = buildActionSchemas(ACTION_SPECS);

/** The strict model-to-server action. Zero grams never reaches grounding. */
export const coachActionSchema = SCHEMAS.strict as unknown as z.ZodType<CanonicalCoachActionInput>;

/**
 * The provider-safe form. It is one object, not a union, and uses min(0) because Gemini rejects
 * exclusiveMinimum. coachActionSchema is the strict check and still refuses zero or missing grams.
 */
export const flatCoachActionSchema = SCHEMAS.flat;

/**
 * The action object the PROVIDER is sent: every key is REQUIRED and allowed to be empty.
 * Constrained decoding only guarantees required keys; with `items` optional the live model omitted
 * it three runs out of three (2026-09-18). Positional arrays keep the schema at the live model's
 * 30-property ceiling: M1 moved log/move clock strings there to make room for the named meal-range
 * contract. The strict named action schema remains the application boundary.
 */
export const providerActionSchema = SCHEMAS.provider;

/** Flat for the provider, strict when the adapter parses it. */
export function coachActionWireSchemaFor(today?: string): z.ZodType<CoachActionInput> {
  return SCHEMAS.wireFor(today) as unknown as z.ZodType<CoachActionInput>;
}

export const coachActionWireSchema = coachActionWireSchemaFor();

/** Validate grounded actions again when they cross the database replay boundary. */
export const groundedCoachActionSchema = SCHEMAS.replay as unknown as z.ZodType<CoachAction>;

const DIRECT_ACTION_CLAIM =
  /(?:^\s*|\bI(?:['’]ve| have)?\s+)(?:logged|added|removed|moved|updated|deleted|saved)\b/i;
const QUALIFIED_ACTION_CLAIM =
  /(?:^\s*|\bI(?:['’]ve| have)?\s+)(?:changed|set)\b(?=[^.!?]*(?:\d+(?:\.\d+)?\s*(?:g|grams?)\b|\b(?:meal|slot|item|breakfast|lunch|dinner)\b))/i;

/** True when reply prose says a write already happened. Text never makes the write happen. */
export function claimsAction(text: string): boolean {
  return DIRECT_ACTION_CLAIM.test(text) || QUALIFIED_ACTION_CLAIM.test(text);
}

export { deriveMealTitle, sanitizeMealTitle } from "@/lib/coach/meal-title";
export { LOG_SLOT_IDS } from "@/lib/coach/actions/fields";
export type {
  GroundedActionItem, GroundedNamedFood, GroundedRoleAdvice, LogSlot,
} from "@/lib/coach/actions/fields";
export type { GroundActionPorts } from "@/lib/coach/actions/spec";
export {
  groundActions, groundAndExpandActions, type GroundActionsResult,
} from "@/lib/coach/ground";
