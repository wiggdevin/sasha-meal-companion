// lib/sync/settings-intents.ts
/**
 * The ALGEBRA of the `user_settings` row, with no database in it: the baseline a device keeps, the
 * field intents it has recorded, and the pure transition a settlement applies to them.
 *
 * The row is the one sync row more than one writer rewrites WHOLE (the body profile's four columns,
 * water's goal columns) and the one a pull also writes, so every local edit is expressed as a
 * field-level INTENT on top of the last row this device knows the server held:
 *
 *  1. ONE UNSENT OP. Its `base_rev` is the baseline rev and its payload is the baseline row plus the
 *     pending intents, so no op is ever aimed at a rev the server only reaches if our own earlier op
 *     applies first (seventh-round P1).
 *
 *  2. A GENERATION IS FROZEN WHEN IT IS SENT. The op carries its own `{ intents, generation }`
 *     snapshot from the moment it goes on the wire (lib/sync/settings.ts's `selectAndFreezeSettings`,
 *     which SELECTS the op in the same transaction), and intents recorded after that go into the
 *     NEXT generation with its own `op_id`. An answer then settles only the generation it names
 *     (eighth-round P1) — the delayed `applied` whose fields came back as pending intents, the
 *     resurrected op whose `duplicate` dropped the newer edit, and a selected snapshot a later edit
 *     replaced (ninth-round P1) are all this rule missing.
 *
 *  3. AN UNCONFIRMED OP IS NEVER PROMOTED. A device upgrading from a build that kept no baseline
 *     holds a whole-row payload whose columns are indistinguishable from a stale copy, so it is kept
 *     whole and left for a pull to diff (`looseRecovery`) instead of becoming a whole row of intents.
 */
import type { OutboxOp } from "./idb";
import type { SyncOp } from "./types";

/** The one settings row: entity `user_settings`, key `settings` (contracts §4). */
export const SETTINGS_ENTITY = "user_settings" as const;
export const USER_SETTINGS_KEY = "settings";
/** Where the server-known row lives. In `meta`, because it is bookkeeping, not an entity row. */
export const BASELINE_KEY = "settings_baseline";
/**
 * Phase 18 W5b-2: intents an older build froze that can no longer be replayed safely (their original
 * row is gone and the server writes the same field): kept here for review, never sent.
 */
export const HELD_INTENTS_KEY = "settings_held_intents";

export type SettingsRow = Record<string, unknown>;

/**
 * One field changed since the baseline row: the intent a rebase replays.
 *
 * Phase 18 W5b-2: the server now writes two settings fields too (the taste-chip confirm and Undo RPCs
 * add and remove `cuisines` and `diet_prefs.taste.dislikes` keys), so an edit replays only what it
 * changed onto whatever the server's row holds:
 *  - `sub`: the sub-keys of an object column (`SUBKEYED`) this edit changed. A water-unit edit built
 *    before the server added a taste chip never carries the older `taste` back.
 *  - `delta`: for a set-valued field (`cuisines`, and `diet_prefs.taste.dislikes` when `sub` names
 *    `taste`), the keys this edit added and removed. The replay removes and adds exactly those on the
 *    server's list (at most `SET_CAPS`), so a pending Settings edit neither drops a chip the server
 *    added nor brings back one the server's Undo removed.
 * An intent without them (every other column, a non-object value) replaces the whole value. One
 * recorded by an older build is upgraded against the baseline row it was built on (`upgradeIntents`).
 */
export type SetDelta = { add: string[]; remove: string[] };
export type SettingsIntent = { key: string; value: unknown; sub?: string[]; delta?: SetDelta };

/**
 * Object columns several writers rewrite whole and the server also writes (diet_prefs: flags, text,
 * water, widget and taste on the phone; the taste-chip confirm and Undo RPCs on the server).
 */
export const SUBKEYED: ReadonlySet<string> = new Set(["diet_prefs"]);
/** The set-valued fields the server writes key by key, with the database's caps. */
export const SET_CAPS = { cuisines: 6, tasteDislikes: 50, companionsHidden: 8 } as const;
/** Set-valued columns an edit replays as a delta onto the server's list, with their caps. The UI
 *  makeover's `companions_hidden` (W3) goes key by key too, so two phones hiding different
 *  companions never undo each other. */
