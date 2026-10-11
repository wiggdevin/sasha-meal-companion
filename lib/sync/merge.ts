// lib/sync/merge.ts
/**
 * Per-entity conflict merge — architecture §3.7's merge table. Pure, no I/O.
 *
 * Each side carries ONE timestamp: the op's `client_ts` locally, the row's own stamp on the
 * server. "Field-wise, newer client_ts" therefore means: where both sides define a field the
 * newer side wins; where only one side defines it, that value survives.
 */
import type { Entity, SyncOp } from "./types";

/** A synced row on the wire. `E` records which entity the caller means; it does not narrow the
 *  columns yet — per-entity row types arrive with the generated Supabase types in Phase 1. */
export type Row<E extends Entity = Entity> = Record<string, unknown> & { readonly __entity?: E };

/** Server wins outright; the client discards its op and says "targets changed elsewhere".
 *  Phase 6 adds `target_proposals`: a decision made on the other device is the decision. */
export const NEVER_MERGED: ReadonlySet<string> = new Set(["target_profiles", "target_proposals"]);

export class MergeRefusedError extends Error {
  constructor(public readonly entity: string) {
    super(`${entity} is never merged — the server wins and the client discards its op`);
    this.name = "MergeRefusedError";
  }
}

function isNewer(localTs: string, serverTs: string): boolean {
  return Date.parse(localTs) > Date.parse(serverTs);
}

/** Field-wise newer-wins. A field only one side defines always survives. */
export function newerWinsFields(local: Row, server: Row, localTs: string, serverTs: string): Row {
  const localWins = isNewer(localTs, serverTs);
  const out: Row = {};
  for (const key of new Set([...Object.keys(server), ...Object.keys(local)])) {
    const l = local[key];
    const s = server[key];
    if (s === undefined) out[key] = l;
    else if (l === undefined) out[key] = s;
    else out[key] = localWins ? l : s;
  }
  return out;
}

function noteText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function noteLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Notes are symptom evidence: losing one loses a record. Older text first, deterministically.
 *
 * Idempotent (audit 2026-10-10 A139): a side whose every line the other side already holds adds
 * nothing, so a rebased note that already carries the server's text is not joined to it again on
 * the next conflict, and otherwise only the newer side's lines the older one lacks are appended.
 */
export function joinNotes(a: unknown, b: unknown, aTs: string, bTs: string): string | undefined {
  const first = noteText(a);
  const second = noteText(b);
  if (!first) return second || undefined;
  if (!second) return first;
  if (first === second) return first;
  const [older, newer] = isNewer(aTs, bTs) ? [second, first] : [first, second];
  const olderLines = new Set(noteLines(older));
  const newerLines = noteLines(newer);
  if (newerLines.every((line) => olderLines.has(line))) return older;
  const newerSet = new Set(newerLines);
  if ([...olderLines].every((line) => newerSet.has(line))) return newer;
  return [older, ...newerLines.filter((line) => !olderLines.has(line))].join("\n");
}

/**
 * A three-way note merge for an op that carries the WHOLE note (a log entry's note edit), against
 * the note that edit started from (audit 2026-10-10 A077). A side that left the base alone takes
 * the other side's note, a clear included; only when both sides changed it are the two joined.
 */
export function mergeNoteFromBase(
  base: unknown, mine: unknown, theirs: unknown, mineTs: string, theirsTs: string,
): string | undefined {
  const from = noteText(base);
  const ours = noteText(mine);
  const their = noteText(theirs);
  if (their === from) return ours || undefined;
  if (ours === from) return their || undefined;
  return joinNotes(their, ours, theirsTs, mineTs);
}

/** The server's rev is authoritative, and a tombstone on either side dominates. */
function settle(merged: Row, local: Row, server: Row): Row {
  const out: Row = { ...merged };
  const rev = server.rev ?? local.rev;
  if (rev !== undefined) out.rev = rev;
  const tomb = server.deleted_at ?? local.deleted_at;
  if (tomb !== undefined && tomb !== null) out.deleted_at = tomb;
  return out;
}

function asItems(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

type EatenSlot = { eaten_at: string | null; changed_at: string;
  consumed?: unknown; history_epoch?: string };

function asEatenSlots(value: unknown): Record<string, EatenSlot> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, EatenSlot>;
}

