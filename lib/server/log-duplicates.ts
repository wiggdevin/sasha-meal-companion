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
 * member; a second member on the same group is what makes a duplicate detectable later. The phone's
 * "Logged twice?" card (components/today/DuplicateEntryCard.tsx, lib/duplicates/*) reads the group
 * from the change feed — which this direct insert does NOT write to (no change_log row), so the
 * card cannot see a group opened here until that gap is closed.
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
      items: req.items.map((i) => ({ canonicalFoodId: i.food_ref_id, grams: i.grams, qty: i.qty,
        unit: i.unit })),
    });
    const fingerprint = toBytea(Buffer.from(hex, "hex"));
    const existing = await client.from("duplicate_groups").select("id")
      .eq("fingerprint", fingerprint).maybeSingle();
    if (existing.error) throw existing.error;
    let groupId = (existing.data as { id: string } | null)?.id ?? null;
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
  } catch (e) {
    console.error("duplicate-fingerprint recording failed", { entry_id: req.entry_id, error: e });
  }
}
