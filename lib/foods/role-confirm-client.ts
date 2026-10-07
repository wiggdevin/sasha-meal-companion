"use client";

/**
 * The one explicit tap that saves a food's macro group (PR #368). The coach may only PROPOSE a role
 * (`roleAdvice.requiresConfirmation`); this module sends the user's yes to
 * `POST /api/foods/role/confirm`.
 *
 * The route compares against the SERVER's `user_food_prefs` row and refuses a food that is not in
 * Eats or Avoids, so the membership the same coach action queued must have reached the server
 * first. That op sits in the outbox until a sync pass sends it; this module pushes it (at most two
 * passes, as `flushOutboxNow` does for settings) and only then posts. A membership still queued is
 * an answer of its own (`not_synced`), never a request the server would refuse.
 */

import {
  accountFetch, accountHandle, accountJson, assertCurrent, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import { normalizeFoodName } from "@/lib/foods/normalize";
import { currentPrefStatus } from "@/lib/foods/prefs-client";
import { syncOnce } from "@/lib/sync/client";
import { allOps, type OutboxOp } from "@/lib/sync/idb";
import type { CoachAction } from "@/lib/coach/actions";

export type StoredRole = "protein" | "carb" | "fat";

/** What the confirm needs from a coach action, or null when it must not be offered. */
export type RoleConfirmOffer = {
  foodRefId: string;
  name: string;
  proposedRole: StoredRole;
  currentRole: StoredRole | null;
  reason: string | null;
};

/** The state the server holds now, read again after a 409. */
export type FreshFoodRole = { status: "eats" | "avoid"; role: StoredRole | null } | null;

/**
 * Every refusal carries the food as this phone now reads it, so a retry never sends a stale
 * `currentRole`. `changed`: 409 role_changed. `not_member`: 404 (no preference row on the server)
 * or 409 membership_required. `not_synced`: the membership op is still queued; nothing was posted.
 */
export type RoleConfirmResult =
  | { status: "saved" | "unchanged"; role: StoredRole }
  | { status: "changed"; fresh: FreshFoodRole }
  | { status: "not_member"; code: "no_preference" | "membership_required"; fresh: FreshFoodRole }
  | { status: "not_synced"; fresh: FreshFoodRole };

export type RoleConfirmDeps = {
  account?: AccountHandle;
  fetchImpl?: typeof fetch;
  /** Test seams; default to the real sync pass, outbox read and local mirror read. */
  sync?: (h: AccountHandle) => Promise<unknown>;
  readOps?: (h: AccountHandle) => Promise<OutboxOp[]>;
  readFresh?: (foodRefId: string, h: AccountHandle) => Promise<FreshFoodRole>;
};

const ROLES = new Set<string>(["protein", "carb", "fat"]);
const isRole = (value: unknown): value is StoredRole => typeof value === "string" && ROLES.has(value);

/** The confirm shows only for an Eats/Avoid action whose advice asks for it and names a role. */
export function roleConfirmOffer(action: CoachAction): RoleConfirmOffer | null {
  if (action.kind !== "add_to_eats" && action.kind !== "add_to_avoid") return null;
  const advice = action.roleAdvice;
  if (!advice || advice.requiresConfirmation !== true || !isRole(advice.proposedRole)) return null;
  if (advice.foodRefId !== action.foodRefId) return null;
  return {
    foodRefId: advice.foodRefId,
    name: action.name,
    proposedRole: advice.proposedRole,
    currentRole: isRole(advice.currentRole) ? advice.currentRole : null,
    reason: advice.reason ?? null,
  };
}

/** True when an op for this food's membership (or its pref row) is still waiting in the outbox. */
function membershipQueued(ops: readonly OutboxOp[], name: string, foodRefId: string): boolean {
  const nameNorm = normalizeFoodName(name);
  return ops.some((op) => {
    if (op.entity === "user_food_prefs") return op.entity_id === foodRefId;
    if (op.entity !== "food_membership") return false;
    const payload = op.payload as { name_norm?: unknown } | null;
    return payload?.name_norm === nameNorm;
  });
}

/**
 * Wait until this food's membership has left the outbox. Never throws: offline or a failed pass
 * leaves the op queued, and that is the answer.
 */
export async function waitForMembershipSync(
  h: AccountHandle, name: string, foodRefId: string, deps: RoleConfirmDeps = {},
): Promise<boolean> {
  const sync = deps.sync ?? ((handle: AccountHandle) => syncOnce(handle));
  const readOps = deps.readOps ?? allOps;
  try {
    const queued = async () => membershipQueued(await readOps(h), name, foodRefId);
    if (!await queued()) return true;
    await sync(h);
    // A pass already running when the op was queued pushed the outbox it had read; one more sends it.
    if (await queued()) await sync(h);
    return !await queued();
  } catch {
    return false;
  }
}

async function defaultFresh(foodRefId: string, h: AccountHandle): Promise<FreshFoodRole> {
  const pref = await currentPrefStatus(foodRefId, h);
  if (!pref) return null;
  return { status: pref.status, role: isRole(pref.role) ? pref.role : null };
}

/**
 * Save the proposed role after the user's explicit yes. Resolves with the outcome the UI shows;
 * rejects only on a transport failure or an unexpected server answer.
 */
export async function confirmFoodRole(
  offer: Pick<RoleConfirmOffer, "foodRefId" | "name" | "proposedRole" | "currentRole">,
  deps: RoleConfirmDeps = {},
): Promise<RoleConfirmResult> {
  const h = deps.account ?? accountHandle();
  const sync = deps.sync ?? ((handle: AccountHandle) => syncOnce(handle));
  const reread = async (pull: boolean): Promise<FreshFoodRole> => {
    // Pull the server's row into the mirror first when the server refused; then read the mirror.
    if (pull) { try { await sync(h); } catch (e) { rethrowAccountChanged(e); } }
    assertCurrent(h);
    const fresh = await (deps.readFresh ?? defaultFresh)(offer.foodRefId, h);
    assertCurrent(h);
    return fresh;
  };
  if (!await waitForMembershipSync(h, offer.name, offer.foodRefId, deps)) {
    assertCurrent(h);
    return { status: "not_synced", fresh: await reread(false) };
  }
  assertCurrent(h);
  const res = await accountFetch(h, "/api/foods/role/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      foodRefId: offer.foodRefId,
      proposedRole: offer.proposedRole,
      currentRole: offer.currentRole,
      requiresConfirmation: true,
    }),
  }, { budget: "prefs", ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  type Body = { status?: unknown; role?: unknown; error?: unknown };
  const body = await accountJson<Body>(h, res).catch((e: unknown): Body => {
    rethrowAccountChanged(e);
    return {};
  });
  if (res.ok) {
    if ((body.status !== "persisted" && body.status !== "unchanged") || !isRole(body.role)) {
      throw new Error("The food group answer was malformed.");
    }
    // Bring the server's row into this phone's mirror; the tap has already been confirmed.
    void Promise.resolve().then(() => sync(h)).catch(() => undefined);
    return { status: body.status === "persisted" ? "saved" : "unchanged", role: body.role };
  }
  if (res.status === 404) {
    return { status: "not_member", code: "no_preference", fresh: await reread(true) };
  }
  if (res.status === 409 && body.error === "membership_required") {
    return { status: "not_member", code: "membership_required", fresh: await reread(true) };
  }
  if (res.status === 409 && body.error === "role_changed") {
    return { status: "changed", fresh: await reread(true) };
  }
  throw new Error(`Could not save the food group (${res.status}).`);
}
