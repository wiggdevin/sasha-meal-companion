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
 * - 423 `held` / `open_world_not_released`: the account stays closed by policy; the invitation
 *   (`GET /api/foods/world/invitation`) offers it later.
 * - 409 `condition_review`: a person must confirm conditions; the invitation flow owns that.
 * - any other 4xx a retry cannot change (logged once, by status only).
 * Kept for the next pass: 5xx, 401, 408, 425, 429, 409 `profile_required`, a body that does not
 * say open, a timeout or a network failure.
 *
 * The POST is idempotent (opening an open account is a no-op), so a retry is always safe.
 * `clearWorldOpenPending` is for an explicit user choice in Settings (the UI lane wires it), so a
 * pending retry never overrides a person who chose `closed` on purpose.
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
  const res = await accountFetch(h, "/api/foods/world", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ world: "open" }) }, { budget: "prefs" });
  if (res.ok) {
    try {
      const body = await accountJson<{ world?: unknown } | null>(h, res);
      return body?.world === "open" ? "opened" : "retry";
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