const SET_COLUMNS: ReadonlyMap<string, number> = new Map([
  ["cuisines", SET_CAPS.cuisines], ["companions_hidden", SET_CAPS.companionsHidden]]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const has = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** The sub-keys whose values differ between two objects. */
function changedSubKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !sameValue(before[key], after[key]));
}

function deltaOf(before: readonly string[], after: readonly string[]): SetDelta {
  return { add: after.filter((key) => !before.includes(key)), remove: before.filter((key) => !after.includes(key)) };
}

/** The earlier delta, then the later one: a key's last move wins. */
function composeDelta(earlier: SetDelta, later: SetDelta): SetDelta {
  const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
  return {
    add: union(earlier.add.filter((key) => !later.remove.includes(key)), later.add),
    remove: union(earlier.remove.filter((key) => !later.add.includes(key)), later.remove),
  };
}

/** A delta laid onto a list: its removals off, its additions appended while under the cap. */
function applyDelta(base: unknown, delta: SetDelta, cap: number): string[] {
  const out = (isStringArray(base) ? base : []).filter((key) => !delta.remove.includes(key));
  for (const key of delta.add) if (!out.includes(key) && out.length < cap) out.push(key);
  return out;
}

/** The dislikes of a taste value, when it is one a delta can describe: an object holding only a list. */
function tasteList(taste: unknown): string[] | null {
  if (taste === undefined) return [];
  if (!isPlainObject(taste) || Object.keys(taste).some((key) => key !== "dislikes")) return null;
  if (!has(taste, "dislikes")) return [];
  return isStringArray(taste.dislikes) ? taste.dislikes : null;
}

/** The intent ONE edit of `key` from `before` to `after` records. */
function editIntent(key: string, before: unknown, after: unknown): SettingsIntent {
  if (key === "cuisines" && isStringArray(before) && isStringArray(after)) {
    return { key, value: after, delta: deltaOf(before, after) };
  }
  // A row from before the column has no list yet: nothing hidden.
  if (key === "companions_hidden" && (before === undefined || isStringArray(before)) && isStringArray(after)) {
    return { key, value: after, delta: deltaOf(before ?? [], after) };
  }
  if (SUBKEYED.has(key) && isPlainObject(before) && isPlainObject(after)) {
    const sub = changedSubKeys(before, after);
    if (key === "diet_prefs" && sub.includes("taste") && has(after, "taste")) {
      const was = tasteList(before.taste);
      const now = tasteList(after.taste);
      if (was !== null && now !== null) return { key, value: after, sub, delta: deltaOf(was, now) };
    }
    return { key, value: after, sub };
  }
  return { key, value: after };
}

/** An intent's value laid onto the value the payload holds so far: whole, by sub-key, or by delta. */
function applyIntent(current: unknown, intent: SettingsIntent): unknown {
  const cap = SET_COLUMNS.get(intent.key);
  if (cap !== undefined && intent.delta) return applyDelta(current, intent.delta, cap);
  if (!intent.sub || !isPlainObject(intent.value)) return intent.value;
  const next: Record<string, unknown> = isPlainObject(current) ? { ...current } : {};
  for (const key of intent.sub) {
    if (!has(intent.value, key)) { delete next[key]; continue; }
    if (key === "taste" && intent.delta) {
      next.taste = { dislikes: applyDelta(isPlainObject(next.taste) ? next.taste.dislikes : undefined,
        intent.delta, SET_CAPS.tasteDislikes) };
      continue;
    }
    next[key] = intent.value[key];
  }
  return next;
}

/**
 * Two intents for one key, the second recorded later: the later value wins. Sub-key intents keep the
 * union of their sub-keys (the later value was built on a mirror that already held the earlier one's
 * changes, so it carries them); deltas compose; anything whole makes that part whole.
 */
function composeIntents(earlier: SettingsIntent, later: SettingsIntent): SettingsIntent {
  const { key, value } = later;
  if (SET_COLUMNS.has(key)) {
    return earlier.delta && later.delta ? { key, value, delta: composeDelta(earlier.delta, later.delta) } : { key, value };
  }
  if (!earlier.sub || !later.sub) return { key, value };
  const sub = [...new Set([...earlier.sub, ...later.sub])];
  const early = earlier.sub.includes("taste");
  const late = later.sub.includes("taste");
  const delta = !late ? earlier.delta
    : !early ? later.delta
    : earlier.delta && later.delta ? composeDelta(earlier.delta, later.delta) : undefined;
  return delta && sub.includes("taste") ? { key, value, sub, delta } : { key, value, sub };
}

