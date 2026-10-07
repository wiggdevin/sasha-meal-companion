/**
 * A USDA snapshot check, made a comparison instead of a hunt:
 *
 *   pnpm exec tsx scripts/verify-snapshots.ts --user-id <uuid> <local_date>
 *   pnpm exec tsx scripts/verify-snapshots.ts --user-id <uuid> --repair <from> <to>
 *
 * Print mode lists every item of a date with its grams, source revision and the per-100 g values
 * the snapshot was computed from, so a row can be read straight against fdc.nal.usda.gov.
 * Repair mode recomputes each entry's snapshots from the active revisions through apply_sync_op,
 * which bumps `rev` and appends to change_log, so the account's other devices pull the correction.
 *
 * Service role, from the Mac. Never runs on Vercel.
 */

import { randomUUID } from "node:crypto";
import { adminClient } from "@/lib/server/admin";
import { formatAmount } from "@/lib/nutrients/format";
import { isNutrientCode } from "@/lib/nutrients/codes";
import type { Snapshot } from "@/lib/nutrients/snapshot";
import { snapshotValue } from "@/lib/nutrients/snapshot";

/** `grams` null: an unknown mass (t17). Repair resends it as null; the SQL keeps its per-unit
 *  snapshot (rescaled to qty), so --repair never turns it into 0 or `{}`. */
type Item = { id: string; seq: number; grams: number | null; unit: string; qty: number;
  food_ref_id: string; food_revision_id: number | null; snapshot: Snapshot;
  portion_id: number | null; was_edited: boolean; confidence: number | null };
type Entry = { id: string; local_date: string; eaten_at: string; slot: string; rev: number;
  tz: string; note: string | null; method: string; log_items: Item[] };

const SELECT = "id, local_date, eaten_at, slot, rev, tz, note, method, " +
  "log_items(id, seq, qty, unit, grams, food_ref_id, food_revision_id, snapshot, " +
  "portion_id, was_edited, confidence)";

async function entriesBetween(userId: string, from: string, to: string): Promise<Entry[]> {
  const { data, error } = await adminClient().from("log_entries").select(SELECT)
    .eq("user_id", userId).is("deleted_at", null)
    .gte("local_date", from).lte("local_date", to)
    .order("local_date", { ascending: true }).order("eaten_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as Entry[];
}

function printEntry(entry: Entry): void {
  console.log(`\n${entry.local_date} ${entry.slot} (${entry.id}, rev ${entry.rev})`);
  for (const item of [...entry.log_items].sort((a, b) => a.seq - b.seq)) {
    const codes = Object.keys(item.snapshot).filter(isNutrientCode);
    const first = codes.length > 0 ? snapshotValue(item.snapshot, codes[0]) : undefined;
    console.log(`  #${item.seq} ${item.grams === null ? "mass unknown" : `${item.grams} g`} (${item.qty} ${item.unit}) ` +
      `ref=${item.food_ref_id} revision=${item.food_revision_id ?? "-"} ` +
      `source=${first?.source ?? "-"}@${first?.source_version ?? "-"}`);
    for (const code of codes) {
      const value = snapshotValue(item.snapshot, code)!;
      const per100 = value.amount === null || item.grams === null || !(item.grams > 0) ? null
        : Math.round((value.amount / item.grams) * 100 * 1e4) / 1e4;
      console.log(`     ${code.padEnd(18)} ${formatAmount(code, value.amount, value.unit)
        .padStart(14)}   per 100 g: ${per100 ?? "—"}`);
    }
  }
}

async function repair(userId: string, entry: Entry): Promise<void> {
  const op = { op_id: randomUUID(), entity: "log_entries", entity_id: entry.id, kind: "update",
    base_rev: entry.rev, client_ts: new Date().toISOString(),
    payload: { eaten_at: entry.eaten_at, local_date: entry.local_date, slot: entry.slot,
      tz: entry.tz, note: entry.note, method: entry.method,
      recompute_snapshots: true,
      items: entry.log_items.map((i) => ({ id: i.id, seq: i.seq, qty: i.qty, unit: i.unit,
        food_ref_id: i.food_ref_id, grams: i.grams, snapshot: null,
        food_revision_id: i.food_revision_id, portion_id: i.portion_id, was_edited: i.was_edited,
        confidence: i.confidence })) } };
  const { data, error } = await adminClient().rpc("apply_sync_op",
    { p_user_id: userId, p_op: op });
  if (error) throw error;
  console.log(`  repaired ${entry.id}: ${(data as { status: string }).status}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "--user-id" || !args[1]) {
    throw new Error("usage: --user-id <uuid> <local_date> | --user-id <uuid> --repair <from> <to>");
  }
  const userId = args[1];
  const operationArgs = args.slice(2);
  if (operationArgs[0] === "--repair") {
    const [, from, to] = operationArgs;
    if (!from || !to) throw new Error("usage: --user-id <uuid> --repair <from> <to>");
    const entries = await entriesBetween(userId, from, to);
    console.log(`repairing ${entries.length} entries in ${from}..${to}`);
    for (const entry of entries) await repair(userId, entry);
    return;
  }
  const date = operationArgs[0];
  if (!date) throw new Error("usage: --user-id <uuid> <local_date>");
  const entries = await entriesBetween(userId, date, date);
  if (entries.length === 0) console.log(`no entries on ${date}`);
  for (const entry of entries) printEntry(entry);
}

main().catch((e) => { console.error(e); process.exit(1); });
