/**
 * The policy marks a drained log write comes back with (audit 2026-10-10 A033).
 *
 * A commit that reached the server online puts its `flagged` marks on the card when it settles
 * (lib/log-commit-settle.ts `reconcileEntry`). A commit that went to the outbox instead used to
 * get none: /api/sync/ops now answers the same marks, and this puts them on the card the same way —
 * added to the marks the card has, never clearing one.
 */
import { assertCurrent, type AccountHandle } from "@/lib/device/account";
import { cardFor, findCard, placeCard } from "@/lib/log/card-find";
import { flagName } from "@/lib/log-commit-settle";
import { loadStore } from "@/lib/store";

export function markDrainedFlags(
  h: AccountHandle, entryId: string, date: unknown,
  flagged: readonly { message: string }[] | undefined,
): void {
  if (!Array.isArray(flagged) || flagged.length === 0) return;
  assertCurrent(h);
  const days = loadStore().days;
  // An update op (a note) may carry no date: the card is wherever it is.
  const found = typeof date === "string" ? cardFor(days, entryId, date) : findCard(days, entryId);
  if (!found) return;
  const names = flagged.map((flag) => flagName(flag.message));
  const flags = [...new Set([...(found.card.flags ?? []), ...names])];
  if (flags.length === (found.card.flags ?? []).length) return;
  placeCard(found, found.date, { flags });
}