/**
 * An intent recorded by an older build replaces its whole column. For the columns the server also
 * writes, re-derive what it changed from the row it was built on, so the replay keeps the server's
 * other sub-keys and set members. Intents that already carry `sub` or `delta` are left as they are.
 */
export function upgradeIntents(row: SettingsRow, intents: readonly SettingsIntent[]): SettingsIntent[] {
  return intents.map((intent) => {
    if (intent.sub || intent.delta || (intent.key !== "cuisines" && !SUBKEYED.has(intent.key))) return intent;
    return editIntent(intent.key, row[intent.key], intent.value);
  });
}

/** What every settings op carries besides the wire fields: its frozen intents and its generation.
 *  Written when the op is queued, frozen when it is SENT, stripped before it goes on the wire. */
export type SettingsGeneration = { intents: SettingsIntent[]; generation: number };

/** A settings op as the outbox holds it: the generation snapshot may still be missing (a legacy op
 *  is only enriched when it is sent), so every reader supplies its own default. */
export type SettingsOp = OutboxOp & Partial<SettingsGeneration>;

/**
 * The row this device believes the server holds, the rev it holds it at, and the local intents
 * recorded since. `rev: null` means this device has never seen a server row (a `create`). `sent`
 * names the generation currently in flight, whose op is frozen in the outbox. `generation` is the
 * counter the next generation is allocated from.
 */
export type SettingsBaseline = {
  row: SettingsRow;
  rev: number | null;
  generation: number;
  intents: SettingsIntent[];
  sent: string | null;
};

export const EMPTY_STATE: SettingsBaseline = { row: {}, rev: null, generation: 0, intents: [],
  sent: null };

/** What the server holds after one settlement, as far as this client can tell. */
export type SettingsSettlement =
  /** A pull: `/api/sync/changes` just reported this row at this rev. */
  | { status: "pull"; row: SettingsRow; rev: number }
  /** The op applied at this rev; its payload is on the server. */
  | { status: "applied"; rev: number }
  /** The server answered `conflict` with its own row at this rev; the op is rewritten onto it. */
  | { status: "conflict"; row: SettingsRow; rev: number }
  /** The server already holds this generation's payload (`duplicate`); nothing newer was touched. */
  | { status: "duplicate" }
  /** The op is done with (`gone` / `unsupported`); the baseline does not move. */
  | { status: "drop" };

/** Columns the server owns: never part of a payload, never an intent. */
const SERVER_OWNED = new Set(["user_id", "rev", "seq", "created_at", "updated_at"]);

function isWholeRow(op: { kind: SyncOp["kind"] }): boolean {
  return op.kind === "create" || op.kind === "update";
}

/** The settings whole-row ops still queued, in the order the outbox will push them. */
export function pendingSettingsOps(ops: readonly OutboxOp[]): SettingsOp[] {
  return ops.filter((op) => op.entity === SETTINGS_ENTITY && isWholeRow(op))
    .sort((a, b) => a.seq - b.seq);
}

/** Two JSON values are the same intent when they say the same thing: a structured clone of an
 *  untouched column is a different object with the same contents. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The row without the columns the server owns. */
export function stripServerOwned(row: SettingsRow): SettingsRow {
  const out: SettingsRow = {};
  for (const [key, value] of Object.entries(row)) if (!SERVER_OWNED.has(key)) out[key] = value;
  return out;
}

/** The wire payload: the baseline row with each intent list on top, in the order given. */
export function payloadOf(row: SettingsRow, ...lists: readonly (readonly SettingsIntent[])[]):
    SettingsRow {
  const payload = stripServerOwned(row);
  for (const list of lists) {
    for (const intent of list) payload[intent.key] = applyIntent(payload[intent.key], intent);
  }
  return payload;
}

/** The union of intent lists, later entries winning: one `{key, value}` per field, in order. */
export function mergeIntents(...lists: readonly (readonly SettingsIntent[])[]): SettingsIntent[] {
  const byKey = new Map<string, SettingsIntent>();
  for (const list of lists) {
    for (const intent of list) {
      const earlier = byKey.get(intent.key);
      byKey.set(intent.key, earlier ? composeIntents(earlier, intent) : intent);
    }
  }
  return [...byKey.values()];
}

