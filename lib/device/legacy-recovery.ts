/**
 * W055 (Phase 9 §0.6 "Later"): the owner-proved recovery tool for held legacy ops.
 *
 * The old build's outbox in `smc` carries no proof of its account, so adoption holds every op
 * (lib/device/legacy-adoption.ts). This tool lets the person who owns them say so, one op at a time:
 *  - `listHeldLegacyOps()` is read-only: what is held, as a summary (entity, kind, key, time),
 *    never the payload, and which ops were already recovered and into which account.
 *  - `recoverHeldLegacyOps(h, opIds)` is a DRY RUN by default: it reports what it would queue and
 *    writes nothing. Only with `confirm: RECOVER_CONFIRM` does it mark each chosen op as this
 *    account's on this device, then queue it into the bound account's own outbox under the same
 *    `op_id` (the server answers `duplicate` for an op it already applied), in the old queue order.
 *  - `smc` itself is never written or deleted: an old tab can still write into it (review r5 #2).
 *  - An op already recovered into ANY account is never queued again, so one op cannot reach two
 *    accounts. An op the wire schema would refuse is skipped, never repaired.
 *
 * The server still decides: a queued op goes out under the bound account's session and header,
 * and `/api/sync/ops` applies its own checks. Owner-run from the browser console
 * (`installHeldChangesConsole`), never offered in the app UI.
 */
import { assertCurrent, currentAccountOrNull, type AccountHandle } from "./account";
import { legacyOpRecoveredBy, openLegacy, RECOVERED_PREFIX } from "./legacy-adoption";
import { OUTBOX_STORE } from "@/lib/sync/idb";
import { encodeKey } from "@/lib/sync/keys";
import { enqueue } from "@/lib/sync/outbox";
import { SyncOpSchema, type SyncOp } from "@/lib/sync/types";

/** The words the owner types to prove the chosen ops are theirs. */
export const RECOVER_CONFIRM = "these held changes are mine";

export type HeldOpSummary = {
  op_id: string; entity: string; entity_id: string; kind: string; client_ts: string | null;
  /** The account this op was recovered into on this device, or null while it is held. */
  recoveredInto: string | null;
  /** False when the op cannot be recovered as it is (the wire schema or its key refuses it). */
  valid: boolean;
};

type Raw = Record<string, unknown>;

/**
 * The op exactly as the wire schema takes it (Sol review: anything looser would make the server
 * refuse the whole sync batch with 400 and park unrelated ops), and whose key agrees with its
 * payload (what `enqueue` asserts). Anything else stays held.
 */
function toSyncOp(raw: Raw): SyncOp | null {
  const { op_id, entity, entity_id, kind, base_rev, payload, client_ts } = raw;
  const parsed = SyncOpSchema.safeParse({ op_id, entity, entity_id, kind, base_rev: base_rev ?? null,
    payload, client_ts });
  if (!parsed.success) return null;
  const { user_id: _owner, ...op } = parsed.data;
  void _owner;
  if (op.kind === "create" || op.kind === "update") {
    try { if (encodeKey(op.entity, op.payload) !== op.entity_id) return null; } catch { return null; }
  }
  return op;
}

async function readHeldOps(): Promise<Raw[] | "unknown"> {
  const db = await openLegacy();
  if (db === "unknown") return "unknown";
  if (db === null) return [];
  try {
    return db.objectStoreNames.contains(OUTBOX_STORE) ? await db.getAll(OUTBOX_STORE) as Raw[] : [];
  } finally {
    db.close();
  }
}

function summary(raw: Raw): HeldOpSummary {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    op_id: str(raw.op_id), entity: str(raw.entity), entity_id: str(raw.entity_id), kind: str(raw.kind),
    client_ts: typeof raw.client_ts === "string" ? raw.client_ts : null,
    recoveredInto: typeof raw.op_id === "string" ? legacyOpRecoveredBy(raw.op_id) : null,
    valid: toSyncOp(raw) !== null,
  };
}

