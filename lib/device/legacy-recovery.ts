/**
 * W055 (Phase 9 §0.6 "Later"): the owner-proved recovery tool for held legacy ops.
 *
 * The old build's outbox in `smc` carries no proof of its account, so adoption holds every op
 * (lib/device/legacy-adoption.ts). This tool lets the person who owns them say so, one op at a time:
 *  - `listHeldLegacyOps()` is read-only: what is held, as a summary (entity, kind, key, time),
 *    never the payload, and which ops were already recovered and into which account.
 *  - `recoverHeldLegacyOps(h, opIds)` is a DRY RUN by default: it reports what it would queue and
 *    writes nothing. Only with `confirm: RECOVER_CONFIRM` does it queue each chosen op into the
 *    bound account's own outbox under the same `op_id` (the server's op idempotency makes a repeat
 *    of an op it already applied a no-op), and mark it recovered on this device.
 *  - `smc` itself is never written or deleted: an old tab can still write into it (review r5 #2).
 *  - An op already recovered into ANY account is never queued again, so one op cannot reach two
 *    accounts. A malformed op (unknown entity or kind, missing ids) is skipped, never repaired.
 *
 * The server still decides: a queued op goes out under the bound account's session and header,
 * and `/api/sync/ops` applies its own checks. Owner-run from the browser console
 * (`installHeldChangesConsole`), never offered in the app UI.
 */
import { assertCurrent, currentAccountOrNull, type AccountHandle } from "./account";
import { legacyOpRecoveredBy, openLegacy, RECOVERED_PREFIX } from "./legacy-adoption";
import { appendOp, OUTBOX_STORE } from "@/lib/sync/idb";
import { OP_ENTITIES, type Entity, type SyncOp } from "@/lib/sync/types";

/** The words the owner types to prove the chosen ops are theirs. */
export const RECOVER_CONFIRM = "these held changes are mine";

const KINDS: readonly SyncOp["kind"][] = ["create", "update", "delete", "restore"];

export type HeldOpSummary = {
  op_id: string; entity: string; entity_id: string; kind: string; client_ts: string | null;
  /** The account this op was recovered into on this device, or null while it is held. */
  recoveredInto: string | null;
  /** False when the op cannot be recovered as it is (unknown entity or kind, missing ids). */
  valid: boolean;
};

type Raw = Record<string, unknown>;

function toSyncOp(raw: Raw): SyncOp | null {
  const { op_id, entity, entity_id, kind, base_rev, payload, client_ts } = raw;
  if (typeof op_id !== "string" || op_id === "" || typeof entity_id !== "string" || entity_id === "") return null;
  if (!(OP_ENTITIES as readonly string[]).includes(entity as string)) return null;
  if (!KINDS.includes(kind as SyncOp["kind"])) return null;
  if (base_rev !== null && base_rev !== undefined && typeof base_rev !== "number") return null;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return {
    op_id, entity: entity as Entity, entity_id, kind: kind as SyncOp["kind"],
    base_rev: typeof base_rev === "number" ? base_rev : null,
    payload: payload as Record<string, unknown>,
    client_ts: typeof client_ts === "string" ? client_ts : new Date().toISOString(),
  };
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
  for (const opId of new Set(opIds)) {
    const raw = byId.get(opId);
    if (!raw) { result.skipped.push({ op_id: opId, reason: "not_held" }); continue; }
    if (legacyOpRecoveredBy(opId) !== null) {
      result.skipped.push({ op_id: opId, reason: "already_recovered" });
      continue;
    }
    const op = toSyncOp(raw);
    if (!op) { result.skipped.push({ op_id: opId, reason: "malformed" }); continue; }
    if (!dryRun) {
      assertCurrent(h);
      await appendOp(h, op);
      // The mark comes after the op is queued: a crash between them leaves the op held AND queued,
      // and a second recovery re-offers the same op_id, which the outbox keeps as one row.
      localStorage.setItem(`${RECOVERED_PREFIX}${opId}`, h.userId);
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
