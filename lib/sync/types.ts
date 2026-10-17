/** Sync wire types — contracts §3. Lanes A, B and D import from here; no name changes without a
 *  `docs: phase-0 contract change` commit first. */
import { z } from "zod";

export type Entity =
  | "user_foods" | "user_food_prefs" | "log_entries" | "log_items"
  | "water_log" | "plan_days" | "user_settings" | "gut_log" | "duplicate_groups"
  | "recipes" | "favorites_foods" | "favorites_recipes" | "favorites_meals"
  // Outbox-only: the route dispatches one normalized-name operation to set_food_membership.
  | "food_membership"
  // Phase 6: pull-only. The server writes both (approve_target_proposal); the client never
  // enqueues an op for either — `lib/estimator-client.ts` refuses, and the SQL `_sync_*` helpers
  // were deliberately not extended, so a hand-crafted op comes back as an error result.
  | "target_profiles" | "target_proposals";

/** The entities that sync on their own. `log_items` ride inside `log_entries.payload.items[]`;
 *  `recipe_items` and `favorites_meal_items` ride the same way inside their parent's payload. */
export const ENTITIES = [
  "user_foods", "user_food_prefs", "log_entries", "water_log",
  "plan_days", "user_settings", "gut_log", "duplicate_groups",
  "recipes", "favorites_foods", "favorites_recipes", "favorites_meals",
  "target_profiles", "target_proposals",
] as const satisfies readonly Entity[];

export const OP_ENTITIES = [...ENTITIES, "food_membership"] as const satisfies readonly Entity[];

export type SyncedEntity = (typeof ENTITIES)[number];

export type SyncOp = {
  op_id: string; entity: Entity; entity_id: string;
  kind: "create" | "update" | "delete" | "restore";
  base_rev: number | null; payload: Record<string, unknown>; client_ts: string;
};

/** A033: the commit's policy marks for a queued log write the server applied or had already. */
type LogFlags = { flagged?: { path: string; message: string }[] };

export type OpResult =
  | ({ op_id: string; status: "applied"; rev: number; seq: number } & LogFlags)
  /** `at` (W026, migration 20261231180000): when the server's row was last written. Absent from a
   *  server that predates it; `serverTimestampOf` then falls back to the row's own columns. */
  | { op_id: string; status: "conflict"; entity: Entity; current_rev: number; current: unknown; at?: string }
  | { op_id: string; status: "deleted"; entity: Entity; deleted_at: string }
  | ({ op_id: string; status: "gone" | "duplicate" | "unsupported" } & LogFlags)
  /** `retryable` (W026): the database failed for a moment (a timeout, a lost connection, a
   *  serialization failure), so the op is not at fault and must not spend its error budget. */
  | { op_id: string; status: "error"; message: string; retryable?: boolean };

export type ChangeRow = {
  seq: number; entity: Entity; entity_key: string; rev: number;
  op: SyncOp["kind"]; at: string;
  /** The row after the op, children inline. `null` means deleted. */
  current: Record<string, unknown> | null;
};

export type OpsRequest = { ops: SyncOp[]; local_date?: string; time_zone?: string };
/** `server_build` (W026): the deployment that answered. A park recorded under one build is
 *  released when another answers, because a deploy is how a fix reaches an op it refused. */
export type OpsResponse = { results: OpResult[]; server_time: string; server_build?: string };
export type ChangesResponse = { changes: ChangeRow[]; next_cursor: number; has_more: boolean };

/** Body validation for `app/api/sync/ops/route.ts`. An addition, not a contract change. */
export const SyncOpSchema = z.object({
  op_id: z.uuid(),
  entity: z.enum(OP_ENTITIES),
  entity_id: z.string().min(1).max(64),
  kind: z.enum(["create", "update", "delete", "restore"]),
  base_rev: z.number().int().nonnegative().nullable(),
  payload: z.record(z.string(), z.unknown()),
  client_ts: z.iso.datetime({ offset: true }),
  /** Phase 9 §0.5: the account that queued the op. Optional on the wire so an old build's op
   *  parses and gets the `account_unbound` answer instead of a 400 for the whole batch. */
  user_id: z.uuid().optional(),
});

export const OpsRequestSchema = z.object({
  ops: z.array(SyncOpSchema).min(1).max(200),
  /** t24b: the phone's local day and zone when it sent the batch. Optional, so an old build's
   *  batch still parses; the server's target recompute dates by the account's stored zone first,
   *  these only as a fallback (lib/server/account-day.ts, owner ruling 2026-10-08). */
  /** A malformed value is dropped (`catch`), never a 400 for the whole batch. */
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  time_zone: z.string().min(1).max(64).optional().catch(undefined),
});
