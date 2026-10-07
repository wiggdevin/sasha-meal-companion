/**
 * The compare-and-swap server the `user_settings` tests run against — the fake that makes a rev
 * assertion mean something. Shared by `settings-settlement.test.ts` (what each settlement leaves in
 * the mirror), `settings-coalescing.test.ts` (the one-pending-op rule, seventh-round P1) and
 * `settings-generations.test.ts` (the send generations, eighth-round P1).
 *
 * A fake that ignored `base_rev` would have accepted the `[4, 4]` the audit reproduced and proved
 * nothing, so this one mirrors `apply_sync_op` (migration 20260919090300): an update applies only
 * when its `base_rev` IS the row's rev, a create only when there is no row, and everything else
 * answers `conflict` with the row the server holds.
 *
 * Eighth round: the op-id log comes too. `apply_sync_op` answers `duplicate` for an op_id it has
 * already written (the `change_log_op_id` unique index) BEFORE it looks at the rev, so a retry of an
 * op whose answer was lost settles as "the server holds this payload", never as a fresh
 * compare-and-swap.
 */
import type { ChangeRow, OpResult, SyncOp } from "@/lib/sync/types";

/** The settings row the fake server starts from: rev 4, everything set to something recognisable. */
export const FRESH_SETTINGS = { rev: 4, water_goal_cups: 8, water_goal_cups_training: 8,
  water_goal_cups_rest: 7, training_kcal: 2400, protein_g: 110 };

export type ServerRow = Record<string, unknown>;
export type CasServer = {
  row: () => ServerRow | null;
  apply: (ops: SyncOp[]) => OpResult[];
  /** Another device wrote: the row the next pull will bring. */
  moveTo: (row: ServerRow) => void;
};

/** `null` is a server that holds NO settings row at all — the shape `apply_sync_op` answers with
 *  `gone` for an update and inserts for a create (T11b ninth-round finding 2). */
export function casServer(initial: ServerRow | null = null): CasServer {
  let serverRow: ServerRow | null = initial === null ? null : { ...initial };
  let seq = 100;
  const applied = new Set<string>();
  return {
    row: () => serverRow,
    moveTo: (row) => { serverRow = { ...row }; },
    apply: (ops) => ops.map((op) => {
      // The change_log op-id index, checked before the compare-and-swap: an op the server has
      // already written is never re-applied, so its answer is `duplicate` whatever the rev now is.
      if (applied.has(op.op_id)) return { op_id: op.op_id, status: "duplicate" };
      const rev = Number(serverRow?.rev ?? 0);
      if (op.kind === "create" && serverRow !== null) {
        return { op_id: op.op_id, status: "conflict", entity: "user_settings",
          current_rev: rev, current: serverRow };
      }
      if (op.kind !== "create" && (serverRow === null || (op.base_rev ?? 0) !== rev)) {
        return { op_id: op.op_id, status: "conflict", entity: "user_settings",
          current_rev: rev, current: serverRow ?? {} };
      }
      seq += 1;
      applied.add(op.op_id);
      serverRow = { ...(serverRow ?? {}), ...op.payload, rev: rev + 1 };
      return { op_id: op.op_id, status: "applied", rev: rev + 1, seq };
    }),
  };
}

export function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200,
    headers: { "content-type": "application/json" } });
}

/**
 * The two routes the sync client calls, answered by `server`. `results` overrides the answer to
 * `/api/sync/ops`, which is how a test reproduces a partial response or a `duplicate`.
 */
export function serverFetch(server: CasServer, over: { results?: (ops: SyncOp[]) => OpResult[] } = {}) {
  return (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/sync/changes")) {
      // A cursor the feed has already passed carries nothing back — which is why a device that lost
      // its settings baseline re-reads the feed from the start (lib/sync/client.ts).
      const since = Number(new URL(String(url), "https://app.test").searchParams.get("since") ?? 0);
      const row = server.row();
      const changes: ChangeRow[] = row === null || since >= 1
        ? [] : [{ seq: 1, entity: "user_settings", entity_key: "settings",
          rev: Number(row.rev ?? 0), op: "update", at: "2026-09-12T18:00:00.000Z", current: row }];
      return json({ changes, next_cursor: 1, has_more: false });
    }
    const { ops } = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
    return json({ results: over.results ? over.results(ops) : server.apply(ops),
      server_time: "2026-09-12T18:00:05.000Z" });
  }) as unknown as typeof fetch;
}

/**
 * A push the server APPLIES at once, whose answer the test releases by hand. That is the only way to
 * hold a response in flight while a local edit lands: the `applied` the client finally sees describes
 * a generation the outbox has already moved past.
 */
export function gatedServerFetch(server: CasServer): {
  fetchFn: typeof fetch; reached: Promise<void>; release: () => void;
} {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrived!: () => void;
  const reached = new Promise<void>((resolve) => { arrived = resolve; });
  const base = serverFetch(server);
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/api/sync/ops")) return base(url, init);
    const { ops } = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
    const results = server.apply(ops);
    arrived();
    await gate;
    return json({ results, server_time: "2026-09-12T18:00:05.000Z" });
  }) as unknown as typeof fetch;
  return { fetchFn, reached, release };
}

/** A push the server applies whose ANSWER never arrives — the request dies on the way back. */
export function applyThenDropFetch(server: CasServer): typeof fetch {
  const base = serverFetch(server);
  return (async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith("/api/sync/ops")) return base(url, init);
    const { ops } = JSON.parse(String(init?.body)) as { ops: SyncOp[] };
    server.apply(ops);
    throw new TypeError("network error after the write landed");
  }) as unknown as typeof fetch;
}

/** One changes page carrying a single `user_settings` row, as `/api/sync/changes` returns it. */
export function settingsPage(row: Record<string, unknown>) {
  const change: ChangeRow = { seq: 1, entity: "user_settings", entity_key: "settings", rev: 4,
    op: "update", at: "2026-09-12T18:00:00.000Z", current: row };
  return async () => new Response(JSON.stringify({ changes: [change], next_cursor: 1,
    has_more: false }), { status: 200, headers: { "content-type": "application/json" } });
}
