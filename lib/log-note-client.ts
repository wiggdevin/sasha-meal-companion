/** Notes use the complete normalized entry: sync replaces the row and its items together. */
import { accountHandle, assertCurrent, type AccountHandle } from "@/lib/device/account";
import { withAccount } from "@/lib/device/account-supabase";
import { getDay, updateExtra } from "@/lib/store";
import { isCompleteEntryRow, serverFields } from "@/lib/log/entry-row";
import { canonicalNote } from "@/lib/log/note-text";
import { allOps, getRow } from "@/lib/sync/idb";
import { enqueueWithRow } from "@/lib/sync/outbox";
import { browserClient } from "@/lib/supabase/client";

const saves = new Map<string, Promise<void>>();

/** Phase 9 §0.3: drop the chains of the account that left. Its saves stop at their next check. */
export function resetNoteSaves(): void {
  saves.clear();
}

/** Serialize blur/close saves so each queued edit uses the preceding revision. */
export function saveExtraNote(date: string, id: string, text: string): Promise<void> {
  const h = accountHandle();
  const previous = saves.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => save(h, date, id, canonicalNote(text)));
  saves.set(id, next);
  void next.finally(() => { if (saves.get(id) === next) saves.delete(id); }).catch(() => {});
  return next;
}

async function save(h: AccountHandle, date: string, id: string, note: string): Promise<void> {
  const entry = getDay(date)?.extras?.find((extra) => extra.id === id);
  if (!entry || (entry.note ?? "") === note) return;
  const pending = (await allOps(h)).filter((op) => op.entity === "log_entries" && op.entity_id === id)
    .sort((a, b) => b.seq - a.seq)[0];
  let row = await getRow(h, "log_entries", id) as Record<string, unknown> | undefined;
  if (pending) {
    if (pending.kind === "delete") throw new Error("This entry has been removed.");
    row = { ...pending.payload, rev: (pending.base_rev ?? 0) + 1 };
  }
  if (!row && entry.items?.some((item) => !item.food_ref_id.startsWith("local:"))) {
    // Older online commits may predate the local mirror. RLS scopes this recovery read.
    const result = await withAccount(h, () => browserClient().from("log_entries")
      .select("*, items:log_items(*)").eq("id", id).maybeSingle());
    if (result.error || !result.data) throw new Error("Could not load the entry for editing.");
    row = result.data;
  }
  if (row) {
    // A revision is not enough: a mirrored reply can describe items too thinly to POST back.
    if (!isCompleteEntryRow(row)) throw new Error("The entry is not ready for editing.");
    const rev = row.rev as number;
    // Never the client's own keys: an optimistic row carries the attempt that wrote it, and a
    // payload is a `log_entries` write (Grok pass 10, HIGH 2).
    const payload = { ...serverFields(row), id, note: note || null };
    // The note this edit replaces: a conflict then keeps the user's clear or rewrite instead of
    // joining it to the very text they changed (audit 2026-10-10 A077).
    const base = typeof row.note === "string" ? canonicalNote(row.note) : "";
    await enqueueWithRow(h, { ...payload, rev: rev + 1 }, {
      op_id: crypto.randomUUID(), entity: "log_entries", entity_id: id,
      kind: "update", base_rev: rev, payload, client_ts: new Date().toISOString(),
      note_base: base || null,
    });
  }
  // Unbacked bundled/manual extras keep their established legacy persistence path.
  assertCurrent(h);
  updateExtra(date, id, { note: note || undefined });
}
