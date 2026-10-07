/**
 * The browser half of the constraint profile — spec "API changes", architecture §3.6, §3.7.
 *
 * `PUT /api/constraints` with a baseRev compare-and-swap is the only write path
 * (constraint_profiles is not outbox-synced), so offline every control is disabled rather
 * than queued. Kept out of the component so both halves are testable without a DOM.
 */

import type { ConstraintsPut } from "@/lib/coach/types";
import type { CustomRule } from "@/lib/policy/custom-rules";
import {
  accountHandle, rethrowAccountChanged, accountFetch, accountJson, type AccountHandle,
} from "@/lib/device/account";
import { noteFoodRulesChanged, noteRulesRevision } from "@/lib/foods/rules-epoch";

/** Every call runs for one account (Phase 9 §0.5a); a delayed caller passes the one it began as. */
type AccountOpts = { fetchImpl?: typeof fetch; account?: AccountHandle };

export type Profile = {
  avoid_allergens: string[]; avoid_food_ref_ids: string[]; banned_categories: string[];
  conditions: string[]; notes: string | null;
  custom_rules?: CustomRule[];
};

export type SaveResult =
  | { status: "conflict"; profile: Profile; rev: number }
  | { status: "error"; message: string }
  | { status: "ok"; profile: Profile; rev: number };

/** `null` means the profile did not load; the card says so and the controls stay off. */
export async function loadConstraints(
  opts: AccountOpts = {},
): Promise<{ profile: Profile; rev: number } | null> {
  const h = opts.account ?? accountHandle();
  try {
    const res = await accountFetch(h, "/api/constraints", {}, { fetchImpl: opts.fetchImpl });
    if (!res.ok) return null;
    const body = await accountJson<{ profile?: Profile; rev?: number }>(h, res);
    if (!body.profile || body.rev === undefined) return null;
    // A revision moved elsewhere (another device) is a rules change this phone has not seen (F3).
    noteRulesRevision(body.rev, h.userId);
    return { profile: body.profile, rev: body.rev };
  } catch (e) {
    rethrowAccountChanged(e);
    return null;
  }
}

/**
 * Pure fetch wrapper for a constraints PUT, split out of the component so a dropped connection
 * (fetch() itself throwing, not just a non-ok response) is caught and reported the same way the
 * sibling write path (lib/log-client.ts's commitLogEntry) handles it, instead of surfacing as an
 * unhandled rejection with no status message.
 */
export async function saveConstraints(
  patch: ConstraintsPut,
  rev: number,
  opts: AccountOpts = {},
): Promise<SaveResult> {
  const h = opts.account ?? accountHandle();
  try {
    const res = await accountFetch(h, "/api/constraints", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...patch, baseRev: rev }),
    }, { fetchImpl: opts.fetchImpl });
    const body = await accountJson<{
      status?: string; profile?: Profile; rev?: number; value?: Profile;
      current_rev?: number; error?: string; message?: string;
    }>(h, res);
    if (res.status === 409 && body.value && body.current_rev !== undefined) {
      // Another writer moved the rules; any set verified before it is stale too (F3).
      noteFoodRulesChanged(body.current_rev, h.userId);
      return { status: "conflict", profile: body.value, rev: body.current_rev };
    }
    if (res.status === 409) noteFoodRulesChanged(undefined, h.userId);
    if (res.status === 409 && body.error === "rule_review_required") {
      return { status: "error", message: "Review the older food rules above before removing one." };
    }
    if (!res.ok || !body.profile || body.rev === undefined) {
      return { status: "error", message: "Could not save." };
    }
    noteFoodRulesChanged(body.rev, h.userId);
    return { status: "ok", profile: body.profile, rev: body.rev };
  } catch (e) {
    rethrowAccountChanged(e);
    return { status: "error", message: "Could not save. Try again." };
  }
}
