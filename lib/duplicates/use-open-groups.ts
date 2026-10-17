"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  currentAccountOrNull, isCurrent, onAccountGone, onAccountReady,
} from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { OUTBOX_QUEUED_EVENT } from "@/lib/sync/outbox";
import type { LoggedFood } from "@/lib/types";
import { isMergeHeld, MERGE_PENDING_EVENT } from "./actions";
import { readOpenDuplicateGroups, type OpenDuplicateGroup } from "./read";

/** A stable key for the day's cards, so a re-render with the same entries does not re-read. */
function extrasKey(extras: readonly LoggedFood[]): string {
  return extras.map((entry) => `${entry.id}@${entry.at}#${entry.rev ?? ""}`).join("|");
}

/**
 * The open duplicate groups of `date` for the bound account, less any merge held for its Undo.
 * Re-read after every sync pass, every queued write, every held merge and every change to the
 * day's entries; cleared the moment the account goes, so a
 * group of one account is never drawn under another.
 */
export function useOpenDuplicateGroups(date: string, extras: readonly LoggedFood[]) {
  const [groups, setGroups] = useState<OpenDuplicateGroup[]>([]);
  const latest = useRef(extras);
  // Declared before the reading effect, so a read always sees this render's entries.
  useEffect(() => { latest.current = extras; });
  const key = extrasKey(extras);
  /** Only the newest read may land: an older one (another date, an earlier pass) is dropped. */
  const generation = useRef(0);

  const read = useCallback(async () => {
    const mine = ++generation.current;
    const h = currentAccountOrNull();
    if (!h) { setGroups([]); return; }
    try {
      const next = await readOpenDuplicateGroups(h, date, latest.current);
      // A merge waiting out its Undo window is already the user's decision: its card is gone.
      if (mine === generation.current && isCurrent(h)) {
        setGroups(next.filter((open) => !isMergeHeld(h, open.group.id)));
      }
    } catch {
      // A mirror that cannot be read draws no card: both entries keep counting, as before.
      if (mine === generation.current && isCurrent(h)) setGroups([]);
    }
  }, [date]);

  useEffect(() => {
    let live = true;
    const run = () => { if (live) void read(); };
    run();
    globalThis.addEventListener?.(SYNCED_EVENT, run);
    globalThis.addEventListener?.(OUTBOX_QUEUED_EVENT, run);
    globalThis.addEventListener?.(MERGE_PENDING_EVENT, run);
    const gone = onAccountGone(() => { if (live) setGroups([]); });
    const ready = onAccountReady(() => run());
    return () => {
      live = false;
      globalThis.removeEventListener?.(SYNCED_EVENT, run);
      globalThis.removeEventListener?.(OUTBOX_QUEUED_EVENT, run);
      globalThis.removeEventListener?.(MERGE_PENDING_EVENT, run);
      gone();
      ready();
    };
  }, [read, key]);

  return { groups, reload: read } as const;
}
