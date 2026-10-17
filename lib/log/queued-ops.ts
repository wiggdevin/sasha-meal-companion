/**
 * What the outbox still holds for one log entry. Split out of lib/log-commit-settle.ts (W027) so
 * that module stays under the house rule; it re-exports all three.
 */
import { rethrowAccountChanged, type AccountHandle } from "@/lib/device/account";
import { allOps, deleteOp } from "@/lib/sync/idb";

/**
 * Is one of THEIR writes still queued for this entry — a note, an edit?
 *
 * While one is, the local fields it owns are theirs and not the server's: a read-back that wrote the
 * row's empty note over the line the user had just typed took it off the card while the write that
 * would have sent it was still waiting (Grok pass 27, HIGH 2).
 */
export async function ownWriteQueued(h: AccountHandle, entryId: string): Promise<boolean> {
  try {
    return (await allOps(h)).some((op) =>
      op.entity === "log_entries" && op.entity_id === entryId && op.kind === "update");
  } catch (e) { rethrowAccountChanged(e);
    return false;
  }
}

/**
 * EVERY outbox op still waiting for this entry. Only their delete means this: the entry is going,
 * so the note and the edit behind it are going too.
 */
export async function dropQueuedOps(h: AccountHandle, entryId: string): Promise<void> {
  try {
    const ops = await allOps(h);
    for (const op of ops) {
      if (op.entity === "log_entries" && op.entity_id === entryId) await deleteOp(h, op.op_id);
    }
  } catch (e) { rethrowAccountChanged(e); console.warn("Could not clear the queued ops for a committed entry."); }
}

/**
 * Is an outbox op still waiting to send this entry? What a drain would settle on its own.
 *
 * An outbox that cannot be read at all answers neither: `"unknown"`. A caller deciding whether to
 * POST again waits for a pass that can read it rather than sending a write the drain may already
 * hold (Grok pass 23, LOW 3) — a pause, not the permanent verdict panel round 18 warned about,
 * because the record stays and the next pass asks again.
 */
export async function hasQueuedOp(h: AccountHandle, entryId: string): Promise<boolean | "unknown"> {
  try {
    return (await allOps(h)).some((o) => o.entity === "log_entries" && o.entity_id === entryId);
  } catch (e) { rethrowAccountChanged(e);
    return "unknown";
  }
}
