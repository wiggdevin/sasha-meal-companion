"use client";

/**
 * The Eats/Avoid half of a coach action — T6 §3.
 *
 * "Add watermelon to my avoid list" writes a `user_food_prefs` op for the ref the SERVER grounded
 * their word to. That ref is the whole point: it is what search, the scanner and the coach's own
 * next grounding read (T1/T9), and it is what the Foods tab's own mark ends up writing too.
 *
 * U3 replaces the per-ref loop with ONE outbox operation keyed by the catalog's normalized name.
 * The server transaction updates every matching catalog and user ref together; null is neutral.
 * Grounding still widens once so missing catalog refs are minted before the transaction runs.
 *
 * It does NOT go looking for a food by name in their local list. The first version did — substring
 * match, then a minted `coach-<slug>` row when nothing matched — which could mark the wrong food
 * ("banana" matching "banana bread"), and wrote a pref for a ref that had nothing to do with the
 * one the reply was grounded on (Grok pass 1, HIGH 1).
 *
 * Undo restores exactly what was there: the previous status, or NO pref at all when the user had never
 * marked this food. It never invents `eats`.
 */

import { accountHandle, assertCurrent, type AccountHandle } from "@/lib/device/account";
import type { CoachAction } from "@/lib/coach/actions";
import type { FoodStatus } from "@/lib/foods";
import { normalizeFoodName } from "@/lib/foods/normalize";
import { currentPrefStatus, isLatestFoodMembershipIntent, raiseFoodMembershipIntent, readFoodMembership,
  readServerMembershipRev, reserveFoodMembershipIntent, saveFoodNoteForRef, setFoodMembership,
} from "@/lib/foods/prefs-client";
import { getFoods, setFoodNote, setFoodStatus } from "@/lib/store";
import type { ApplyResult, UndoToken } from "@/lib/coach/apply-shared";
import { confirmMealComponentRole } from "@/lib/coach/role-advice";
import { ASSISTANT_NAME } from "@/lib/brand";
import { todayIso } from "@/lib/settings/date";

type ListAction = Extract<CoachAction, {
  kind: "add_to_avoid" | "remove_from_avoid" | "add_to_eats" | "remove_from_eats"
}>;

/**
 * Their legacy `foods` map is keyed by slug and drives the Foods tab and the rotation. A food the
 * coach grounded may or may not be in it; when it shares the normalized name, the local status
 * moves too so the tab agrees with the server. An unknown food is NOT minted here — the op-log is the
 * record, and `backfillFoodPrefs` is what reconciles the two lists.
 */
function localIdFor(name: string): string | null {
  const needle = normalizeFoodName(name);
  const found = Object.values(getFoods())
    .find((food) => normalizeFoodName(food.name) === needle);
  return found?.id ?? null;
}

async function roleRowIsReady(h: AccountHandle, foodRefId: string): Promise<boolean> {
  const { getRow } = await import("@/lib/sync/idb");
  const row = await getRow(h, "user_food_prefs", foodRefId) as Record<string, unknown> | undefined;
  return row !== undefined && !row.deleted_at && (row.status === "eats" || row.status === "avoid");
}