/** The intents ONE whole-row payload states on top of a known row: what it changes, nothing else. */
export function diffIntents(row: SettingsRow, payload: SettingsRow): SettingsIntent[] {
  const intents: SettingsIntent[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!SERVER_OWNED.has(key) && !sameValue(row[key], value)) intents.push({ key, value });
  }
  return intents;
}

/**
 * Fold a still-QUEUED whole-row payload onto a known row: it re-states the row it was built from, so
 * a key equal to `base` carries no intent (dropping one an earlier op in the chain set and this op
 * reverted). This is how a device that upgrades with a legacy op chain collapses to one generation.
 */
export function foldQueued(base: SettingsRow, intents: readonly SettingsIntent[],
    payload: SettingsRow): SettingsIntent[] {
  const byKey = new Map(intents.map((intent) => [intent.key, intent]));
  for (const [key, value] of Object.entries(payload)) {
    if (SERVER_OWNED.has(key)) continue;
    // Phase 18 W5b-2: a queued payload that this device built from a recorded intent re-states it;
    // keep that intent (its sub-keys or set delta), never its flattened whole value — a typed one
    // also when the value equals `base` (a removal then a re-add is still the user's last move); a
    // whole intent equal to `base` changes nothing and is dropped.
    // Anything else is a legacy chain's own change, recorded as what it changed against `base`.
    const existing = byKey.get(key);
    const typed = existing !== undefined && (existing.sub !== undefined || existing.delta !== undefined);
    if (typed && sameValue(applyIntent(base[key], existing), value)) continue;
    if (sameValue(base[key], value)) { byKey.delete(key); continue; }
    if (existing && sameValue(applyIntent(base[key], existing), value)) continue;
    byKey.set(key, editIntent(key, base[key], value));
  }
  return [...byKey.values()];
}

/**
 * The intents of the generation in flight, ready to replay: stored shapes checked, and an older
 * build's whole intent upgraded against the row it was frozen on — only while the baseline is still
 * that row (`op.base_rev === stored.rev`). Once a pull has moved the baseline, the original row is
 * gone and what such an intent changed cannot be told: the parts the server also writes (`cuisines`,
 * `diet_prefs.taste`, or a whole non-object `diet_prefs`) are HELD — returned in `held`, kept on the
 * device for review, never replayed — and the rest of a `diet_prefs` object replays by its sub-keys.
 */
export function frozenIntents(stored: SettingsBaseline | null, op: SettingsOp):
    { intents: SettingsIntent[]; held: SettingsIntent[] } | undefined {
  if (!op.intents) return undefined;
  const checked = op.intents.filter(isIntent).map(storedIntent);
  if (stored !== null && stored.rev !== null && op.base_rev === stored.rev) {
    return { intents: upgradeIntents(stored.row, checked), held: [] };
  }
  const intents: SettingsIntent[] = [];
  const held: SettingsIntent[] = [];
  for (const intent of checked) {
    const typed = intent.sub !== undefined || intent.delta !== undefined;
    if (typed || (intent.key !== "cuisines" && !SUBKEYED.has(intent.key))) { intents.push(intent); continue; }
    if (intent.key === "diet_prefs" && isPlainObject(intent.value)) {
      const sub = Object.keys(intent.value).filter((key) => key !== "taste");
      if (has(intent.value, "taste")) held.push({ key: "diet_prefs.taste", value: intent.value.taste });
      intents.push({ key: intent.key, value: intent.value, sub });
      continue;
    }
    held.push(intent);
  }
  return { intents, held };
}

/**
 * `queued` with the generation in flight carrying `frozenIntents` (the same op object when nothing
 * moved), and the intents it held back.
 */
export function withFrozenIntents(stored: SettingsBaseline | null, queued: readonly SettingsOp[]):
    { queued: SettingsOp[]; held: SettingsIntent[] } {
  if (stored === null || stored.sent === null) return { queued: [...queued], held: [] };
  let held: SettingsIntent[] = [];
  const out = queued.map((op) => {
    if (op.op_id !== stored.sent) return op;
    const frozen = frozenIntents(stored, op);
    if (frozen === undefined || sameValue(frozen.intents, op.intents)) return op;
    held = frozen.held;
    return { ...op, intents: frozen.intents, payload: withoutHeld(op.payload, frozen.held) };
  });
  return { queued: out, held };
}

