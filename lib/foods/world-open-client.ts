"use client";
/**
 * W13 (D14): "New accounts become open at onboarding completion" — made durable.
 *
 * Sol round 2 BLOCK: the open call used to be fire-once. A 503, a 409 `profile_required` (the
 * onboarding row not on the server yet), a timeout or a failed flush was swallowed, and the
 * first-completion gate (`!base.onboardedAt`) never fires again once the stamp syncs, so the
 * account stayed closed for good.
 *
 * Now onboarding records an account-scoped pending intent in this account's META store BEFORE
 * any network call, then tries once. Every successful sync pass (`catchUpAfterSync`,
 * lib/sync/post-sync.ts) re-posts `POST /api/foods/world { world: "open" }` while the intent
 * exists. The intent clears only on an answer that settles it:
 * - 200 `{ world: "open" }`: done.
 * - 200 `{ world: "closed" }`: the account already decided (the server's no-op answer to a late
 *   default); the intent clears.
 * - 423 `held` / `open_world_not_released`: the account stays closed by policy; the invitation
 *   (`GET /api/foods/world/invitation`) offers it later.
 * - 409 `condition_review`: a person must confirm conditions; the invitation flow owns that.
 * - any other 4xx a retry cannot change (logged once, by status only).
 * Kept for the next pass: 5xx, 401, 408, 425, 429, 409 `profile_required`, a 200 body that names
 * no world, a timeout or a network failure.
 *
 * The POST is idempotent (opening an open account is a no-op), so a retry is always safe. It also
 * carries `intent: "onboarding_default"`, which the server refuses once this account's
 * `food_world_set_at` is already set (lib/server/food-world.ts) -- a backend-side guarantee that a
 * pending retry can never reopen an account someone already decided about, by the default itself
 * or by a deliberate Settings choice, with no UI change required. `clearWorldOpenPending` stays
 * exported for Settings to call on an explicit choice too (it skips even the harmless no-op POST),
 * but nothing here depends on the UI lane remembering to call it.
 *
 * The intent is a retry driver only, never the starter-seed gate (Sol round 4 BLOCK): another
 * device cannot see it. Whether a device may seed the legacy starter is the server's answer
 * (`GET /api/foods/world` `starterSeed`), and a device that reads `openDefaultPending` takes the
 * intent over here (lib/foods/today-starter.ts), so the default still lands if the onboarding
 * device never comes back.
 */
import { accountFetch, accountJson, type AccountHandle } from "@/lib/device/account";
import { flushOutboxNow } from "@/lib/sync/client";
import { deleteMeta, getMeta, putMeta } from "@/lib/sync/idb";

export const WORLD_OPEN_PENDING_KEY = "food_world_open_pending";

type PendingRecord = { since: string };

export type WorldOpenOutcome = "opened" | "settled" | "retry" | "none";

const RETRY_STATUSES = new Set([401, 408, 425, 429]);

const inFlight = new Map<string, Promise<WorldOpenOutcome>>();

/** Records the intent. Durable: it survives a reload, a crash or a closed tab. */
export async function markWorldOpenPending(h: AccountHandle, now = new Date()): Promise<void> {
  await putMeta(h, WORLD_OPEN_PENDING_KEY, { since: now.toISOString() } satisfies PendingRecord);
}

export async function isWorldOpenPending(h: AccountHandle): Promise<boolean> {
  return (await getMeta<PendingRecord>(h, WORLD_OPEN_PENDING_KEY)) !== undefined;
}

/** For an explicit user choice of world (Settings switch): no pending retry may override it. */
export async function clearWorldOpenPending(h: AccountHandle): Promise<void> {
  await deleteMeta(h, WORLD_OPEN_PENDING_KEY);
}

async function errorCode(h: AccountHandle, res: Response): Promise<string | null> {
  try {
    const body = await accountJson<{ error?: unknown } | null>(h, res);
    return typeof body?.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

/** One POST; what the answer means for the intent. Throws only on a network failure. */
async function postOpen(h: AccountHandle): Promise<"opened" | "settled" | "retry"> {
  // `intent: "onboarding_default"` lets the server refuse this retry once the account already
  // made an explicit choice (its own backend-side guarantee, lib/server/food-world.ts) -- this
  // never depends on the Settings switch remembering to call `clearWorldOpenPending`.
  const res = await accountFetch(h, "/api/foods/world", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ world: "open", intent: "onboarding_default" }) }, { budget: "prefs" });
  if (res.ok) {
    try {
      const body = await accountJson<{ world?: unknown } | null>(h, res);
      // Sol round 3 WARN: the server answers a default that comes after a choice already made
      // (lib/server/food-world.ts, `food_world_set_at`) with 200 and that account's own world.
      // `closed` there means someone decided: settled, never retried forever.
      if (body?.world === "open") return "opened";
      return body?.world === "closed" ? "settled" : "retry";
    } catch {
      return "retry";
    }
  }
  if (res.status >= 500 || RETRY_STATUSES.has(res.status)) return "retry";
  if (res.status === 423) return "settled";
  if (res.status === 409) return (await errorCode(h, res)) === "condition_review" ? "settled" : "retry";
  console.warn(`food world open: settled on HTTP ${res.status}`);
  return "settled";
}

