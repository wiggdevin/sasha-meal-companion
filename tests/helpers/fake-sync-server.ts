/**
 * An in-memory stand-in for `apply_sync_op` and `sync_changes`
 * (supabase/migrations/20260919090300_phase3_sync_entities.sql), for tests that drive two devices'
 * real outbox and pull code against ONE server. It answers the same statuses in the same order:
 * duplicate op id, create on an existing row (tombstoned or not) is a conflict, a missing row is
 * gone, a tombstoned row refuses every op but restore, a restore of a live row is an idempotent
 * no-op, and a stale base is a conflict carrying the whole current row. A delete feeds
 * `current: null`, as the real change log does.
 *
 * Rows are stored whole: an update writes `{ ...current, ...payload }`, as `_sync_upsert` writes
 * every column the payload names.
 */
import type { ChangeRow, ChangesResponse, OpResult, OpsResponse, SyncOp } from "@/lib/sync/types";

type Row = Record<string, unknown>;

export class FakeSyncServer {
  private readonly rows = new Map<string, Row>();
  private readonly log: ChangeRow[] = [];
  private readonly seen = new Set<string>();
  private clock = 0;

  /** Runs while a push is on the wire, before the server applies it: a tap mid round trip. */
  duringPush: (() => Promise<void>) | null = null;
  /** The next push: `down` answers 503 and applies nothing; `lost` applies, then answers 503
   *  (the commit landed and its answer never arrived). */
  nextPush: "down" | "lost" | null = null;
  /** The next pull: `down` answers 503 and reads nothing. */
  nextPull: "down" | null = null;
  /** Every op the server was sent, in order. */
  readonly received: SyncOp[] = [];

  /** The row the server holds now, or undefined. */
  row(entity: string, key: string): Row | undefined {
    return this.rows.get(`${entity}:${key}`);
  }

  /** Seed a row as if an earlier write had made it, with its own change-log entry. */
  seed(entity: SyncOp["entity"], key: string, row: Row): void {
    const stored = { ...row, rev: 1, updated_at: this.tick() };
    this.rows.set(`${entity}:${key}`, stored);
    this.append(entity, key, 1, "create", stored);
  }

  apply(op: SyncOp): OpResult {
    if (this.seen.has(op.op_id)) return { op_id: op.op_id, status: "duplicate" };
    const id = `${op.entity}:${op.entity_id}`;
    const current = this.rows.get(id);
    const conflict = (): OpResult => ({ op_id: op.op_id, status: "conflict", entity: op.entity,
      current_rev: Number(current!.rev), current: { ...current } });
    let rev: number;
    if (op.kind === "create") {
      if (current) return conflict();
      rev = 1;
    } else {
      if (!current) return { op_id: op.op_id, status: "gone" };
      if (current.deleted_at && op.kind !== "restore") {
        return { op_id: op.op_id, status: "deleted", entity: op.entity,
          deleted_at: String(current.deleted_at) };
      }
      if (op.kind === "restore" && !current.deleted_at) {
        return { op_id: op.op_id, status: "applied", rev: Number(current.rev), seq: this.lastSeq() };
      }
      if (op.base_rev === null || op.base_rev !== current.rev) return conflict();
      rev = Number(current.rev) + 1;
    }
    const at = this.tick();
    const after: Row = op.kind === "delete" ? { ...current, deleted_at: at, rev, updated_at: at }
      : op.kind === "restore" ? { ...current, deleted_at: null, rev, updated_at: at }
      : { ...(current ?? {}), ...op.payload, rev, updated_at: at };
    this.rows.set(id, after);
    this.seen.add(op.op_id);
    const seq = this.append(op.entity, op.entity_id, rev, op.kind,
      op.kind === "delete" ? null : after);
    return { op_id: op.op_id, status: "applied", rev, seq };
  }

  changes(since: number, limit: number): ChangesResponse {
    const page = this.log.filter((change) => change.seq > since).slice(0, limit);
    const next = page.length > 0 ? page[page.length - 1].seq : since;
    return { changes: page, next_cursor: next, has_more: this.log.some((c) => c.seq > next) };
  }

  /** The two sync routes, for `pullChanges` / `pushOutbox` / `syncOnce` `fetchFn`. */
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/sync/changes") {
      const fault = this.nextPull;
      this.nextPull = null;
      if (fault === "down") return new Response("down", { status: 503 });
      return json(this.changes(Number(url.searchParams.get("since") ?? 0),
        Number(url.searchParams.get("limit") ?? 500)));
    }
    if (url.pathname === "/api/sync/ops") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { ops: SyncOp[] };
      const hook = this.duringPush;
      this.duringPush = null;
      if (hook) await hook();
      const fault = this.nextPush;
      this.nextPush = null;
      if (fault === "down") return new Response("down", { status: 503 });
      this.received.push(...body.ops);
      const response: OpsResponse = {
        results: body.ops.map((op) => this.apply(op)), server_time: this.tick(),
      };
      return fault === "lost" ? new Response("lost", { status: 503 }) : json(response);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  private append(entity: SyncOp["entity"], key: string, rev: number, op: SyncOp["kind"],
    current: Row | null): number {
    const seq = this.lastSeq() + 1;
    this.log.push({ seq, entity, entity_key: key, rev, op, at: this.tick(),
      current: current === null ? null : { ...current } });
    return seq;
  }

  private lastSeq(): number {
    return this.log.length > 0 ? this.log[this.log.length - 1].seq : 0;
  }

  /** The server's own clock: never behind the test's (faked) Date, and strictly increasing. */
  private tick(): string {
    this.clock = Math.max(this.clock + 1_000, Date.now());
    return new Date(this.clock).toISOString();
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });
}