/**
 * The frozen op's wire payload without what it holds: the sync RPC keeps a stored `cuisines` or
 * `diet_prefs` the payload omits, and the stored `taste` when an incoming `diet_prefs` has no `taste`
 * key (W5, migration 20261217090200), so a held value is never transmitted.
 */
function withoutHeld(payload: SettingsRow, held: readonly SettingsIntent[]): SettingsRow {
  const out: SettingsRow = { ...payload };
  for (const intent of held) {
    if (intent.key === "diet_prefs.taste") {
      if (isPlainObject(out.diet_prefs)) {
        const { taste: _taste, ...rest } = out.diet_prefs;
        void _taste;
        out.diet_prefs = rest;
      }
    } else {
      delete out[intent.key];
    }
  }
  return out;
}

/**
 * Fold ONE writer's whole-row payload onto the intent list: only the keys it actually changes move
 * it. A key it did not touch (every other column, and every intent already recorded, which the
 * mirror it read from already carries) leaves the list alone.
 */
export function foldEdit(current: SettingsRow, intents: readonly SettingsIntent[],
    payload: SettingsRow): SettingsIntent[] {
  const byKey = new Map(intents.map((intent) => [intent.key, intent]));
  for (const [key, value] of Object.entries(payload)) {
    if (SERVER_OWNED.has(key) || sameValue(current[key], value)) continue;
    const edit = editIntent(key, current[key], value);
    const earlier = byKey.get(key);
    byKey.set(key, earlier ? composeIntents(earlier, edit) : edit);
  }
  return [...byKey.values()];
}

function isIntent(value: unknown): value is SettingsIntent {
  const intent = value as SettingsIntent | null;
  return typeof intent === "object" && intent !== null && typeof intent.key === "string";
}

/** A stored intent with a malformed `sub` or `delta` replays whole: never dropped, never half-applied. */
function storedIntent(intent: SettingsIntent): SettingsIntent {
  const subOk = intent.sub === undefined || isStringArray(intent.sub);
  const deltaOk = intent.delta === undefined
    || (isPlainObject(intent.delta) && isStringArray(intent.delta.add) && isStringArray(intent.delta.remove));
  return subOk && deltaOk ? intent : { key: intent.key, value: intent.value };
}

/** A stored baseline in any shape this module has written, tolerating an older one. */
export function normalizeBaseline(value: unknown): SettingsBaseline | null {
  if (typeof value !== "object" || value === null) return null;
  const stored = value as Partial<SettingsBaseline>;
  const row = (typeof stored.row === "object" && stored.row !== null ? stored.row : {}) as SettingsRow;
  return {
    row,
    rev: typeof stored.rev === "number" ? stored.rev : null,
    generation: typeof stored.generation === "number" ? stored.generation : 0,
    intents: upgradeIntents(row,
      Array.isArray(stored.intents) ? stored.intents.filter(isIntent).map(storedIntent) : []),
    sent: typeof stored.sent === "string" ? stored.sent : null,
  };
}

/** The rev the pending generation is aimed at: after the in-flight one, or after the known row. */
export function pendingRev(state: SettingsBaseline, sent: SettingsOp | null): number | null {
  if (state.rev === null && sent === null) return null;
  const afterSent = sent === null ? 0 : (sent.base_rev ?? 0) + 1;
  return Math.max(state.rev ?? 0, afterSent);
}

/**
 * The kind a WHOLE-ROW op sends as, from the rev it is aimed at. `null` is a row this device has
 * never seen; `0` is the explicit empty baseline the legacy recovery installs when the feed showed
 * the server holds no row. Only a `create` can reach a row-less server (an update answers `gone`),
 * and the server's own revs start at 1, so 0 can only ever mean "no row" (ninth-round P1: a
 * baseline-less payload used to go out as an update and be dropped).
 */
export function opKind(baseRev: number | null): SyncOp["kind"] {
  return baseRev === null || baseRev === 0 ? "create" : "update";
}

/**
 * The row the mirror must show: the baseline, the generation in flight and the recorded intents, at
 * the rev the pending op will land on. Rebuilding that pair — rather than overlaying a payload on
 * whatever the mirror happens to hold — is what makes a partial push response safe: an op the server
 * applied is in the baseline, and a `duplicate` cannot leave a value the server moved past in it.
 */