/**
 * Posts the open intent if one is pending. Never throws; one run per account at a time. Returns
 * `none` with no intent, `opened` / `settled` when the intent was cleared, `retry` when it stays.
 */
export function drainWorldOpenPending(h: AccountHandle): Promise<WorldOpenOutcome> {
  const running = inFlight.get(h.userId);
  if (running) return running;
  const run = (async (): Promise<WorldOpenOutcome> => {
    try {
      if (!await isWorldOpenPending(h)) return "none";
      const outcome = await postOpen(h);
      if (outcome !== "retry") await clearWorldOpenPending(h);
      return outcome;
    } catch {
      return "retry"; // offline, timed out, account changed: the intent stays for the next pass
    }
  })().finally(() => inFlight.delete(h.userId));
  inFlight.set(h.userId, run);
  return run;
}

/**
 * Onboarding's first completion (answered or skipped). Records the intent first, then flushes the
 * just-queued `user_settings` write (the POST updates an existing row and answers 409
 * `profile_required` without one) and tries once. Never throws and never blocks onboarding on
 * the answer: whatever does not settle now is retried after the next successful sync.
 */
export async function openFoodWorldAtOnboarding(h: AccountHandle): Promise<WorldOpenOutcome> {
  try {
    await markWorldOpenPending(h);
  } catch {
    // No IndexedDB on this device: still try once now; nothing else can hold the intent.
    try {
      if (!await flushOutboxNow(h)) return "retry";
      return await postOpen(h);
    } catch {
      return "retry";
    }
  }
  if (!await flushOutboxNow(h)) return "retry";
  return drainWorldOpenPending(h);
}

export type FoodWorldView = { world: "open" | "closed"; eligible: boolean };

/**
 * Settings and the invitation: this account's world, and whether it may be invited into the open
 * one. `null` when either read fails; the callers then show nothing (fail closed, never a guess).
 * `eligible` comes from the server's own allowlist, so a held account and an unreleased open world
 * read the same: not eligible.
 */
export async function readFoodWorldView(h: AccountHandle): Promise<FoodWorldView | null> {
  try {
    const [stateRes, inviteRes] = await Promise.all([
      accountFetch(h, "/api/foods/world", { cache: "no-store" }, { budget: "prefs" }),
      accountFetch(h, "/api/foods/world/invitation", { cache: "no-store" }, { budget: "prefs" }),
    ]);
    if (!stateRes.ok || !inviteRes.ok) return null;
    const state = await accountJson<{ world?: unknown } | null>(h, stateRes);
    const invite = await accountJson<{ eligible?: unknown } | null>(h, inviteRes);
    if (state?.world !== "open" && state?.world !== "closed") return null;
    return { world: state.world, eligible: invite?.eligible === true };
  } catch {
    return null;
  }
}

export type FoodWorldChoice =
  | { ok: true; world: "open" | "closed" }
  | { ok: false; reason: "condition_review" | "unavailable" | "retry" };

/**
 * A deliberate choice (Settings switch or the invitation's button). Sends no `intent`, so the
 * server always applies and restamps it, and clears any pending onboarding default first so a late
 * retry cannot override it. Opening is never forced: 423 and 409 come back as reasons.
 */
export async function chooseFoodWorld(h: AccountHandle, world: "open" | "closed"): Promise<FoodWorldChoice> {
  try {
    await clearWorldOpenPending(h);
    const res = await accountFetch(h, "/api/foods/world", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ world }) }, { budget: "prefs" });
    if (res.ok) {
      const body = await accountJson<{ world?: unknown } | null>(h, res);
      return body?.world === "open" || body?.world === "closed"
        ? { ok: true, world: body.world } : { ok: false, reason: "retry" };
    }
    if (res.status === 423) return { ok: false, reason: "unavailable" };
    if (res.status === 409) {
      return (await errorCode(h, res)) === "condition_review"
        ? { ok: false, reason: "condition_review" } : { ok: false, reason: "retry" };
    }
    return { ok: false, reason: "retry" };
  } catch {
    return { ok: false, reason: "retry" };
  }
}