export async function applyFoodListMark(action: ListAction): Promise<ApplyResult> {
  const h = accountHandle();
  let intent = reserveFoodMembershipIntent(action.name, h);
  const status: Exclude<FoodStatus, "neutral"> | null = action.kind === "add_to_avoid"
    ? "avoid" : action.kind === "add_to_eats" ? "eats" : null;
  const note = action.kind === "remove_from_eats"
    ? `removed from Favored by ${ASSISTANT_NAME} on ${todayIso()}`
    : action.kind === "remove_from_avoid"
      ? `removed from Avoid by ${ASSISTANT_NAME} on ${todayIso()}`
      : undefined;
  const refId = action.foodRefId;
  const previous = await currentPrefStatus(refId, h);
  // The Undo record names this mark's revision; ask past the server's (W029, Sol review).
  intent = raiseFoodMembershipIntent(intent, await readServerMembershipRev(h, action.name));
  assertCurrent(h);
  if (!isLatestFoodMembershipIntent(intent)) {
    return { status: "failed", reason: "A newer food choice replaced this action." };
  }
  // A removal's explanatory note is an intentional edit. Save it while the grounded pref still
  // exists, then change membership without carrying any note in a queued status operation.
  if (note !== undefined && previous) {
    await saveFoodNoteForRef(refId, note, h, undefined, previous.note);
  }
  try {
    await setFoodMembership(action.name, status, { note: null, account: h, intent });
  } catch (cause) {
    if (note !== undefined && previous) {
      throw new Error("Food note saved, but the list change did not finish. Try again.", { cause });
    }
    throw cause;
  }
  assertCurrent(h);
  if (!isLatestFoodMembershipIntent(intent)) {
    return { status: "failed", reason: "A newer food choice replaced this action." };
  }
  const localId = localIdFor(action.name);
  const localFood = localId ? getFoods()[localId] : undefined;
  const localPrevious = localFood
    ? { status: localFood.status, note: localFood.note ?? null } : null;
  if (localId) setFoodStatus(localId, status ?? "neutral", note);
  if ((action.kind === "add_to_eats" || action.kind === "add_to_avoid")
      && action.roleAdvice?.foodRefId === refId
      && action.roleAdvice.requiresConfirmation === false
      && await roleRowIsReady(h, refId)) {
    // PR #248 review r4 #1: the role write reads the bound account; only the one that tapped.
    assertCurrent(h);
    await confirmMealComponentRole(action.roleAdvice, { confirmed: true });
  }
  return { status: "applied",
    token: { kind: action.kind, foodRefId: refId,
      refs: [{ refId, previous }], localId, name: action.name, previous, localPrevious,
      markRev: intent.rev,
      ...(note !== undefined && previous ? { appliedNote: note } : {}) } };
}

export const applyAvoidMark = applyFoodListMark;

export async function undoFoodListMark(
  token: Extract<UndoToken, {
    kind: "add_to_avoid" | "remove_from_avoid" | "add_to_eats" | "remove_from_eats"
  }>,
): Promise<void> {
  const h = accountHandle();
  const localFood = token.localId ? getFoods()[token.localId] : undefined;
  const name = token.name ?? localFood?.name;
  if (!name) throw new Error("Cannot undo food membership without its name");
  // Each card has its own Undo. A newer mark (another card, the Foods tab) wins: only undo while
  // the food still holds what this action set. No local record (another device) undoes as before.
  const setTo = token.kind === "add_to_avoid" ? "avoid" : token.kind === "add_to_eats" ? "eats" : null;
  const now = readFoodMembership(h.userId, name);
  // The status AND the revision this mark wrote (review t4r10 #7): Avoid → Eats → Avoid since is
  // the same status but a later choice, which Undo must leave alone.
  // The server may have written the mark at a later revision than it asked for (W029): `sentRev`.
  if (now && (now.status !== setTo
    || (typeof token.markRev === "number" && now.rev !== token.markRev && now.sentRev !== token.markRev))) {
    throw new Error(`${name} has changed since, so Undo left it alone.`);
  }
  await setFoodMembership(name, token.previous?.status ?? null,
    { note: null, account: h });
  assertCurrent(h);
  const localPrevious = token.localPrevious
    ?? (token.previous
      ? { status: token.previous.status, note: token.previous.note }
      : null);
  if (token.localId && localPrevious) {
    setFoodStatus(token.localId, localPrevious.status);
  }
  if (token.appliedNote !== undefined && token.previous?.status) {
    try {
      await saveFoodNoteForRef(token.foodRefId, token.previous.note, h, undefined,
        token.appliedNote);
      if (token.localId && localPrevious) setFoodNote(token.localId, localPrevious.note ?? "");
    } catch (cause) {
      throw new Error("List change undone, but the earlier note could not be restored. Try again.",
        { cause });
    }
  } else if (token.localId && localPrevious) {
    if (localPrevious.note === null) setFoodNote(token.localId, "");
    else setFoodNote(token.localId, localPrevious.note);
  }
}

export const undoAvoidMark = undoFoodListMark;