export function settingsMirror(state: SettingsBaseline | null, sent: SettingsOp | null): SettingsRow {
  const row = payloadOf(state?.row ?? {}, sent?.intents ?? [], state?.intents ?? []);
  const queued = (sent === null ? 0 : 1) + ((state?.intents.length ?? 0) > 0 ? 1 : 0);
  return { ...row, rev: (state?.rev ?? 0) + queued };
}

/** The baseline for a device that has settled none: the mirror row is all it knows, and the OLDEST
 *  queued op still remembers the rev the server held when it was built — from it, never from the
 *  mirror's speculative rev. Every column a queued create carries is an intent: that op IS the whole
 *  row to send. */
function looseState(row: SettingsRow, queued: readonly SettingsOp[]): SettingsBaseline {
  const intents: SettingsIntent[] = [];
  for (const op of queued) intents.push(...diffIntents({}, op.payload));
  return {
    row: { ...row },
    rev: queued.length > 0 ? queued[0].base_rev : (typeof row.rev === "number" ? row.rev : null),
    generation: 0,
    intents: mergeIntents(intents),
    sent: null,
  };
}

/** Best-effort recovery for a payload built before this device kept a baseline: keep only the fields
 *  that differ from the row the server holds, because the row it WAS built on was never recorded.
 *  Exported for the empty baseline (`establishEmptySettingsBaseline`, lib/sync/settings.ts): there
 *  the row to diff against is `{}`, so every column of the payload becomes an intent. */
export function looseRecovery(row: SettingsRow, queued: readonly SettingsOp[]): SettingsIntent[] {
  let intents: SettingsIntent[] = [];
  for (const op of queued) intents = foldQueued(row, intents, op.payload);
  return intents;
}

/** What one write commits besides the op and its mirror row, for idb.mutateRowWithOp. */
export type SettingsWrite<T> = {
  row: SettingsRow; op: SyncOp & Partial<SettingsGeneration>; result: T;
  retire: readonly string[]; meta: readonly { key: string; value: unknown }[];
};

/**
 * The fail-closed write (rule 3): a queued op whose baseline was never recorded. The payload stays
 * the WHOLE row it always was and no baseline is written, so the drain parks it until a pull can
 * diff it against the server's row.
 */
export function unconfirmedWrite<T>(queued: readonly SettingsOp[], writer: SyncOp, result: T,
    ): SettingsWrite<T> {
  const baseRev = queued[0].base_rev;
  let payload: SettingsRow = {};
  for (const op of queued) payload = { ...payload, ...op.payload };
  payload = { ...payload, ...stripServerOwned(writer.payload) };
  return {
    row: { ...payload, rev: (baseRev ?? 0) + 1 },
    op: { op_id: writer.op_id, entity: SETTINGS_ENTITY, entity_id: USER_SETTINGS_KEY,
      kind: opKind(baseRev), base_rev: baseRev, payload,
      client_ts: writer.client_ts },
    result, retire: queued.map((pending) => pending.op_id), meta: [],
  };
}

/** The generation in flight, if the queue still holds it: the op whose snapshot a write must not
 *  touch. Its `intents` are frozen (rule 2), so only a never-sent op is ever replaced. */
export function inFlight(state: SettingsBaseline | null, queued: readonly SettingsOp[]):
    SettingsOp | null {
  if (state === null || state.sent === null) return null;
  return queued.find((op) => op.op_id === state.sent) ?? null;
}

/**
 * The normal write: fold this writer's edit into the pending generation and write that generation as
 * the one queued op — aimed at the baseline rev, or at the rev the in-flight generation will land on
 * — with its intent snapshot riding the op (the record `markSentSettings` freezes at send time).
 */
