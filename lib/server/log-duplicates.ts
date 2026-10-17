/**
 * Duplicate-group recording for the commit path. Moved out of lib/server/log.ts unchanged
 * (T9 §2): it is best-effort, it is the only caller of entryFingerprint, and log.ts is a file
 * about writing an entry, not about noticing one was written twice.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LogCommitRequest } from "@/lib/log/contract";
import { toBytea } from "@/lib/server/tokens";
import { entryFingerprint } from "@/lib/sync/fingerprint";

/**
 * Finding #47 (2026-09-13 audit): entryFingerprint/fingerprintSource (lib/sync/fingerprint.ts,
 * contracts §4.1) existed but nothing ever called them at commit time, so a double-logged meal
 * never opened a duplicate_groups row. Runs once for every genuinely NEW entry — never on an
 * idempotent `duplicate` replay of the SAME entry_id, which is not a second logging event.
 * Finds the open group for this fingerprint (one row per distinct fingerprint per user, via the
 * table's `unique (user_id, fingerprint)` constraint) or opens one, then adds this entry as a
 * member; a second member on the same group is what makes a duplicate detectable later.
 *
 * OD16 cross-device sync: the group row is inserted directly, which writes no `change_log` row, so
 * on its own it never reaches a phone's change feed. When the group gets its second member and is
 * still open, it is touched through `apply_sync_op` (an update at its current rev, the same
 * payload the phone's own Keep both / Merge ops carry), which writes the feed row every device
 * pulls into its `duplicate_groups` mirror. The phone's "Logged twice?" card
 * (components/today/DuplicateEntryCard.tsx, lib/duplicates/*) reads the group from that mirror.
 * A group with one member stays off the feed, so an ordinary log adds no feed traffic and no
 * extra read. A third copy does not touch it again, so it cannot race a Keep both the phone has
 * queued offline back to `open`.
 *
 * Best-effort like `deleteCommittedMedia` in `lib/server/log.ts`, which runs beside it: the entry
 * itself already committed, so a failure recording its fingerprint is logged, never thrown back.
 */
export async function recordFingerprint(
  client: SupabaseClient, userId: string, req: LogCommitRequest
): Promise<void> {
  try {
    const hex = await entryFingerprint({
      localDate: req.local_date, slot: req.slot, eatenAt: req.eaten_at,
      // Lowercase, as Postgres stores the uuid: the phone hashes the mirrored row's form.
      items: req.items.map((i) => ({ canonicalFoodId: i.food_ref_id.toLowerCase(), grams: i.grams,
        qty: i.qty, unit: i.unit })),
    });
    const fingerprint = toBytea(Buffer.from(hex, "hex"));
    const existing = await client.from("duplicate_groups").select("id, local_date, slot, state, rev")
      .eq("fingerprint", fingerprint).maybeSingle();
    if (existing.error) throw existing.error;
    const group = existing.data as GroupRow | null;
    let groupId = group?.id ?? null;
    if (!groupId) {
      const created = await client.from("duplicate_groups").insert({
        user_id: userId, local_date: req.local_date, fingerprint, slot: req.slot,
      }).select("id").single();
      if (created.error || !created.data) {
        throw created.error ?? new Error("could not open a duplicate group");
      }
      groupId = (created.data as { id: string }).id;
    }
    const { error } = await client.from("duplicate_group_members")
      .insert({ group_id: groupId, entry_id: req.entry_id });
    if (error) throw error;
    // A group opened just now holds this entry alone: nothing to publish, no extra read.
    if (group) await publishWhenDuplicated(client, userId, group, hex);
  } catch (e) {
    console.error("duplicate-fingerprint recording failed", { entry_id: req.entry_id, error: e });
  }
}

type GroupRow = { id: string; local_date: string; slot: string; state: string; rev: number };

/** Publish exactly when the second member arrives; the phone works out which are still live. */
async function publishWhenDuplicated(
  client: SupabaseClient, userId: string, group: GroupRow, hex: string,
): Promise<void> {
  // A decided group stays decided: Keep both or Merge is the user's word on it.
  if (group.state !== "open") return;
  const members = await client.from("duplicate_group_members").select("entry_id")
    .eq("group_id", group.id).limit(3);
  if (members.error) throw members.error;
  if ((members.data ?? []).length !== 2) return;
  const groupId = group.id.toLowerCase();
  const { data, error } = await client.rpc("apply_sync_op", { p_user_id: userId, p_op: {
    op_id: crypto.randomUUID(), entity: "duplicate_groups", entity_id: groupId,
    kind: "update", base_rev: Number(group.rev), client_ts: new Date().toISOString(),
    payload: { id: groupId, local_date: String(group.local_date).slice(0, 10),
      fingerprint: hex, slot: group.slot, state: "open", merged_into_entry_id: null, decided_at: null },
  } });
  if (error) throw error;
  const status = (data as { status?: string } | null)?.status;
  // A conflict means another write moved the group first, and that write is on the feed already.
  if (status !== "applied" && status !== "conflict") {
    throw new Error(`duplicate group publish answered ${status ?? "nothing"}`);
  }
}
