/**
 * Open duplicate groups for one day, read from this account's sync mirror (architecture §3.7,
 * "Duplicate detection — groups, not pointers").
 *
 * The server opens a `duplicate_groups` row when a second entry with the same event-time content
 * fingerprint is committed (`lib/server/log-duplicates.ts`). The phone learns of a group only from
 * the change feed, which `pullChanges` writes into the `duplicate_groups` mirror store. The feed's
 * row carries no member list (`_sync_current` returns the group row and its hex fingerprint), so the
 * members are found here the same way the server found them: the fingerprint of every live entry
 * of that day and slot, from the mirrored `log_entries` rows, computed by the one shared formula
 * (`lib/sync/fingerprint.ts`). A group shows only while two or more of those entries are live and
 * on the day's card list; one left over after a delete is not a duplicate any more.
 */
import type { AccountHandle } from "@/lib/device/account";
import { allRows } from "@/lib/sync/idb";
import { entryFingerprint } from "@/lib/sync/fingerprint";
import { entryMacros } from "@/lib/plan/entry-macros";
import type { LoggedFood } from "@/lib/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEX_RE = /^[0-9a-f]{64}$/i;

/** A mirrored group row, validated. Anything the change feed sent that does not parse is ignored. */
export type DuplicateGroupRow = {
  id: string; localDate: string; fingerprint: string; slot: string;
  state: "open" | "dismissed" | "merged"; rev: number;
};

/** One entry of a group, as the card shows it. */
export type DuplicateMember = {
  entryId: string; at: string; name: string; itemNames: string[]; kcal: number | null;
};

/** An open group with the entries it holds, oldest first. `members[0]` survives a merge. */
export type OpenDuplicateGroup = { group: DuplicateGroupRow; members: DuplicateMember[] };

export function parseGroupRow(row: Record<string, unknown>): DuplicateGroupRow | null {
  const { id, local_date: localDate, fingerprint, slot, state, rev } = row;
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  if (typeof localDate !== "string" || !DATE_RE.test(localDate.slice(0, 10))) return null;
  if (typeof fingerprint !== "string" || !HEX_RE.test(fingerprint)) return null;
  if (typeof slot !== "string" || slot.length === 0) return null;
  if (state !== "open" && state !== "dismissed" && state !== "merged") return null;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) return null;
  return { id: id.toLowerCase(), localDate: localDate.slice(0, 10), fingerprint: fingerprint.toLowerCase(),
    slot, state, rev };
}

type EntryRow = {
  id: string; local_date: string; slot: string; eaten_at: string;
  items: { food_ref_id: string; grams: number | null; qty?: number; unit?: string }[];
};

function liveEntryRow(row: Record<string, unknown>): EntryRow | null {
  if (row.deleted_at) return null;
  const { id, local_date: localDate, slot, eaten_at: eatenAt, items } = row;
  if (typeof id !== "string" || typeof localDate !== "string" || typeof slot !== "string") return null;
  if (typeof eatenAt !== "string" || Number.isNaN(Date.parse(eatenAt))) return null;
  if (!Array.isArray(items) || items.length === 0) return null;
  const parsed: EntryRow["items"] = [];
  for (const item of items as Record<string, unknown>[]) {
    if (typeof item?.food_ref_id !== "string") return null;
    const grams = item.grams === null ? null : Number(item.grams);
    if (grams !== null && !Number.isFinite(grams)) return null;
    parsed.push({ food_ref_id: item.food_ref_id, grams,
      qty: typeof item.qty === "number" ? item.qty : item.qty == null ? undefined : Number(item.qty),
      unit: typeof item.unit === "string" ? item.unit : undefined });
  }
  return { id: id.toLowerCase(), local_date: localDate.slice(0, 10), slot, eaten_at: eatenAt, items: parsed };
}

/** The server's fingerprint of one stored entry: the same inputs `recordFingerprint` hashed. */
export function fingerprintOfRow(row: EntryRow): Promise<string> {
  return entryFingerprint({
    localDate: row.local_date, slot: row.slot, eatenAt: row.eaten_at,
    items: row.items.map((item) => ({ canonicalFoodId: item.food_ref_id, grams: item.grams,
      qty: item.qty, unit: item.unit })),
  });
}

function memberOf(entry: LoggedFood): DuplicateMember {
  const itemNames = (entry.items ?? []).map((item) => item.name).filter(Boolean);
  const measured = (entry.items ?? []).some((item) => item.snapshot && Object.keys(item.snapshot).length > 0)
    || (entry.items ?? []).length === 0;
  const kcal = measured ? Math.round(entryMacros(entry).kcal) : null;
  return { entryId: entry.id.toLowerCase(), at: entry.at, name: entry.name, itemNames, kcal };
}

/**
 * Pure: the open groups of `date` given the mirrored group rows, the mirrored entry rows and the
 * day's cards. Members are ordered by time, then id, so every device picks the same survivor.
 */
export async function openGroupsFor(
  date: string,
  groupRows: readonly Record<string, unknown>[],
  entryRows: readonly Record<string, unknown>[],
  extras: readonly LoggedFood[],
): Promise<OpenDuplicateGroup[]> {
  const groups = groupRows.map(parseGroupRow)
    .filter((g): g is DuplicateGroupRow => g !== null && g.state === "open" && g.localDate === date);
  if (groups.length === 0) return [];
  const cards = new Map(extras.map((entry) => [entry.id.toLowerCase(), entry]));
  const byFingerprint = new Map<string, EntryRow[]>();
  for (const raw of entryRows) {
    const row = liveEntryRow(raw);
    if (!row || row.local_date !== date || !cards.has(row.id)) continue;
    let hex: string;
    try { hex = await fingerprintOfRow(row); } catch { continue; }
    byFingerprint.set(hex, [...(byFingerprint.get(hex) ?? []), row]);
  }
  const out: OpenDuplicateGroup[] = [];
  for (const group of groups) {
    const rows = (byFingerprint.get(group.fingerprint) ?? []).filter((row) => row.slot === group.slot);
    if (rows.length < 2) continue;
    const members = rows.map((row) => memberOf(cards.get(row.id)!))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.entryId.localeCompare(b.entryId));
    out.push({ group, members });
  }
  return out.sort((a, b) => a.group.id.localeCompare(b.group.id));
}

/** The open groups of `date` for the account `h` names, from its own mirror only. */
export async function readOpenDuplicateGroups(
  h: AccountHandle, date: string, extras: readonly LoggedFood[],
): Promise<OpenDuplicateGroup[]> {
  const [groups, entries] = await Promise.all([
    allRows(h, "duplicate_groups"), allRows(h, "log_entries"),
  ]);
  return openGroupsFor(date, groups, entries, extras);
}