export function confirmedWrite<T>(mirror: SettingsRow, stored: SettingsBaseline | null,
    queued: readonly SettingsOp[], writer: SyncOp, result: T): SettingsWrite<T> {
  const sent = inFlight(stored, queued);
  const frozen = sent?.intents ?? [];
  const state = stored ?? looseState(mirror, queued);
  const known = payloadOf(state.row, frozen);              // the row the server holds once `sent` lands
  let intents = state.intents;
  if (stored !== null) {                                   // a legacy successor still in the queue
    for (const op of queued) {
      if (op === sent) continue;
      intents = foldQueued(known, intents, op.payload);
    }
  }
  intents = foldEdit(mirror, intents, writer.payload);
  const baseRev = pendingRev(state, sent);
  const generation = state.generation + 1;
  const next: SettingsBaseline = { ...state, generation, intents, sent: sent?.op_id ?? null };
  return {
    row: settingsMirror(next, sent),
    op: { op_id: writer.op_id, entity: SETTINGS_ENTITY, entity_id: USER_SETTINGS_KEY,
      kind: opKind(baseRev), base_rev: baseRev,
      payload: payloadOf(state.row, frozen, intents), client_ts: writer.client_ts,
      intents, generation },
    result, retire: queued.filter((op) => op !== sent).map((op) => op.op_id),
    meta: [{ key: BASELINE_KEY, value: next }],
  };
}

/** The generation an answer belongs to, or null when nothing is left for it to settle: an op that has
 *  already left the queue (its answer arrived twice, or a second push raced the first) settles
 *  nothing, and neither does an answer for a generation that is no longer the one in flight. */
export function settledGeneration(stored: SettingsBaseline | null, op: OutboxOp | null,
    queued: readonly SettingsOp[]): SettingsOp | null {
  if (op === null) return null;
  const held = queued.find((pending) => pending.op_id === op.op_id);
  if (stored === null || stored.sent === null) return held ?? null;
  if (stored.sent !== op.op_id) return null;
  return held ?? { ...op, generation: 0, intents: diffIntents(stored.row, op.payload) };
}

/** The baseline once a settlement is over (before the still-queued generations are rewritten). */
export function nextState(stored: SettingsBaseline | null, settled: SettingsOp | null,
    settlement: SettingsSettlement, queued: readonly SettingsOp[]): SettingsBaseline {
  const known = stored ?? EMPTY_STATE;
  if (settlement.status === "pull") return afterPull(known, settlement, queued);
  if (settlement.status === "conflict") {
    // The frozen generation was built on the row this device knew; an older build's whole intent is
    // upgraded against it (while it is still that row) before the server's row replaces it.
    return { row: stripServerOwned(settlement.row), rev: settlement.rev, sent: null,
      generation: known.generation,
      intents: mergeIntents((settled ? frozenIntents(known, settled)?.intents : undefined) ?? [], known.intents) };
  }
  if (settlement.status === "applied") return afterApplied(known, settled, settlement.rev);
  if (settlement.status === "duplicate") {
    // The change log holds this generation's payload, so the generation is resolved — but the rev it
    // landed on is not in the answer. A row this device already knows to be newer stands; otherwise
    // the payload is the row, one rev on from the base it was aimed at.
    const base = settled?.base_rev ?? null;
    if (base === null) return { ...known, sent: null };
    return known.rev !== null && known.rev > base
      ? { ...known, sent: null } : afterApplied(known, settled, base + 1);
  }
  if (settlement.status === "drop") return { ...known, sent: null };
  return known;
}

/** `applied`: the generation's own payload IS the row the server holds at that rev. A rev the device
 *  has already been told about (a delayed acknowledgement, after a newer pull) never rolls back. */
function afterApplied(known: SettingsBaseline, settled: SettingsOp | null,
    rev: number): SettingsBaseline {
  const ahead = known.rev === null || rev > known.rev;
  return {
    row: ahead && settled ? stripServerOwned(settled.payload) : known.row,
    rev: ahead ? rev : known.rev,
    generation: known.generation, intents: known.intents, sent: null,
  };
}

/** True when this device has never seen a row the server holds: nothing settled at all, or the
 *  legacy recovery's explicit empty baseline (rev 0). A payload carried since then was built on a
 *  row that was never recorded, so a pull that brings one must be DIFFED against, never promoted. */
function neverSawRow(state: SettingsBaseline): boolean {
  return state.rev === null || state.rev === 0;
}

/** `pull`: the server's row becomes the baseline and the generation in flight stays in flight. A page
 *  that re-states an older (or the same) rev must never roll the baseline back. */
function afterPull(known: SettingsBaseline, pull: Extract<SettingsSettlement, { status: "pull" }>,
    queued: readonly SettingsOp[]): SettingsBaseline {
  if (known.rev !== null && pull.rev <= known.rev) return known;
  const intents = neverSawRow(known) ? looseRecovery(pull.row, queued) : known.intents;
  return { ...known, row: stripServerOwned(pull.row), rev: pull.rev, intents };
}
