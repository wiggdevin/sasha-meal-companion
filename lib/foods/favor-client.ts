"use client";

/**
 * Client for `POST /api/foods/favor` (app/api/foods/favor/route.ts, Phase 18 D6): one tap on
 * "Eaten often" marks that food Favored (`user_food_prefs.status = 'eats'`). The server writes the
 * mark; this phone learns it on the next sync pull, which the caller starts.
 *
 * Every answer becomes one outcome the section can show. Nothing here throws except an account
 * change mid-flight, which the caller drops.
 */
import { AccountChanged, accountFetch, accountHandle, accountJson, type AccountHandle } from "@/lib/device/account";
import { targetDayFor } from "@/lib/targets/revision";

export type FavorOutcome =
  /** 200: written. `rulesRevision` is the constraint revision the server judged under. */
  | { status: "favored"; rulesRevision: number | null }
  /** 404 unknown_key: the food left the eaten history; re-read the list. */
  | { status: "gone" }
  /** 409 rule_review_required: the account's rules need review first. */
  | { status: "rule_review" }
  /** 409 rules_changed or membership_changed: nothing was written; re-read and offer again. */
  | { status: "changed" }
  /** 422 nothing_to_favor: the food is on Avoid or its rules block it. */
  | { status: "blocked" }
  /** 429 rate_limited. */
  | { status: "busy" }
  /** 400, 401, 413, 503, any other status, offline or a timeout. */
  | { status: "failed" };

/** What the section says for each outcome that needs words (none for favored, gone or changed's re-read). */
export const FAVOR_COPY = {
  favored: "Added to your usual foods.",
  blocked: "Can't add this one; your rules or Avoid list cover it.",
  changed: "Your food rules or foods changed. Check the list and try again.",
  busy: "Too many tries. Wait a minute, then try again.",
  failed: "Couldn't add it right now. Try again later.",
} as const;

async function errorCode(h: AccountHandle, res: Response): Promise<unknown> {
  const body = await accountJson<{ error?: unknown }>(h, res).catch((e) => {
    if (e instanceof AccountChanged) throw e;
    return null;
  });
  return body?.error;
}

export async function favorTasteKey(
  key: string, opts: { account?: AccountHandle; fetchImpl?: typeof fetch } = {},
): Promise<FavorOutcome> {
  const h = opts.account ?? accountHandle();
  let res: Response;
  try {
    res = await accountFetch(h, `/api/foods/favor?date=${targetDayFor()}`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    }, { budget: "commit", fetchImpl: opts.fetchImpl });
  } catch (e) {
    if (e instanceof AccountChanged) throw e;
    return { status: "failed" };
  }
  if (res.ok) {
    const body = await accountJson<{ favored?: unknown; rulesRevision?: unknown }>(h, res).catch((e) => {
      if (e instanceof AccountChanged) throw e;
      return null;
    });
    // A 200 is a write that happened, even if its body cannot be read: never report it as failed.
    const revision = body?.rulesRevision;
    return { status: "favored", rulesRevision: typeof revision === "number" && Number.isFinite(revision) ? revision : null };
  }
  switch (res.status) {
    case 404: return (await errorCode(h, res)) === "unknown_key" ? { status: "gone" } : { status: "failed" };
    case 409: {
      const code = await errorCode(h, res);
      if (code === "rule_review_required") return { status: "rule_review" };
      return code === "rules_changed" || code === "membership_changed" ? { status: "changed" } : { status: "failed" };
    }
    case 422: return (await errorCode(h, res)) === "nothing_to_favor" ? { status: "blocked" } : { status: "failed" };
    case 429: return { status: "busy" };
    default: return { status: "failed" };
  }
}