/** Read-only. `unknown` when this browser cannot say whether `smc` exists (nothing is opened). */
export async function listHeldLegacyOps(): Promise<HeldOpSummary[] | "unknown"> {
  const ops = await readHeldOps();
  return ops === "unknown" ? ops : ops.map(summary);
}

export type RecoveryResult = {
  dryRun: boolean;
  /** Queued into the account's outbox (or, on a dry run, would be). */
  recovered: string[];
  skipped: { op_id: string; reason: "not_held" | "already_recovered" | "malformed" }[];
};

/**
 * Dry run unless `confirm` is exactly RECOVER_CONFIRM. Only the op ids named are touched; an empty
 * list touches nothing ("recover everything" is not offered: the owner names each op).
 */
export async function recoverHeldLegacyOps(
  h: AccountHandle, opIds: readonly string[], opts: { confirm?: string } = {},
): Promise<RecoveryResult> {
  const dryRun = opts.confirm !== RECOVER_CONFIRM;
  const held = await readHeldOps();
  if (held === "unknown") throw new Error("This browser cannot list the held changes.");
  const byId = new Map(held.map((r) => [r.op_id, r] as const));
  const result: RecoveryResult = { dryRun, recovered: [], skipped: [] };
  const chosen: { opId: string; seq: number; op: SyncOp }[] = [];
  for (const opId of new Set(opIds)) {
    const raw = byId.get(opId);
    if (!raw) { result.skipped.push({ op_id: opId, reason: "not_held" }); continue; }
    // An op marked for another account never moves; one marked for this account may resume (a
    // crash after the mark and before the queue), and the outbox keeps one row per op_id.
    const owner = legacyOpRecoveredBy(opId);
    if (owner !== null && owner !== h.userId) {
      result.skipped.push({ op_id: opId, reason: "already_recovered" });
      continue;
    }
    const op = toSyncOp(raw);
    if (!op) { result.skipped.push({ op_id: opId, reason: "malformed" }); continue; }
    chosen.push({ opId, seq: typeof raw.seq === "number" ? raw.seq : Number.MAX_SAFE_INTEGER, op });
  }
  // The old queue's order, whatever order the owner named them in: two edits of one row must
  // reach the server as they were made (Sol review).
  chosen.sort((x, y) => x.seq - y.seq);
  for (const { opId, op } of chosen) {
    if (!dryRun) {
      assertCurrent(h);
      // The owner mark is written FIRST (Sol review P1): if storage refuses it, nothing is queued,
      // so an op can never sit in one account's outbox while it still looks held to another.
      localStorage.setItem(`${RECOVERED_PREFIX}${opId}`, h.userId);
      // `enqueue` also announces the op, so the sync scheduler sends it now.
      await enqueue(h, op);
    }
    result.recovered.push(opId);
  }
  return result;
}

type HeldChangesConsole = {
  list: () => Promise<HeldOpSummary[] | "unknown">;
  recover: (opIds: string[], confirm?: string) => Promise<RecoveryResult>;
};

/**
 * The owner's entry point: `await smcHeldChanges.list()`, then
 * `await smcHeldChanges.recover(["<op_id>"])` (dry run) and
 * `await smcHeldChanges.recover(["<op_id>"], "these held changes are mine")`.
 * Installed only on a phone that holds changes; it acts on the account bound when it is called.
 */
export function installHeldChangesConsole(target: object = globalThis): void {
  const api: HeldChangesConsole = {
    list: listHeldLegacyOps,
    recover: async (opIds, confirm) => {
      const h = currentAccountOrNull();
      if (h === null) throw new Error("Sign in to the account these changes belong to first.");
      return recoverHeldLegacyOps(h, opIds, { confirm });
    },
  };
  Object.defineProperty(target, "smcHeldChanges", { value: api, configurable: true });
}
