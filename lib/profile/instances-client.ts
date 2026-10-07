"use client";

/**
 * Phase 13 slice 4 (§4, §9 R5): the client half of app/api/profile/instances — onboarding's
 * profile picker and the chat confirm card both write through this module, never a direct
 * Supabase call. `accountFetch` is, per lib/device/account.ts, "the only way client code calls an
 * app `/api/` route": it binds the request to the currently-bound account and refuses a stale one.
 *
 * A direct, online write rather than an outbox op (contrast lib/foods/prefs-client.ts): a
 * confirmation is a deliberate, infrequent, explicitly-tapped action, not a high-frequency local
 * write that needs to survive offline. The follow-up, if this account ever needs to confirm a
 * profile while offline, is queuing it the same way lib/foods/prefs-client.ts queues a mark.
 */
import { accountFetch, accountJson, type AccountHandle } from "@/lib/device/account";
import type { ProfileSummary } from "@/lib/policy/profiles/catalog-summary";
import type { ProfileInstance } from "@/lib/policy/profiles/types";
import { noteFoodRulesChanged, noteRulesSignature } from "@/lib/foods/rules-epoch";

const ROUTE = "/api/profile/instances";

export type FacetConfirmation = { facet: string; confirmed: boolean };

async function readOk<T>(h: AccountHandle, res: Response): Promise<T> {
  // A conflict means another writer moved this account's profile rules (F3).
  if (res.status === 409) noteFoodRulesChanged(undefined, h.userId);
  if (!res.ok) {
    const body = await accountJson<{ message?: string }>(h, res).catch(() => ({ message: undefined }));
    throw new Error(body.message ?? `${ROUTE} answered ${res.status}`);
  }
  return accountJson<T>(h, res);
}

/** The account's full merged instance set plus the catalog's plain-language summaries. */
export async function fetchProfileInstances(
  h: AccountHandle,
): Promise<{ instances: ProfileInstance[]; catalog: ProfileSummary[]; legacyProfileIds: string[] }> {
  const res = await accountFetch(h, ROUTE, { method: "GET" });
  const body = await readOk<{ instances: ProfileInstance[]; catalog: ProfileSummary[];
    legacyProfileIds: string[] }>(h, res);
  // Profile rules carry no constraint revision: a changed set seen here (a confirm on another
  // device) is a rules change, exactly like a moved revision (F3).
  if (Array.isArray(body?.instances)) {
    noteRulesSignature("profile-instances", instancesSignature(body.instances), h.userId);
  }
  return body;
}

/** Order-independent: the same stored instances always give the same signature. */
function instancesSignature(instances: readonly ProfileInstance[]): string {
  return JSON.stringify(instances.map((instance) => JSON.stringify(instance)).sort());
}

/**
 * Confirms exactly the facets named — never the whole profile by implication. A
 * `user_confirmed_safety` (medical) facet stays unconfirmed unless its own id is in
 * `confirmations` with `confirmed: true` (R5: one at a time, never a blanket "yes").
 */
export async function confirmProfileInstance(
  h: AccountHandle, profileId: string, confirmations: readonly FacetConfirmation[],
  options?: Readonly<Record<string, boolean>>,
): Promise<ProfileInstance> {
  const res = await accountFetch(h, ROUTE, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId, confirmations, ...(options ? { options } : {}) }),
  });
  const { instance } = await readOk<{ instance: ProfileInstance }>(h, res);
  noteFoodRulesChanged(undefined, h.userId);
  return instance;
}

/**
 * Phase 13 slice 7: a like or dislike the user tapped "Yes" on. Soft only — the route stores it
 * as a `prefer`/`avoid` rule under the shared food-preference profile, which can rank a
 * suggestion and never block one.
 */
export async function confirmFoodPreference(
  h: AccountHandle, foodName: string, strength: "prefer" | "avoid",
): Promise<ProfileInstance> {
  const res = await accountFetch(h, ROUTE, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ foodPreference: { foodName, strength, confirmed: true } }),
  });
  const { instance } = await readOk<{ instance: ProfileInstance }>(h, res);
  // Soft today (it ranks, never blocks), but it is a rule write: no set outlives it.
  noteFoodRulesChanged(undefined, h.userId);
  return instance;
}

export async function removeProfileInstance(h: AccountHandle, profileId: string): Promise<void> {
  const res = await accountFetch(h, `${ROUTE}?profileId=${encodeURIComponent(profileId)}`,
    { method: "DELETE" });
  await readOk(h, res);
  noteFoodRulesChanged(undefined, h.userId);
}