function mergeEatenSlots(local: unknown, server: unknown): Record<string, EatenSlot> {
  const mine = asEatenSlots(local);
  const theirs = asEatenSlots(server);
  const out: Record<string, EatenSlot> = {};
  for (const slot of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
    const localTick = mine[slot];
    const serverTick = theirs[slot];
    if (!serverTick) out[slot] = localTick;
    else if (!localTick) out[slot] = serverTick;
    else if (serverTick.consumed || localTick.consumed ||
      serverTick.history_epoch !== localTick.history_epoch) {
      // Only the online recipe transaction may advance consumed history. An
      // offline mark cannot borrow the server's newer epoch during a rebase.
      out[slot] = serverTick;
    } else out[slot] = Date.parse(localTick.changed_at) > Date.parse(serverTick.changed_at)
      ? localTick : serverTick;
  }
  return out;
}

function bySeqThenId(a: Row, b: Row): number {
  const seq = Number(a.seq ?? 0) - Number(b.seq ?? 0);
  return seq !== 0 ? seq : String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

/** Architecture §3.7 `log_items`: keyed by id, newer client_ts per field, one-sided ids kept. */
function mergeItems(local: Row[], server: Row[], localTs: string, serverTs: string): Row[] {
  const byId = new Map<string, Row>();
  for (const item of server) byId.set(String(item.id), item);
  for (const item of local) {
    const id = String(item.id);
    const other = byId.get(id);
    byId.set(id, other ? newerWinsFields(item, other, localTs, serverTs) : item);
  }
  return [...byId.values()].sort(bySeqThenId);
}

export function mergeEntity<E extends Entity>(
  entity: E, local: Row<E>, server: Row<E>, localTs: string, serverTs: string,
): Row<E> {
  if (NEVER_MERGED.has(entity)) throw new MergeRefusedError(entity);

  // architecture §3.7: recipes are immutable revisions. A conflict creates a new rev on top of
  // current_rev with NO field merge — half of one edit and half of another device's would be a
  // recipe neither device ever meant. rebaseOp (below) re-aims this payload at current_rev, and
  // the server writes it as a whole new recipe_revisions row, so the old revision — and every
  // log_items snapshot taken from it — stays byte-identical.
  if (entity === "recipes") return settle({ ...local }, local, server) as Row<E>;

  // favorites_*: field-wise newer-wins is the whole per-row rule (`sort` is the only scalar).
  // Set union is a STORE-level rule, not a row-level one — two devices each starring a different
  // food produce two rows that never conflict with each other, so mergeEntity never sees them.
  // lib/favorites.ts mergeFavorites is where the union happens, over the rows of both stores.
  const merged = newerWinsFields(local, server, localTs, serverTs);

  if (entity === "water_log") {
    merged.cups = Math.max(Number(local.cups ?? 0), Number(server.cups ?? 0));
  } else if (entity === "plan_days") {
    merged.eaten_slots = mergeEatenSlots(local.eaten_slots, server.eaten_slots);
  } else if (entity === "user_food_prefs" || entity === "log_entries" || entity === "gut_log") {
    const note = joinNotes(local.note, server.note, localTs, serverTs);
    if (note === undefined) delete merged.note;
    else merged.note = note;
    if (entity === "log_entries") {
      merged.items = mergeItems(asItems(local.items), asItems(server.items), localTs, serverTs);
    }
  }

  return settle(merged, local, server) as Row<E>;
}

/**
 * Re-aim a rejected op at the row the server actually holds. A new `op_id` keeps the server's
 * idempotency honest: the conflicting op wrote nothing, so its id never reached `change_log`, and
 * the rebased op is a different intent. `client_ts` moves to now because the merged payload
 * already contains the server's side and must win the next comparison.
 */
export function rebaseOp(op: SyncOp, merged: unknown, currentRev: number): SyncOp {
  if (typeof merged !== "object" || merged === null || Array.isArray(merged)) {
    throw new TypeError("rebaseOp: merged payload must be an object");
  }
  return {
    ...op,
    op_id: crypto.randomUUID(),
    kind: op.kind === "create" ? "update" : op.kind,
    base_rev: currentRev,
    payload: merged as Record<string, unknown>,
    client_ts: new Date().toISOString(),
  };
}
