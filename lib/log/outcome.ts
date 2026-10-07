/**
 * What a commit's answer means for the entry the user just tried to log — the sheet's half of the
 * verdict, where `lib/log-commit-settle.ts` holds the mirror's.
 *
 * Its own file so lib/log-commit-client.ts stays under 400 lines; `flagName` and the result type
 * come from the two modules it sits between, and the type import is erased, so nothing here makes
 * a runtime cycle.
 */
import { flagName } from "@/lib/log-commit-settle";
import type { CommitResult } from "@/lib/log-commit-client";

/**
 * What a commit result means for the entry the user just tried to log — a rejected or blocked commit
 * must never sit in their log as a silent phantom (audit 2026-09-13 #6). `ok` and `queued` are both
 * "keep it", exactly as the offline-first design promises; anything else is a real refusal the user
 * has to see.
 *
 * Since the 2026-09-14 ruling an off-plan food is no longer one of those refusals — it is kept and
 * marked. `invalid` now means the request itself could not be used (a malformed label, an unknown
 * food ref), not "you may not eat that".
 */
export type CommitOutcome = { keep: boolean; message: string | null };

export function outcomeFor(result: CommitResult): CommitOutcome {
  if (result.status === "ok") {
    // Kept either way — the log marks, it never refuses (2026-09-14 ruling). But a mark the user is
    // not shown is not a mark, so an off-plan line says so while the entry stays.
    //
    // sol FIX (review round 2): an `unverified` allergen (no_evidence — §5's own "shows a 'Check
    // the label' mark" requirement) is not the same claim as `blocked` ("off-plan for your
    // rules") — a food nobody has flagged as wrong yet must never read that way. Split on the
    // message's own prefix (`lib/coach/log-policy.ts`'s two shapes) and say each in its own words.
    const flagged = result.flagged ?? [];
    if (flagged.length === 0) return { keep: true, message: null };
    const blocked = [...new Set(
      flagged.filter((f) => f.message.startsWith("blocked:")).map((f) => flagName(f.message)))];
    const unverified = [...new Set(
      flagged.filter((f) => f.message.startsWith("unverified:")).map((f) => flagName(f.message)))];
    const parts: string[] = [];
    if (blocked.length > 0) parts.push(`marked off-plan for your rules: ${blocked.join(", ")}`);
    if (unverified.length > 0) parts.push(`needs a label check for ${unverified.join(", ")}`);
    return { keep: true, message: `Logged, and ${parts.join("; ")}.` };
  }
  if (result.status === "queued") return { keep: true, message: null };
  // Posted with nothing queued behind it. The POST may well have landed, and the record is what
  // the catch-up reads the server about — so the card stays and the user is never told to try again
  // over a meal the server may already hold (Grok pass 16, HIGH 1).
  if (result.status === "unqueued") {
    return { keep: true, message: "Logged. It will catch up when you are back online." };
  }
  // The server answered and its answer could not be read. Not "logged" — nobody knows yet — and
  // not a refusal either, because nothing was taken back (Grok pass 26, HIGH 1).
  if (result.status === "unsettled") {
    return { keep: true, message: "Still saving. It will settle on the next sync." };
  }
  // The user deleted this entry while it was saving, and that has been honoured: the card is off the
  // day and nothing is queued. A sheet that keeps it here adds the meal back (Grok pass 15).
  if (result.status === "discarded") {
    return { keep: false, message: "Removed. That one is not in your log." };
  }
  // Another tab has the entry: this one wrote nothing, so there is no card of its own to keep and
  // nothing to close as if it had saved (Grok pass 10, MEDIUM 1).
  if (result.status === "owned_elsewhere") {
    return { keep: false, message: "Another tab is saving this. It will show after sync." };
  }
  if (result.status === "refused") {
    return { keep: false, message: "The server would not take that one. Try again." };
  }
  // A 2xx the client could not read, and a conflict, are both "the server has it". Saying
  // otherwise beside a card that is staying would be a lie about their own log.
  if (result.status === "accepted") {
    return { keep: true, message: "Logged. The details will catch up in a moment." };
  }
  if (result.status === "conflict") {
    return { keep: true, message: "Logged. Another device had already changed this one." };
  }
  if (result.status === "invalid") {
    return { keep: false, message: "That food could not be logged as sent." };
  }
  return { keep: false, message: "Could not log that. Try again." };
}

/** What a sheet does about a result: close as saved, or stay open and say why. */
export type SaveResult = { ok: true } | { ok: false; message: string };

/**
 * The verdict in the shape a confirm sheet needs.
 *
 * Every sheet used to name the statuses it counted as success, and every one of them named `ok`
 * and `queued` only — so a 2xx whose body could not be read, and a conflict that handed back the
 * entry, were shown as failures over cards that were staying. The draft stayed open and the next
 * Save minted a second entry: two meals for one tap (Grok pass 11, HIGH 1).
 *
 * `stale_revision` keeps the words that path has always used; everything else takes the verdict's
 * own message, and a refusal with nothing to say gets the plain one.
 */
export function savedFrom(result: CommitResult): SaveResult {
  const outcome = outcomeFor(result);
  if (outcome.keep) return { ok: true };
  if (result.status === "stale_revision") {
    return { ok: false, message: "That food was updated. Log it from search." };
  }
  return { ok: false, message: outcome.message ?? "That did not save. Try again." };
}
