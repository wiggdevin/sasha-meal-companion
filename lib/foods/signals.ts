/**
 * Food signal events with their offered slates (Phase 18 W6, docs/specs/phase-18-open-world-foods.md
 * §W6, migration 20261219090000): the wire contract of `POST /api/foods/signals`, shared by the
 * route and the phone.
 *
 * One event is one tap on a food the app OFFERED, with the slate it was offered in:
 *   - `picked`        the food chosen from the slate (swap sheet, suggestion card)
 *   - `swapped_away`  the food the user swapped out of (swap sheet; it is in the slate it was shown in)
 *   - `not_this`      "Not this" for THIS occasion (Plan sheet, suggestion card). Never a taste
 *                     dislike: that is the W5 taste profile, written only by a confirmed chip
 *   - `added`         a Plan-sheet "Add" from the offered list
 * `chosenKey` is the food the event is about and must be one of `offeredKeys` (1 to 8 distinct food
 * keys, lib/meals/food-key.ts). An event outside its slate is rejected, never stored; the database
 * enforces the same rule (check constraint and `record_food_signals`).
 *
 * No PII beyond the account (from the session) and food keys: no names, no free text.
 * Pure. No I/O.
 */

import { z } from "zod";
import { isFoodKey } from "@/lib/meals/food-key";
import { OCCASIONS } from "@/lib/meals/occasion";

export const SIGNAL_EVENTS_MAX = 20;
export const SIGNAL_SLATE_MAX = 8;
/** The phone may queue events offline; older ones are not ranking evidence any more. */
export const SIGNAL_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** A phone clock this far ahead is wrong; its events are rejected. */
export const SIGNAL_MAX_AHEAD_MS = 10 * 60 * 1000;
/** Rows live this long (`food_signal_events_purge`). */
export const SIGNAL_RETENTION_DAYS = 180;
/** Request body ceiling: 20 events of 8 keys of up to 160 characters, with room to spare. */
export const SIGNAL_BODY_MAX_BYTES = 48 * 1024;

/** The Plan sheet's own ordering of the coach's `suggest_options` ideas (not a `MealSnapshot`). */
export const PLAN_SHEET_RANKING_VERSION = "plan-sheet-v1";
/** The coach's inline suggestion cards (`suggest_options` composed meals). */
export const SUGGESTION_CARD_RANKING_VERSION = "suggestion-card-v1";
/**
 * The swap sheet's slate: saved recipes, then saved meals, then `rankPlates` plates, then the
 * sheet's dedup. Not pure "o2.1", so its events name this instead.
 */
export const SWAP_SHEET_RANKING_VERSION = "swap-sheet-v1";

/**
 * Every ranking version the app has issued: `MealSnapshot.rankingVersion` (lib/meals/snapshot.ts)
 * and the composed-meal and swap-sheet orderings above.
 * An event naming any other is rejected: the field is an identifier, never free text. When the
 * ranking contract bumps, APPEND the new version and keep the old ones, since older phones and
 * offline queues still send them (tests/foods/signals-route.test.ts pins the current one in here).
 */
export const SIGNAL_RANKING_VERSIONS: readonly string[] = [
  "o2.1", PLAN_SHEET_RANKING_VERSION, SUGGESTION_CARD_RANKING_VERSION, SWAP_SHEET_RANKING_VERSION,
];

export const SIGNAL_SURFACES = ["swap_sheet", "plan_sheet", "suggestion_card"] as const;
export const SIGNAL_KINDS = ["picked", "swapped_away", "not_this", "added"] as const;
export type SignalSurface = (typeof SIGNAL_SURFACES)[number];
export type SignalKind = (typeof SIGNAL_KINDS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const foodKey = z.string().max(160).refine(isFoodKey);
const localDate = z.string().regex(ISO_DATE)
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d));

export const FoodSignalEvent = z.object({
  clientEventId: z.uuid(),
  slateId: z.uuid(),
  at: z.iso.datetime({ offset: true }),
  localDate,
  surface: z.enum(SIGNAL_SURFACES),
  kind: z.enum(SIGNAL_KINDS),
  occasion: z.enum(OCCASIONS as unknown as [string, ...string[]]),
  chosenKey: foodKey,
  offeredKeys: z.array(foodKey).min(1).max(SIGNAL_SLATE_MAX)
    .refine((keys) => new Set(keys).size === keys.length),
  rankingVersion: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/),
}).strict();
export type FoodSignalEvent = z.infer<typeof FoodSignalEvent>;

export const FoodSignalBatch = z.object({
  events: z.array(FoodSignalEvent).min(1).max(SIGNAL_EVENTS_MAX),
}).strict();

export type RejectReason = "not_offered" | "unknown_key" | "version" | "stale" | "ahead" | "date";


/**
 * Why an event cannot be stored, or null when it can. `now` is the server's clock; `issued` says
 * whether a food key names a food the app can have issued (the server passes `issuedFoodKey` from
 * lib/server/food-signals.ts, which holds the bundled-food lookup so the phone never loads it).
 */
export function signalRejection(event: FoodSignalEvent, now: number,
  issued: (key: string) => boolean): RejectReason | null {
  if (!event.offeredKeys.includes(event.chosenKey)) return "not_offered";
  if (!event.offeredKeys.every(issued)) return "unknown_key";
  if (!SIGNAL_RANKING_VERSIONS.includes(event.rankingVersion)) return "version";
  const at = Date.parse(event.at);
  if (at > now + SIGNAL_MAX_AHEAD_MS) return "ahead";
  if (at < now - SIGNAL_MAX_AGE_MS) return "stale";
  const utcDay = Date.parse(new Date(at).toISOString().slice(0, 10));
  const day = Date.parse(`${event.localDate}T00:00:00Z`);
  if (Math.abs(day - utcDay) > 24 * 60 * 60 * 1000) return "date";
  return null;
}

/** The batch split into events the store may take and the count rejected. */
export function partitionSignals(events: readonly FoodSignalEvent[], now: number,
  issued: (key: string) => boolean): { eligible: FoodSignalEvent[]; rejected: number } {
  const eligible = events.filter((event) => signalRejection(event, now, issued) === null);
  return { eligible, rejected: events.length - eligible.length };
}

/** The row shape `record_food_signals(p_events jsonb)` reads. */
export function signalRow(event: FoodSignalEvent): Record<string, unknown> {
  return {
    client_event_id: event.clientEventId, slate_id: event.slateId, at: event.at,
    local_date: event.localDate, surface: event.surface, kind: event.kind,
    occasion: event.occasion, chosen_key: event.chosenKey, offered_keys: event.offeredKeys,
    ranking_version: event.rankingVersion,
  };
}
