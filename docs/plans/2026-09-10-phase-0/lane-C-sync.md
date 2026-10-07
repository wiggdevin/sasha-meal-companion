# Lane C — Sync engine (Phase 0)

**For agentic workers:** execute with `superpowers:subagent-driven-development`. One task per
subagent, in order. A task is done when its last `pnpm test` prints PASS and its commit exists.

## Goal

One durable, offline-first sync engine for Sasha's phone and laptop: an IndexedDB mirror of the v2.1
user tables, an outbox of compare-and-swap ops, a merge that never loses a note or un-drinks a cup of
water, and two JWT routes over Lane A's `apply_sync_op` / `sync_changes`. No visible feature — the
two devices simply stop disagreeing.

## Architecture

A local write lands in `lib/store.ts` as it does today and also enqueues a `SyncOp` in the IndexedDB
outbox. `pushOutbox` drains to `POST /api/sync/ops`, one `apply_sync_op` RPC per op in array order. A
`conflict` result carries the full current server row, so the client merges locally (`mergeEntity`),
rebases onto `current_rev` (`rebaseOp`) and re-enqueues — no second round trip. `pullChanges` reads
`GET /api/sync/changes?since=<seq>` and writes each `ChangeRow.current` straight into the matching
store, saving `next_cursor` only after the whole page is applied. `SyncBootstrap` fires both on open,
on return, on reconnect and 1.5 s after a local save.

`lib/store.ts`, `lib/sync.ts`, `lib/server/db.ts` and `app/api/sync/route.ts` still serve the phone.
This lane is **additive**; the store switch and the legacy deletion belong to the integration branch.

## Tech Stack

Next.js 16.3.4 (App Router, `runtime = "nodejs"`), React 19.2.8, TypeScript 5, Tailwind 4, pnpm
11.25.0, Node 22, vitest 5 (`environment: "node"`, `include: ["**/*.test.ts"]`), `idb` 8.0.3, zod
4.5.4, `@supabase/ssr` 0.12.7, Supabase Postgres 17, Vercel.

## Spec path

`docs/specs/phase-0-foundations.md`. Frozen interfaces: `docs/plans/2026-09-10-phase-0/00-contracts.md`.
Authority: `docs/architecture.md` §2.1, §3.2, §3.3, §3.7 > spec > contracts > this plan.

## Global Constraints (contracts §8)

- TDD per task: failing test → run → minimal code → run → commit. Conventional commits, no AI
  attribution lines.
- No module-level Supabase client anywhere except `lib/server/admin.ts`'s lazy admin client.
- `user_id` never read from a request body. Errors are `{ error, message }`, never echo the body.
- Every route: `enforceRateLimit` first, then identity, then body parse with `readJson`.
- Files < 400 lines; functions < 50 lines.
- Before a PR: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test <your files>`; never the full suite twice.

**Two deliberate deviations** (Open questions 2 and 4): both sync routes are limited 60/min/**user**,
so the key needs an identity — they run `requireUser` → `enforceRateLimit` → `readJson`. And
`entryFingerprint` returns `Promise<string>`, not `string`, because `subtle.digest` is async; the
synchronous pre-image builder is exported separately as `fingerprintSource`.

**Lane B gate.** Tasks 12–15 import `lib/server/auth.ts`, `lib/server/http.ts`,
`lib/server/ratelimit.ts`, `lib/supabase/client.ts`. Vitest resolves `vi.mock` ids on the real
filesystem, so those files must exist first; each gated task opens with a `ls` step. Tasks 1–11 have
no cross-lane dependency.

## File structure

| File | Responsibility |
|---|---|
| `lib/sync/types.ts` | **Create.** Contracts §3 wire types + the zod schemas the routes parse with. |
| `lib/sync/keys.ts` + `.test.ts` | **Create.** `encodeKey` / `decodeKey` — the only place that knows the four key shapes of contracts §4. |
| `lib/sync/merge.ts` + `.test.ts` | **Create.** `mergeEntity`, `rebaseOp`, `NEVER_MERGED` — every row of architecture §3.7's merge table. |
| `lib/sync/fingerprint.ts` + `.test.ts` | **Create.** The §3.7 duplicate fingerprint over an isomorphic SHA-256 helper. |
| `lib/sync/idb.ts` + `.test.ts` | **Create.** IndexedDB `smc` v1: one store per `ENTITIES` entity keyed by `entity_key`, `outbox` keyed by `op_id`, `meta` for the cursor. |
| `lib/sync/outbox.ts` + `.test.ts` | **Create.** `enqueue`, `backoffMs`, `applyResult`, `drainOutbox`, `pendingCount`. |
| `lib/sync/client.ts` + `.test.ts` | **Create.** `pullChanges`, `pushOutbox`, `syncOnce`, `SYNCED_EVENT`, last-sync stamp. |
| `app/api/sync/ops/route.ts` | **Create.** POST, 60/min/user, ≤ 200 ops, ≤ 1 MB, one RPC per op in order. |
| `app/api/sync/changes/route.ts` | **Create.** GET, 60/min/user, numeric `since`, `limit` ≤ 500. |
| `tests/sync/ops-route.test.ts` | **Create.** Auth, shape, size, order, every status passed through. |
| `tests/sync/changes-route.test.ts` | **Create.** Auth, `since` validation, clamp, `next_cursor` / `has_more`. |
| `tests/sync/two-client.test.ts` | **Create.** `[needs branch]` the spec's two-client matrix and cursor continuity. |
| `tests/sync/cross-user-http.test.ts` | **Create.** `[needs branch]` user B's ops against user A's entity keys get `gone`/zero effect; user B's `GET /api/sync/changes` returns none of A's rows; unauthenticated → 401. |
| `components/SyncBootstrap.tsx` | **Modify.** Same four triggers, new engine; the `#k=` token path goes. |
| `components/SyncStatus.tsx` | **Modify.** Email, pending count, last sync, signed-out state. |

---

## Task 1 — Lane branch

**Files** — none. Test path: none.

**Interfaces** — Consumes: contracts §7 (`idb`, `zod`, and — as of the 2026-09-10 contract update —
`fake-indexeddb` are already installed on `main`, ahead of any lane branching). Produces: nothing;
this task only cuts the branch.

`lib/sync/idb.ts` (Task 7) needs an IndexedDB fake to test against, and contracts §1 still bars a
lane from touching `package.json` dependencies — but that is no longer this lane's problem:
`fake-indexeddb` is a `main` devDependency already, installed in the pre-lane setup (contracts §7),
so there is nothing to add here.

- [ ] Cut the branch.
  ```bash
  cd /Users/zero-suminc./projects/clients/Sasha/meal-companion && git checkout main && git pull && git checkout -b feat/p0-sync
  ```
- [ ] Confirm the fake is already present (expected: `fake-indexeddb` printed).
  ```bash
  ls node_modules | grep -x fake-indexeddb
  ```

---

## Task 2 — `lib/sync/types.ts`: the frozen wire types

**Files** — Create: `lib/sync/types.ts`. Test path: none of its own; Task 3 is the first compile-time consumer.

**Interfaces** — Consumes: nothing. Produces (contracts §3, verbatim): `Entity`, `ENTITIES`,
`SyncOp`, `OpResult`, `ChangeRow`, `OpsRequest`, `OpsResponse`, `ChangesResponse`, plus
`SyncOpSchema` and `OpsRequestSchema`.

- [ ] Write the file. It is the contract — there is nothing to red-test, and Task 3 fails to compile
      if a name is wrong.
  ```ts
  // lib/sync/types.ts
  /** Sync wire types — contracts §3. Lanes A, B and D import from here; no name changes without a
   *  `docs: phase-0 contract change` commit first. */
  import { z } from "zod";

  export type Entity =
    | "user_foods" | "user_food_prefs" | "log_entries" | "log_items"
    | "water_log" | "plan_days" | "user_settings" | "gut_log" | "duplicate_groups";

  /** The entities that sync on their own. `log_items` ride inside `log_entries.payload.items[]`. */
  export const ENTITIES = [
    "user_foods", "user_food_prefs", "log_entries", "water_log",
    "plan_days", "user_settings", "gut_log", "duplicate_groups",
  ] as const satisfies readonly Entity[];

  export type SyncedEntity = (typeof ENTITIES)[number];

  export type SyncOp = {
    op_id: string; entity: Entity; entity_id: string;
    kind: "create" | "update" | "delete" | "restore";
    base_rev: number | null; payload: Record<string, unknown>; client_ts: string;
  };

  export type OpResult =
    | { op_id: string; status: "applied"; rev: number; seq: number }
    | { op_id: string; status: "conflict"; entity: Entity; current_rev: number; current: unknown }
    | { op_id: string; status: "deleted"; entity: Entity; deleted_at: string }
    | { op_id: string; status: "gone" | "duplicate" | "unsupported" }
    | { op_id: string; status: "error"; message: string };

  export type ChangeRow = {
    seq: number; entity: Entity; entity_key: string; rev: number;
    op: SyncOp["kind"]; at: string;
    /** The row after the op, children inline. `null` means deleted. */
    current: Record<string, unknown> | null;
  };

  export type OpsRequest = { ops: SyncOp[] };
  export type OpsResponse = { results: OpResult[]; server_time: string };
  export type ChangesResponse = { changes: ChangeRow[]; next_cursor: number; has_more: boolean };

  /** Body validation for `app/api/sync/ops/route.ts`. An addition, not a contract change. */
  export const SyncOpSchema = z.object({
    op_id: z.uuid(),
    entity: z.enum(ENTITIES),
    entity_id: z.string().min(1).max(64),
    kind: z.enum(["create", "update", "delete", "restore"]),
    base_rev: z.number().int().nonnegative().nullable(),
    payload: z.record(z.string(), z.unknown()),
    client_ts: z.iso.datetime({ offset: true }),
  });

  export const OpsRequestSchema = z.object({ ops: z.array(SyncOpSchema).min(1).max(200) });
  ```
- [ ] Type-check (expected: no output, exit 0).
  ```bash
  pnpm exec tsc --noEmit
  ```
- [ ] Commit.
  ```bash
  git add lib/sync/types.ts && git commit -m "feat(sync): add the frozen sync wire types and op schemas"
  ```

---

## Task 3 — `lib/sync/keys.ts`: entity-key encode and decode

**Files** — Create: `lib/sync/keys.ts`. Test path: `lib/sync/keys.test.ts`.

**Interfaces** — Consumes: `Entity` from `./types`. Produces (contracts §4):
`encodeKey(entity: Entity, row: Record<string, unknown>): string` and
`decodeKey(entity: Entity, key: string): Record<string, unknown>`.

- [ ] Write the failing test.
  ```ts
  // lib/sync/keys.test.ts
  import { describe, expect, it } from "vitest";
  import { decodeKey, encodeKey } from "./keys";

  const UUID = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";
  const LOWER = UUID.toLowerCase();

  describe("encodeKey", () => {
    it("lowercases the UUID for id-keyed entities", () => {
      for (const e of ["user_foods", "log_entries", "gut_log", "duplicate_groups"] as const) {
        expect(encodeKey(e, { id: UUID })).toBe(LOWER);
      }
    });
    it("uses YYYY-MM-DD for date-keyed entities, trimming a timestamp", () => {
      expect(encodeKey("plan_days", { local_date: "2026-09-11" })).toBe("2026-09-11");
      expect(encodeKey("water_log", { local_date: "2026-09-11T00:00:00.000Z" })).toBe("2026-09-11");
    });
    it("is the literal 'settings' for user_settings", () => {
      expect(encodeKey("user_settings", {})).toBe("settings");
      expect(encodeKey("user_settings", { user_id: UUID })).toBe("settings");
    });
    it("uses food_ref_id for user_food_prefs", () => {
      expect(encodeKey("user_food_prefs", { food_ref_id: UUID })).toBe(LOWER);
    });
    it("refuses a bad row and refuses log_items, which never syncs alone", () => {
      expect(() => encodeKey("log_entries", {})).toThrow(/log_entries/);
      expect(() => encodeKey("plan_days", { local_date: "11/09/2026" })).toThrow(/local_date/);
      expect(() => encodeKey("user_food_prefs", { food_ref_id: "nope" })).toThrow(/food_ref_id/);
      expect(() => encodeKey("log_items", { id: UUID })).toThrow(/log_items/);
    });
  });

  describe("decodeKey", () => {
    it("returns the primary-key columns and round-trips every synced entity", () => {
      const rows: Record<string, Record<string, unknown>> = {
        user_foods: { id: LOWER }, user_food_prefs: { food_ref_id: LOWER },
        log_entries: { id: LOWER }, water_log: { local_date: "2026-09-11" },
        plan_days: { local_date: "2026-09-11" }, user_settings: {},
        gut_log: { id: LOWER }, duplicate_groups: { id: LOWER },
      };
      for (const [entity, row] of Object.entries(rows)) {
        expect(decodeKey(entity as never, encodeKey(entity as never, row))).toEqual(row);
      }
    });
    it("refuses a malformed key", () => {
      expect(() => decodeKey("log_entries", "not-a-uuid")).toThrow(/log_entries/);
      expect(() => decodeKey("plan_days", "2026-9-1")).toThrow(/plan_days/);
      expect(() => decodeKey("user_settings", "other")).toThrow(/user_settings/);
    });
  });
  ```
- [ ] Run it. Expected failure: `Error: Failed to load url ./keys (resolved id: …/lib/sync/keys)`
  ```bash
  pnpm test lib/sync/keys.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/sync/keys.ts
  /** Entity-key encoding — contracts §4, architecture §3.7. The ONLY place that knows the four key
   *  shapes of the synced tables. Lane A's SQL must produce identical strings. */
  import type { Entity } from "./types";

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const ID_KEYED = new Set<Entity>(["user_foods", "log_entries", "gut_log", "duplicate_groups"]);
  const DATE_KEYED = new Set<Entity>(["plan_days", "water_log"]);

  function fail(entity: Entity, column: string, value: unknown): never {
    throw new TypeError(`${entity}: ${column} is not a valid entity key (got ${JSON.stringify(value)})`);
  }

  function uuid(entity: Entity, column: string, value: unknown): string {
    const lower = typeof value === "string" ? value.toLowerCase() : "";
    if (!UUID_RE.test(lower)) fail(entity, column, value);
    return lower;
  }

  function localDate(entity: Entity, value: unknown): string {
    const text = typeof value === "string" ? value.slice(0, 10) : "";
    if (!DATE_RE.test(text)) fail(entity, "local_date", value);
    return text;
  }

  export function encodeKey(entity: Entity, row: Record<string, unknown>): string {
    if (ID_KEYED.has(entity)) return uuid(entity, "id", row.id);
    if (DATE_KEYED.has(entity)) return localDate(entity, row.local_date);
    if (entity === "user_settings") return "settings";
    if (entity === "user_food_prefs") return uuid(entity, "food_ref_id", row.food_ref_id);
    throw new TypeError(`${entity}: not a synced entity — it has no entity_key of its own`);
  }

  export function decodeKey(entity: Entity, key: string): Record<string, unknown> {
    if (ID_KEYED.has(entity)) return { id: uuid(entity, "id", key) };
    if (DATE_KEYED.has(entity)) return { local_date: localDate(entity, key) };
    if (entity === "user_settings") {
      if (key !== "settings") fail(entity, "entity_key", key);
      return {}; // the PK is user_id, which the client never supplies (contracts §8)
    }
    if (entity === "user_food_prefs") return { food_ref_id: uuid(entity, "food_ref_id", key) };
    throw new TypeError(`${entity}: not a synced entity — it has no entity_key of its own`);
  }
  ```
- [ ] Run it. Expected: `Tests  7 passed (7)`.
  ```bash
  pnpm test lib/sync/keys.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/sync/keys.ts lib/sync/keys.test.ts && git commit -m "feat(sync): encode and decode entity keys for every synced shape"
  ```

---

## Task 4 — `lib/sync/merge.ts`: field-wise core, notes, tombstones

**Files** — Create: `lib/sync/merge.ts`. Test path: `lib/sync/merge.test.ts`.

**Interfaces** — Consumes: `Entity` from `./types`. Produces:
```ts
export type Row<E extends Entity = Entity> = Record<string, unknown> & { readonly __entity?: E };
export const NEVER_MERGED: ReadonlySet<string>;                 // 'target_profiles'
export class MergeRefusedError extends Error { constructor(entity: string) }
export function newerWinsFields(local: Row, server: Row, localTs: string, serverTs: string): Row;
export function joinNotes(a: unknown, b: unknown, aTs: string, bTs: string): string | undefined;
export function mergeEntity<E extends Entity>(entity: E, local: Row<E>, server: Row<E>,
  localTs: string, serverTs: string): Row<E>;
```

This task covers the newer-client_ts-per-field family (`user_foods`, `plan_days`, `user_settings`,
`gut_log`, `duplicate_groups`), the note join and tombstone dominance. Task 5 adds the four special
rows and `rebaseOp`.

- [ ] Write the failing test.
  ```ts
  // lib/sync/merge.test.ts
  import { describe, expect, it } from "vitest";
  import { MergeRefusedError, mergeEntity, NEVER_MERGED } from "./merge";

  const OLD = "2026-09-10T10:00:00.000Z";
  const NEW = "2026-09-10T11:00:00.000Z";

  describe("mergeEntity — newer client_ts per field", () => {
    it("takes the newer side's value where both define a field", () => {
      const m = mergeEntity("plan_days",
        { local_date: "2026-09-11", floor_day: true, rev: 3 },
        { local_date: "2026-09-11", floor_day: false, rev: 4 }, NEW, OLD);
      expect(m.floor_day).toBe(true);
    });
    it("keeps a field the newer side never had", () => {
      const m = mergeEntity("plan_days",
        { local_date: "2026-09-11", day_type_override: "rest" },
        { local_date: "2026-09-11", floor_day: true }, OLD, NEW);
      expect(m).toMatchObject({ day_type_override: "rest", floor_day: true });
    });
    it("settles on the server's rev, so the caller can rebase", () => {
      expect(mergeEntity("user_settings", { rev: 2 }, { rev: 7 }, NEW, OLD).rev).toBe(7);
    });
    it("takes the newer state for duplicate_groups", () => {
      const m = mergeEntity("duplicate_groups",
        { id: "a", state: "open" }, { id: "a", state: "dismissed" }, OLD, NEW);
      expect(m.state).toBe("dismissed");
    });
    it("merges gut_log per field", () => {
      const m = mergeEntity("gut_log",
        { id: "a", state: "flare", note: "bad night" }, { id: "a", state: "iffy" }, NEW, OLD);
      expect(m).toMatchObject({ state: "flare", note: "bad night" });
    });
  });

  describe("mergeEntity — deletes dominate", () => {
    it("keeps a tombstone the other side has not seen", () => {
      const m = mergeEntity("user_foods",
        { id: "a", name: "oat milk", deleted_at: null },
        { id: "a", name: "oat milk", deleted_at: "2026-09-10T09:00:00.000Z" }, NEW, OLD);
      expect(m.deleted_at).toBe("2026-09-10T09:00:00.000Z");
    });
    it("keeps a local tombstone against a newer server edit", () => {
      const m = mergeEntity("user_foods",
        { id: "a", deleted_at: "2026-09-10T09:30:00.000Z" },
        { id: "a", name: "oats", deleted_at: null }, OLD, NEW);
      expect(m.deleted_at).toBe("2026-09-10T09:30:00.000Z");
    });
  });

  describe("mergeEntity — never merged", () => {
    it("lists target_profiles and refuses to merge it", () => {
      expect(NEVER_MERGED.has("target_profiles")).toBe(true);
      expect(() => mergeEntity("target_profiles" as never, {}, {}, OLD, NEW)).toThrow(MergeRefusedError);
    });
  });
  ```
- [ ] Run it. Expected failure: `Error: Failed to load url ./merge (resolved id: …/lib/sync/merge)`
  ```bash
  pnpm test lib/sync/merge.test.ts
  ```
- [ ] Write the implementation (Task 5 appends to this file).
  ```ts
  // lib/sync/merge.ts
  /**
   * Per-entity conflict merge — architecture §3.7's merge table. Pure, no I/O.
   *
   * Each side carries ONE timestamp: the op's `client_ts` locally, the row's own stamp on the
   * server. "Field-wise, newer client_ts" therefore means: where both sides define a field the
   * newer side wins; where only one side defines it, that value survives.
   */
  import type { Entity } from "./types";

  /** A synced row on the wire. `E` records which entity the caller means; it does not narrow the
   *  columns yet — per-entity row types arrive with the generated Supabase types in Phase 1. */
  export type Row<E extends Entity = Entity> = Record<string, unknown> & { readonly __entity?: E };

  /** Server wins outright; the client discards its op and says "targets changed elsewhere". */
  export const NEVER_MERGED: ReadonlySet<string> = new Set(["target_profiles"]);

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

  /** Her notes are symptom evidence: losing one loses a record. Older text first, deterministically. */
  export function joinNotes(a: unknown, b: unknown, aTs: string, bTs: string): string | undefined {
    const first = typeof a === "string" ? a.trim() : "";
    const second = typeof b === "string" ? b.trim() : "";
    if (!first) return second || undefined;
    if (!second) return first;
    if (first === second) return first;
    return isNewer(aTs, bTs) ? `${second}\n${first}` : `${first}\n${second}`;
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

  export function mergeEntity<E extends Entity>(
    entity: E, local: Row<E>, server: Row<E>, localTs: string, serverTs: string,
  ): Row<E> {
    if (NEVER_MERGED.has(entity)) throw new MergeRefusedError(entity);
    return settle(newerWinsFields(local, server, localTs, serverTs), local, server) as Row<E>;
  }
  ```
- [ ] Run it. Expected: `Tests  8 passed (8)`.
  ```bash
  pnpm test lib/sync/merge.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/sync/merge.ts lib/sync/merge.test.ts && git commit -m "feat(sync): merge rows field-wise with note joins and dominant tombstones"
  ```

---

## Task 5 — `lib/sync/merge.ts`: the four special rows and `rebaseOp`

**Files** — Modify: `lib/sync/merge.ts`, `lib/sync/merge.test.ts`. Test path: `lib/sync/merge.test.ts`.

**Interfaces** — Consumes: `Row`, `newerWinsFields`, `joinNotes`, `settle` (Task 4); `SyncOp` from
`./types`. Produces: `export function rebaseOp(op: SyncOp, merged: unknown, currentRev: number): SyncOp`
plus `mergeEntity` branches for `log_entries`, `log_items`, `user_food_prefs`, `water_log`.

- [ ] Append the failing tests to `lib/sync/merge.test.ts`.
  ```ts
  // appended to lib/sync/merge.test.ts
  import { afterEach, beforeEach, vi } from "vitest";
  import { rebaseOp } from "./merge";
  import type { SyncOp } from "./types";

  describe("mergeEntity — log_entries", () => {
    it("keeps both notes, older text first, and takes the newer slot", () => {
      const m = mergeEntity("log_entries",
        { id: "e1", slot: "meal-2", note: "late", items: [] },
        { id: "e1", slot: "meal-1", note: "at the desk", items: [] }, NEW, OLD);
      expect(m.note).toBe("at the desk\nlate");
      expect(m.slot).toBe("meal-2");
    });
    it("keeps one copy when both notes say the same thing", () => {
      const m = mergeEntity("log_entries",
        { id: "e1", note: "ok", items: [] }, { id: "e1", note: "ok", items: [] }, NEW, OLD);
      expect(m.note).toBe("ok");
    });
    it("merges items by id: newer wins per field, one-sided ids are kept", () => {
      const m = mergeEntity("log_entries",
        { id: "e1", items: [{ id: "i1", seq: 1, grams: 120 }, { id: "i2", seq: 2, grams: 30 }] },
        { id: "e1", items: [{ id: "i1", seq: 1, grams: 100 }, { id: "i3", seq: 3, grams: 10 }] },
        NEW, OLD);
      expect(m.items).toEqual([
        { id: "i1", seq: 1, grams: 120 }, { id: "i2", seq: 2, grams: 30 }, { id: "i3", seq: 3, grams: 10 },
      ]);
    });
  });

  describe("mergeEntity — log_items, user_food_prefs, water_log", () => {
    it("takes the newer client_ts per field for a log_item", () => {
      expect(mergeEntity("log_items", { id: "i1", grams: 120 }, { id: "i1", grams: 100 }, OLD, NEW).grams).toBe(100);
    });
    it("takes the newer status and role for prefs and keeps both notes", () => {
      const m = mergeEntity("user_food_prefs",
        { food_ref_id: "f1", status: "avoid", role: "carb", note: "hurt on 9/12" },
        { food_ref_id: "f1", status: "eats", role: "protein", note: "fine on 9/04" }, NEW, OLD);
      expect(m).toMatchObject({ status: "avoid", role: "carb" });
      expect(m.note).toBe("fine on 9/04\nhurt on 9/12");
    });
    it("takes the larger cups, whichever side is newer", () => {
      const a = mergeEntity("water_log", { local_date: "d", cups: 5 }, { local_date: "d", cups: 7 }, NEW, OLD);
      const b = mergeEntity("water_log", { local_date: "d", cups: 8 }, { local_date: "d", cups: 2 }, OLD, NEW);
      expect([a.cups, b.cups]).toEqual([7, 8]);
    });
  });

  describe("rebaseOp", () => {
    beforeEach(() => vi.useFakeTimers({ now: new Date("2026-09-10T12:00:00.000Z") }));
    afterEach(() => vi.useRealTimers());

    const op: SyncOp = {
      op_id: "11111111-1111-4111-8111-111111111111", entity: "water_log",
      entity_id: "2026-09-11", kind: "update", base_rev: 3,
      payload: { cups: 5 }, client_ts: OLD,
    };

    it("rebases onto the current rev with a fresh id and a fresh stamp", () => {
      const next = rebaseOp(op, { local_date: "2026-09-11", cups: 7, rev: 9 }, 9);
      expect(next.base_rev).toBe(9);
      expect(next.payload).toEqual({ local_date: "2026-09-11", cups: 7, rev: 9 });
      expect(next.op_id).not.toBe(op.op_id);
      expect(next.op_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(next.client_ts).toBe("2026-09-10T12:00:00.000Z");
      expect(next.entity_id).toBe("2026-09-11");
    });
    it("turns a rejected create into an update, because the row now exists", () => {
      expect(rebaseOp({ ...op, kind: "create", base_rev: null }, { cups: 7 }, 1).kind).toBe("update");
    });
    it("refuses a merged payload that is not an object", () => {
      expect(() => rebaseOp(op, null, 9)).toThrow(/payload/);
    });
  });
  ```
- [ ] Run it. Expected failure: `TypeError: The requested module './merge' does not provide an export named 'rebaseOp'`
  ```bash
  pnpm test lib/sync/merge.test.ts
  ```
- [ ] Replace the Task 4 `mergeEntity` and append `rebaseOp`. Add `SyncOp` to the `./types` import.
  ```ts
  // lib/sync/merge.ts — replaces mergeEntity, and adds what follows it
  function asItems(value: unknown): Row[] {
    return Array.isArray(value) ? (value as Row[]) : [];
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
    const merged = newerWinsFields(local, server, localTs, serverTs);

    if (entity === "water_log") {
      merged.cups = Math.max(Number(local.cups ?? 0), Number(server.cups ?? 0));
    } else if (entity === "user_food_prefs" || entity === "log_entries") {
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
  ```
- [ ] Run it. Expected: `Tests  17 passed (17)`.
  ```bash
  pnpm test lib/sync/merge.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/sync/merge.ts lib/sync/merge.test.ts && git commit -m "feat(sync): merge log entries, items, prefs and water, and rebase rejected ops"
  ```

---

## Task 6 — `lib/sync/fingerprint.ts`

**Files** — Create: `lib/sync/fingerprint.ts`. Test path: `lib/sync/fingerprint.test.ts`.

**Interfaces** — Consumes: nothing. Produces:
```ts
export type FingerprintInput = { localDate: string; slot: string; eatenAt: string;
  items: { canonicalFoodId: string; grams: number }[] };
export function fingerprintSource(input: FingerprintInput): string;        // the §3.7 pre-image
export async function entryFingerprint(input: FingerprintInput): Promise<string>;  // sha256 hex
```

- [ ] Write the failing test. It hashes with `node:crypto` independently, so it proves the digest.
  ```ts
  // lib/sync/fingerprint.test.ts
  import { createHash } from "node:crypto";
  import { describe, expect, it } from "vitest";
  import { entryFingerprint, fingerprintSource, type FingerprintInput } from "./fingerprint";

  const base: FingerprintInput = {
    localDate: "2026-09-11", slot: "meal-1", eatenAt: "2026-09-11T12:03:00.000Z",
    items: [{ canonicalFoodId: "cat:1042", grams: 120 }, { canonicalFoodId: "cat:2011", grams: 30 }],
  };
  const withGrams = (grams: number) => ({ ...base, items: [{ canonicalFoodId: "cat:1042", grams }] });

  describe("fingerprintSource", () => {
    it("is the architecture §3.7 pre-image", () => {
      expect(fingerprintSource(base)).toBe("2026-09-11|meal-1|1757592|cat:1042:120,cat:2011:30");
    });
    it("does not depend on the order the devices listed the items", () => {
      expect(fingerprintSource({ ...base, items: [...base.items].reverse() })).toBe(fingerprintSource(base));
    });
    it("collapses gram jitter inside one 5 g bucket", () => {
      expect(fingerprintSource(withGrams(101))).toBe(fingerprintSource(withGrams(102)));
    });
    it("collapses 102 g and 104 g into the same 5 g bucket (contracts §4.1: floor, not round)", () => {
      expect(fingerprintSource(withGrams(102))).toBe(fingerprintSource(withGrams(104)));
    });
    it("keeps two entries inside the same 15-minute bucket together", () => {
      expect(fingerprintSource({ ...base, eatenAt: "2026-09-11T12:14:59.000Z" })).toBe(fingerprintSource(base));
    });
    it("separates two coffees 20 minutes apart", () => {
      const coffee = { ...base, slot: "coffee", items: [{ canonicalFoodId: "cat:14209", grams: 240 }] };
      expect(fingerprintSource({ ...coffee, eatenAt: "2026-09-11T12:23:00.000Z" }))
        .not.toBe(fingerprintSource(coffee));
    });
  });

  describe("entryFingerprint", () => {
    it("is the sha256 of the pre-image, lowercase hex", async () => {
      const expected = createHash("sha256").update(fingerprintSource(base), "utf8").digest("hex");
      await expect(entryFingerprint(base)).resolves.toBe(expected);
      expect(expected).toMatch(/^[0-9a-f]{64}$/);
    });
    it("gives two devices the same fingerprint for the same event", async () => {
      const phone = await entryFingerprint(base);
      const laptop = await entryFingerprint({
        ...base, eatenAt: "2026-09-11T12:07:41.000Z",
        items: [{ canonicalFoodId: "cat:2011", grams: 31 }, { canonicalFoodId: "cat:1042", grams: 122 }],
      });
      expect(laptop).toBe(phone);
    });
  });
  ```
- [ ] Run it. Expected failure: `Error: Failed to load url ./fingerprint (resolved id: …/lib/sync/fingerprint)`
  ```bash
  pnpm test lib/sync/fingerprint.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/sync/fingerprint.ts
  /**
   * Duplicate-entry fingerprint — contracts §4.1 (frozen bytes):
   *   sha256(local_date | slot | floor(epoch(eaten_at)/900) | sorted(canonical_id:floor5(grams)))
   * Bucketing is FLOOR, not round — 102 g and 104 g both bucket to 100, not 100 and 105. Event
   * time, not arrival time, so the answer does not depend on which device synced first.
   */

  export type FingerprintInput = {
    localDate: string; slot: string; eatenAt: string;
    items: { canonicalFoodId: string; grams: number }[];
  };

  const BUCKET_SECONDS = 900;
  const GRAM_STEP = 5;

  function floor5(grams: number): number {
    return Math.floor(grams / GRAM_STEP) * GRAM_STEP;
  }

  /** The exact bytes that get hashed. Pure and synchronous, so the formula is testable on its own. */
  export function fingerprintSource(input: FingerprintInput): string {
    const epoch = Date.parse(input.eatenAt);
    if (Number.isNaN(epoch)) throw new TypeError(`entryFingerprint: eatenAt is not a date (${input.eatenAt})`);
    const bucket = Math.floor(epoch / 1000 / BUCKET_SECONDS);
    const items = input.items.map((i) => `${i.canonicalFoodId}:${floor5(i.grams)}`).sort();
    return `${input.localDate}|${input.slot}|${bucket}|${items.join(",")}`;
  }

  /** Web Crypto in the browser, node:crypto under vitest. Both give the same 32 bytes. */
  async function sha256Hex(text: string): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  export async function entryFingerprint(input: FingerprintInput): Promise<string> {
    return sha256Hex(fingerprintSource(input));
  }
  ```
- [ ] Run it. Expected: `Tests  8 passed (8)`.
  ```bash
  pnpm test lib/sync/fingerprint.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/sync/fingerprint.ts lib/sync/fingerprint.test.ts && git commit -m "feat(sync): fingerprint log entries by event time and rounded grams"
  ```

---

## Task 7 — `lib/sync/idb.ts`: the `smc` database

**Files** — Create: `lib/sync/idb.ts`. Test path: `lib/sync/idb.test.ts`.

**Interfaces** — Consumes: `ENTITIES`, `Entity`, `SyncOp` from `./types`; `openDB` from `idb`. Produces:
```ts
export const DB_NAME: "smc"; export const DB_VERSION: 1;
export const OUTBOX_STORE: "outbox"; export const META_STORE: "meta";
export type OutboxOp = SyncOp & { seq: number; attempts: number; queued_at: string; next_attempt_at: number };
export function openSmcDb(): Promise<IDBPDatabase>;  export function closeSmcDb(): Promise<void>;
export function putRow(entity: Entity, key: string, row: Record<string, unknown>): Promise<void>;
export function getRow(entity: Entity, key: string): Promise<Record<string, unknown> | undefined>;
export function deleteRow(entity: Entity, key: string): Promise<void>;
export function allRows(entity: Entity): Promise<Record<string, unknown>[]>;
export function appendOp(op: SyncOp, now?: number): Promise<OutboxOp>;
export function putOp(op: OutboxOp): Promise<void>;  export function allOps(): Promise<OutboxOp[]>;
export function deleteOp(opId: string): Promise<void>;  export function countOps(): Promise<number>;
export function getCursor(): Promise<number>;  export function setCursor(seq: number): Promise<void>;
export function getLastSyncAt(): Promise<string | null>;
export function setLastSyncAt(iso: string): Promise<void>;
```

- [ ] Write the failing test.
  ```ts
  // lib/sync/idb.test.ts
  import "fake-indexeddb/auto";
  import { IDBFactory } from "fake-indexeddb";
  import { beforeEach, describe, expect, it } from "vitest";
  import {
    allOps, allRows, appendOp, closeSmcDb, countOps, DB_NAME, DB_VERSION, deleteOp, deleteRow,
    getCursor, getLastSyncAt, getRow, openSmcDb, putRow, setCursor, setLastSyncAt,
  } from "./idb";
  import { ENTITIES, type SyncOp } from "./types";

  function op(id: string): SyncOp {
    return {
      op_id: id, entity: "water_log", entity_id: "2026-09-11", kind: "update",
      base_rev: 1, payload: { cups: 1 }, client_ts: "2026-09-11T10:00:00.000Z",
    };
  }

  beforeEach(async () => {
    await closeSmcDb();
    globalThis.indexedDB = new IDBFactory();
  });

  describe("the smc database", () => {
    it("is version 1 with one store per synced entity plus outbox and meta", async () => {
      const db = await openSmcDb();
      expect([db.name, db.version]).toEqual([DB_NAME, DB_VERSION]);
      for (const entity of [...ENTITIES, "outbox", "meta"]) {
        expect([...db.objectStoreNames]).toContain(entity);
      }
    });

    it("stores rows by entity_key", async () => {
      await putRow("water_log", "2026-09-11", { local_date: "2026-09-11", cups: 4, rev: 2 });
      await expect(getRow("water_log", "2026-09-11")).resolves.toEqual({
        local_date: "2026-09-11", cups: 4, rev: 2,
      });
      await putRow("water_log", "2026-09-12", { local_date: "2026-09-12", cups: 1, rev: 1 });
      expect(await allRows("water_log")).toHaveLength(2);
      await deleteRow("water_log", "2026-09-11");
      await expect(getRow("water_log", "2026-09-11")).resolves.toBeUndefined();
    });

    it("appends outbox ops in order and reads them back in order", async () => {
      await appendOp(op("11111111-1111-4111-8111-111111111111"), 1_000);
      await appendOp(op("22222222-2222-4222-8222-222222222222"), 2_000);
      const ops = await allOps();
      expect(ops.map((o) => o.seq)).toEqual([1, 2]);
      expect(ops[0]).toMatchObject({
        attempts: 0, next_attempt_at: 1_000, queued_at: new Date(1_000).toISOString(),
      });
      expect(await countOps()).toBe(2);
      await deleteOp(ops[0].op_id);
      expect((await allOps()).map((o) => o.seq)).toEqual([2]);
    });

    it("starts the cursor at 0 and remembers what it is told", async () => {
      await expect(getCursor()).resolves.toBe(0);
      await setCursor(42);
      await expect(getCursor()).resolves.toBe(42);
      await expect(getLastSyncAt()).resolves.toBeNull();
      await setLastSyncAt("2026-09-11T10:00:00.000Z");
      await expect(getLastSyncAt()).resolves.toBe("2026-09-11T10:00:00.000Z");
    });
  });
  ```
- [ ] Run it. Expected failure: `Error: Failed to load url ./idb (resolved id: …/lib/sync/idb)`
  ```bash
  pnpm test lib/sync/idb.test.ts
  ```
- [ ] Write the implementation.
  ```ts
  // lib/sync/idb.ts
  /**
   * The client store — architecture §3.7. One object store per synced entity, keyed by the
   * `entity_key` of contracts §4, so a pulled `ChangeRow.current` writes straight in. Plus an
   * `outbox` of pending ops and a `meta` store holding the change cursor.
   *
   * Additive in Phase 0: `lib/store.ts` keeps writing localStorage until the cut-over.
   */
  import { openDB, type IDBPDatabase } from "idb";
  import { ENTITIES, type Entity, type SyncOp } from "./types";

  export const DB_NAME = "smc";
  export const DB_VERSION = 1;
  export const OUTBOX_STORE = "outbox";
  export const META_STORE = "meta";

  const CURSOR_KEY = "cursor";
  const LAST_SYNC_KEY = "last_sync_at";
  const OUTBOX_SEQ_KEY = "outbox_seq";

  /** The outbox row: the op itself, plus this device's queue order and its retry state. */
  export type OutboxOp = SyncOp & {
    seq: number; attempts: number; queued_at: string; next_attempt_at: number;
  };

  let dbPromise: Promise<IDBPDatabase> | null = null;

  export function openSmcDb(): Promise<IDBPDatabase> {
    dbPromise ??= openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        for (const entity of ENTITIES) {
          if (!db.objectStoreNames.contains(entity)) db.createObjectStore(entity);
        }
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          db.createObjectStore(OUTBOX_STORE, { keyPath: "op_id" })
            .createIndex("by_seq", "seq", { unique: true });
        }
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      },
    });
    return dbPromise;
  }

  export async function closeSmcDb(): Promise<void> {
    if (!dbPromise) return;
    const db = await dbPromise;
    dbPromise = null;
    db.close();
  }

  export async function putRow(entity: Entity, key: string, row: Record<string, unknown>): Promise<void> {
    await (await openSmcDb()).put(entity, row, key);
  }

  export async function getRow(entity: Entity, key: string): Promise<Record<string, unknown> | undefined> {
    return (await openSmcDb()).get(entity, key) as Promise<Record<string, unknown> | undefined>;
  }

  export async function deleteRow(entity: Entity, key: string): Promise<void> {
    await (await openSmcDb()).delete(entity, key);
  }

  export async function allRows(entity: Entity): Promise<Record<string, unknown>[]> {
    return (await openSmcDb()).getAll(entity) as Promise<Record<string, unknown>[]>;
  }

  /** Allocates this device's next queue number and stores the op in the same transaction. */
  export async function appendOp(op: SyncOp, now: number = Date.now()): Promise<OutboxOp> {
    const db = await openSmcDb();
    const tx = db.transaction([OUTBOX_STORE, META_STORE], "readwrite");
    const meta = tx.objectStore(META_STORE);
    const seq = (((await meta.get(OUTBOX_SEQ_KEY)) as number | undefined) ?? 0) + 1;
    await meta.put(seq, OUTBOX_SEQ_KEY);
    const row: OutboxOp = {
      ...op, seq, attempts: 0, queued_at: new Date(now).toISOString(), next_attempt_at: now,
    };
    await tx.objectStore(OUTBOX_STORE).put(row);
    await tx.done;
    return row;
  }

  export async function putOp(op: OutboxOp): Promise<void> {
    await (await openSmcDb()).put(OUTBOX_STORE, op);
  }

  export async function allOps(): Promise<OutboxOp[]> {
    return (await openSmcDb()).getAllFromIndex(OUTBOX_STORE, "by_seq") as Promise<OutboxOp[]>;
  }

  export async function deleteOp(opId: string): Promise<void> {
    await (await openSmcDb()).delete(OUTBOX_STORE, opId);
  }

  export async function countOps(): Promise<number> {
    return (await openSmcDb()).count(OUTBOX_STORE);
  }

  export async function getCursor(): Promise<number> {
    return ((await (await openSmcDb()).get(META_STORE, CURSOR_KEY)) as number | undefined) ?? 0;
  }

  export async function setCursor(seq: number): Promise<void> {
    await (await openSmcDb()).put(META_STORE, seq, CURSOR_KEY);
  }

  export async function getLastSyncAt(): Promise<string | null> {
    return ((await (await openSmcDb()).get(META_STORE, LAST_SYNC_KEY)) as string | undefined) ?? null;
  }

  export async function setLastSyncAt(iso: string): Promise<void> {
    await (await openSmcDb()).put(META_STORE, iso, LAST_SYNC_KEY);
  }
  ```
- [ ] Run it. Expected: `Tests  4 passed (4)`.
  ```bash
  pnpm test lib/sync/idb.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/sync/idb.ts lib/sync/idb.test.ts && git commit -m "feat(sync): add the smc IndexedDB store, outbox and cursor"
  ```

---

## Task 8 — `lib/sync/outbox.ts`: enqueue, backoff, pending count

**Files** — Create: `lib/sync/outbox.ts`. Test path: `lib/sync/outbox.test.ts`.

**Interfaces** — Consumes: `appendOp`, `countOps`, `OutboxOp` from `./idb`; `encodeKey` from
`./keys`; `SyncOp` from `./types`. Produces:
```ts
export function backoffMs(attempts: number): number;              // 1s, 2s, 4s … capped at 60s
export function enqueue(op: SyncOp, now?: number): Promise<OutboxOp>;
export function pendingCount(): Promise<number>;
```

- [ ] Write the failing test.
  ```ts
  // lib/sync/outbox.test.ts
  import "fake-indexeddb/auto";
  import { IDBFactory } from "fake-indexeddb";
  import { beforeEach, describe, expect, it } from "vitest";
  import { closeSmcDb } from "./idb";
  import { backoffMs, enqueue, pendingCount } from "./outbox";
  import type { SyncOp } from "./types";

  export const OP: SyncOp = {
    op_id: "11111111-1111-4111-8111-111111111111", entity: "water_log",
    entity_id: "2026-09-11", kind: "update", base_rev: 1,
    payload: { local_date: "2026-09-11", cups: 4 }, client_ts: "2026-09-11T10:00:00.000Z",
  };

  beforeEach(async () => {
    await closeSmcDb();
    globalThis.indexedDB = new IDBFactory();
  });

  describe("backoffMs", () => {
    it("doubles from one second and stops at a minute", () => {
      expect([1, 2, 3, 4].map(backoffMs)).toEqual([1_000, 2_000, 4_000, 8_000]);
      expect(backoffMs(10)).toBe(60_000);
    });
  });

  describe("enqueue", () => {
    it("queues an op and counts it as pending", async () => {
      const queued = await enqueue(OP, 5_000);
      expect(queued).toMatchObject({ seq: 1, next_attempt_at: 5_000, attempts: 0 });
      await expect(pendingCount()).resolves.toBe(1);
    });
    it("refuses an op whose entity_id does not match its payload's key", async () => {
      await expect(enqueue({ ...OP, entity_id: "2026-09-12" })).rejects.toThrow(/entity_id/);
    });
    it("accepts a delete whose payload carries no key columns", async () => {
      expect((await enqueue({ ...OP, kind: "delete", payload: {} }, 5_000)).kind).toBe("delete");
    });
  });
  ```
- [ ] Run it. Expected failure: `Error: Failed to load url ./outbox (resolved id: …/lib/sync/outbox)`
  ```bash
  pnpm test lib/sync/outbox.test.ts
  ```
- [ ] Write the implementation (Task 9 appends `applyResult` and `drainOutbox`).
  ```ts
  // lib/sync/outbox.ts
  /**
   * The outbox — architecture §3.7. A local write lands first, its op queues here, and a failed push
   * retries with backoff. Nothing here talks to the network: `drainOutbox` takes the push function,
   * so the tests drive it with a fake.
   */
  import { appendOp, countOps, type OutboxOp } from "./idb";
  import { encodeKey } from "./keys";
  import type { SyncOp } from "./types";

  const FIRST_RETRY_MS = 1_000;
  const MAX_RETRY_MS = 60_000;

  export function backoffMs(attempts: number): number {
    return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS);
  }

  /** `entity_id` IS the `entity_key` of contracts §4. A create or update carries the key columns in
   *  its payload, so the two must agree; a delete or restore may send an empty payload. */
  function assertKeyMatchesPayload(op: SyncOp): void {
    if (op.kind === "delete" || op.kind === "restore") return;
    const fromPayload = encodeKey(op.entity, op.payload);
    if (fromPayload !== op.entity_id) {
      throw new TypeError(
        `${op.entity}: entity_id ${op.entity_id} does not match its payload key ${fromPayload}`,
      );
    }
  }

  export async function enqueue(op: SyncOp, now: number = Date.now()): Promise<OutboxOp> {
    assertKeyMatchesPayload(op);
    return appendOp(op, now);
  }

  export function pendingCount(): Promise<number> {
    return countOps();
  }
  ```
- [ ] Run it. Expected: `Tests  4 passed (4)`.
  ```bash
  pnpm test lib/sync/outbox.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/sync/outbox.ts lib/sync/outbox.test.ts && git commit -m "feat(sync): queue sync ops with a key invariant and exponential backoff"
  ```

---

## Task 9 — `lib/sync/outbox.ts`: applying every `OpResult`, and the drain

**Files** — Modify: `lib/sync/outbox.ts`, `lib/sync/outbox.test.ts`. Test path: `lib/sync/outbox.test.ts`.

**Interfaces** — Consumes: `mergeEntity`, `rebaseOp`, `NEVER_MERGED`, `Row` from `./merge`; `getRow`,
`putRow`, `deleteRow`, `putOp`, `deleteOp`, `allOps` from `./idb`; `OpResult`, `OpsResponse`,
`SyncOp` from `./types`. Produces:
```ts
export const MAX_OPS_PER_PUSH: 200;  export const TARGETS_CHANGED_EVENT: "sasha:targets-changed";
export type PushFn = (ops: SyncOp[]) => Promise<OpsResponse>;
export type DrainResult = { pushed: number; applied: number; conflicts: number;
  dropped: number; errored: number; failed: boolean; retryAfterMs: number | null };
export function serverTimestampOf(row: unknown, fallback: string): string;
export function applyResult(result: OpResult, op: OutboxOp, now?: () => number): Promise<void>;
export function drainOutbox(push: PushFn, now?: () => number): Promise<DrainResult>;
```

**`applyResult` branches on `op.kind` as well as `result.status`.** An `applied` result carries no
row, so what it means to apply one depends on what kind of op it was: a `delete` tombstones the
local row (`deleted_at`), a `restore` clears one (or, if the row is not there to un-tombstone, rolls
the local cursor back so the next `pullChanges` re-fetches its full `current` snapshot), and
`create`/`update` merge `payload` as before. `unsupported` drops the op with a warning — the server
will never accept it, so retrying is pointless. `error` is retried with backoff like a network
failure, up to three attempts, then **parked**: left in the outbox (so `pendingCount()` — and
`SyncStatus`'s pending count — still shows it) but with `next_attempt_at` pushed out so
`drainOutbox` stops selecting it on its own.

- [ ] Append the failing tests.
  ```ts
  // appended to lib/sync/outbox.test.ts
  import { vi } from "vitest";
  import { allOps, getCursor, getRow, putRow, setCursor } from "./idb";
  import { drainOutbox, type PushFn } from "./outbox";
  import type { OpResult, OpsResponse, SyncOp } from "./types";

  const response = (results: OpResult[]): OpsResponse =>
    ({ results, server_time: "2026-09-11T10:00:05.000Z" });

  describe("drainOutbox", () => {
    it("applies a result and bumps the local rev", async () => {
      await putRow("water_log", "2026-09-11", { local_date: "2026-09-11", cups: 3, rev: 1 });
      await enqueue(OP, 1_000);
      const push: PushFn = async (ops) =>
        response([{ op_id: ops[0].op_id, status: "applied", rev: 2, seq: 17 }]);
      expect(await drainOutbox(push, () => 2_000)).toMatchObject({ pushed: 1, applied: 1, failed: false });
      await expect(getRow("water_log", "2026-09-11")).resolves.toEqual({
        local_date: "2026-09-11", cups: 4, rev: 2,
      });
      await expect(pendingCount()).resolves.toBe(0);
    });

    it("merges a conflict, rebases and re-queues one op", async () => {
      await putRow("water_log", "2026-09-11", { local_date: "2026-09-11", cups: 4, rev: 1 });
      await enqueue(OP, 1_000);
      const push: PushFn = async (ops) => response([{
        op_id: ops[0].op_id, status: "conflict", entity: "water_log", current_rev: 5,
        current: { local_date: "2026-09-11", cups: 7, rev: 5 },
      }]);
      expect(await drainOutbox(push, () => 2_000)).toMatchObject({ conflicts: 1, applied: 0 });
      const queued = await allOps();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ base_rev: 5 });
      expect(queued[0].payload).toMatchObject({ cups: 7 });
      expect(queued[0].op_id).not.toBe(OP.op_id);
      await expect(getRow("water_log", "2026-09-11")).resolves.toMatchObject({ cups: 7, rev: 5 });
    });

    it("drops the local row on 'deleted' and never resurrects it", async () => {
      await putRow("water_log", "2026-09-11", { local_date: "2026-09-11", cups: 4, rev: 1 });
      await enqueue(OP, 1_000);
      await drainOutbox(async (ops) => response([{
        op_id: ops[0].op_id, status: "deleted", entity: "water_log",
        deleted_at: "2026-09-11T09:00:00.000Z",
      }]), () => 2_000);
      await expect(getRow("water_log", "2026-09-11")).resolves.toBeUndefined();
      await expect(pendingCount()).resolves.toBe(0);
    });

    it("drops the op on 'gone' and on 'duplicate'", async () => {
      await enqueue(OP, 1_000);
      await drainOutbox(async (ops) => response([{ op_id: ops[0].op_id, status: "gone" }]), () => 2_000);
      await expect(pendingCount()).resolves.toBe(0);
      await enqueue({ ...OP, op_id: "33333333-3333-4333-8333-333333333333" }, 1_000);
      const result = await drainOutbox(
        async (ops) => response([{ op_id: ops[0].op_id, status: "duplicate" }]), () => 2_000);
      expect(result.dropped).toBe(1);
      await expect(pendingCount()).resolves.toBe(0);
    });

    const FOOD_ID = "44444444-4444-4444-8444-444444444444";
    const deleteFoodOp: SyncOp = {
      op_id: "55555555-5555-4555-8555-555555555555", entity: "user_foods", entity_id: FOOD_ID,
      kind: "delete", base_rev: 1, payload: {}, client_ts: "2026-09-11T10:00:00.000Z",
    };
    const restoreFoodOp: SyncOp = { ...deleteFoodOp, op_id: "66666666-6666-4666-8666-666666666666", kind: "restore" };

    it("applied + kind 'delete' tombstones the local row instead of merging the (empty) payload", async () => {
      await putRow("user_foods", FOOD_ID, { id: FOOD_ID, name: "Rice", rev: 1, deleted_at: null });
      await enqueue(deleteFoodOp, 1_000);
      await drainOutbox(
        async (ops) => response([{ op_id: ops[0].op_id, status: "applied", rev: 2, seq: 20 }]), () => 2_000);
      await expect(getRow("user_foods", FOOD_ID)).resolves.toMatchObject({
        name: "Rice", rev: 2, deleted_at: expect.any(String),
      });
      await expect(pendingCount()).resolves.toBe(0);
    });

    it("applied + kind 'restore' clears the tombstone and keeps the row, when the row is here", async () => {
      await putRow("user_foods", FOOD_ID, {
        id: FOOD_ID, name: "Rice", rev: 2, deleted_at: "2026-09-10T00:00:00.000Z",
      });
      await enqueue(restoreFoodOp, 1_000);
      await drainOutbox(
        async (ops) => response([{ op_id: ops[0].op_id, status: "applied", rev: 3, seq: 21 }]), () => 2_000);
      await expect(getRow("user_foods", FOOD_ID)).resolves.toMatchObject({
        name: "Rice", rev: 3, deleted_at: null,
      });
    });

    it("applied + kind 'restore' with no local row rolls the cursor back for a re-fetch", async () => {
      await setCursor(25);
      await enqueue(restoreFoodOp, 1_000);
      await drainOutbox(
        async (ops) => response([{ op_id: ops[0].op_id, status: "applied", rev: 3, seq: 21 }]), () => 2_000);
      await expect(getCursor()).resolves.toBe(20);
      await expect(getRow("user_foods", FOOD_ID)).resolves.toBeUndefined();
      await expect(pendingCount()).resolves.toBe(0);
    });

    it("drops the op and warns on 'unsupported'", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await enqueue(OP, 1_000);
      const result = await drainOutbox(
        async (ops) => response([{ op_id: ops[0].op_id, status: "unsupported" }]), () => 2_000);
      expect(result.dropped).toBe(1);
      expect(warn).toHaveBeenCalled();
      await expect(pendingCount()).resolves.toBe(0);
      warn.mockRestore();
    });

    it("retries an 'error' with backoff, then parks it after three attempts", async () => {
      await enqueue(OP, 1_000);
      const errorResult = (ops: SyncOp[]) =>
        response([{ op_id: ops[0].op_id, status: "error" as const, message: "db is down" }]);
      const first = await drainOutbox(errorResult, () => 2_000);
      expect(first.errored).toBe(1);
      expect((await allOps())[0]).toMatchObject({ attempts: 1, next_attempt_at: 3_000 });
      await drainOutbox(errorResult, () => 3_000);
      const third = await drainOutbox(errorResult, () => 100_000);
      expect(third.errored).toBe(1);
      const parked = (await allOps())[0];
      expect(parked.attempts).toBe(3);
      expect(parked.next_attempt_at).toBeGreaterThan(100_000 + 300 * 24 * 60 * 60 * 1000);
      // parked, but still pending — SyncStatus's count must not silently drop it.
      await expect(pendingCount()).resolves.toBe(1);
      const spared = await drainOutbox(async () => { throw new Error("must not be called"); }, () => 200_000);
      expect(spared.pushed).toBe(0);
    });

    it("backs off and keeps the op when the push throws", async () => {
      await enqueue(OP, 1_000);
      const result = await drainOutbox(async () => { throw new Error("offline"); }, () => 2_000);
      expect(result).toMatchObject({ failed: true, retryAfterMs: 1_000 });
      expect((await allOps())[0]).toMatchObject({ attempts: 1, next_attempt_at: 3_000 });
    });

    it("skips an op that is still backing off", async () => {
      await enqueue(OP, 10_000);
      let calls = 0;
      const result = await drainOutbox(async () => { calls += 1; return response([]); }, () => 2_000);
      expect([calls, result.pushed]).toEqual([0, 0]);
      await expect(pendingCount()).resolves.toBe(1);
    });

    it("pushes at most 200 ops in one request, in queue order", async () => {
      for (let i = 0; i < 205; i += 1) {
        await enqueue({ ...OP, op_id: crypto.randomUUID(),
          payload: { local_date: "2026-09-11", cups: i } }, 1_000);
      }
      let seen: SyncOp[] = [];
      await drainOutbox(async (ops) => {
        seen = ops;
        return response(ops.map((o) => ({ op_id: o.op_id, status: "applied" as const, rev: 2, seq: 1 })));
      }, () => 2_000);
      expect(seen).toHaveLength(200);
      expect(seen[0].payload).toMatchObject({ cups: 0 });
      await expect(pendingCount()).resolves.toBe(5);
    });
  });
  ```
- [ ] Run it. Expected failure: `TypeError: The requested module './outbox' does not provide an export named 'drainOutbox'`
  ```bash
  pnpm test lib/sync/outbox.test.ts
  ```
- [ ] Append the implementation to `lib/sync/outbox.ts`, extending the `./idb` import.
  ```ts
  // appended to lib/sync/outbox.ts
  import { allOps, deleteOp, deleteRow, getCursor, getRow, putOp, putRow, setCursor } from "./idb";
  import { mergeEntity, NEVER_MERGED, rebaseOp, type Row } from "./merge";
  import type { OpResult, OpsResponse } from "./types";

  export const MAX_OPS_PER_PUSH = 200;
  export const TARGETS_CHANGED_EVENT = "sasha:targets-changed";
  const MAX_ERROR_ATTEMPTS = 3;

  export type PushFn = (ops: SyncOp[]) => Promise<OpsResponse>;

  export type DrainResult = {
    pushed: number; applied: number; conflicts: number;
    dropped: number; errored: number; failed: boolean; retryAfterMs: number | null;
  };

  /** A conflict carries the row but no stamp of its own, and the synced tables use three different
   *  names for "when". Falling back to now lets the server win a tie, which is right: its row was
   *  written after our `base_rev`. See Open question 1. */
  export function serverTimestampOf(row: unknown, fallback: string): string {
    const r = (row ?? {}) as Record<string, unknown>;
    for (const column of ["updated_at", "changed_at", "eaten_at", "created_at"]) {
      const value = r[column];
      if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
    }
    return fallback;
  }

  /** Strip this device's queue bookkeeping; only the SyncOp goes on the wire. */
  function wireOp(op: OutboxOp): SyncOp {
    const { seq, attempts, queued_at, next_attempt_at, ...rest } = op;
    void seq; void attempts; void queued_at; void next_attempt_at;
    return rest;
  }

  async function onConflict(
    result: Extract<OpResult, { status: "conflict" }>, op: OutboxOp,
  ): Promise<void> {
    const server = (result.current ?? {}) as Row;
    if (NEVER_MERGED.has(op.entity)) {
      await putRow(op.entity, op.entity_id, server);
      await deleteOp(op.op_id);
      globalThis.dispatchEvent?.(new Event(TARGETS_CHANGED_EVENT));
      return;
    }
    const local = ((await getRow(op.entity, op.entity_id)) ?? op.payload) as Row;
    const merged = mergeEntity(op.entity, local, server, op.client_ts,
      serverTimestampOf(server, new Date().toISOString()));
    await putRow(op.entity, op.entity_id, { ...merged, rev: result.current_rev });
    await deleteOp(op.op_id);
    await enqueue(rebaseOp(wireOp(op), merged, result.current_rev));
  }

  /** Server errored on this op specifically (not a network failure). Retried with backoff, like a
   *  network failure, but capped at MAX_ERROR_ATTEMPTS — after that it is PARKED: left in the
   *  outbox (pendingCount() and SyncStatus still count it) with next_attempt_at pushed a year out,
   *  so drainOutbox stops selecting it on its own. Nothing here deletes a parked op; only a human
   *  action (or a future "retry parked ops" command) clears it. */
  async function parkOrRetry(op: OutboxOp, message: string, now: () => number): Promise<void> {
    const attempts = op.attempts + 1;
    if (attempts >= MAX_ERROR_ATTEMPTS) {
      await putOp({ ...op, attempts, next_attempt_at: now() + 365 * 24 * 60 * 60 * 1000 });
      console.warn(`sync: op ${op.op_id} parked after ${attempts} server errors: ${message}`);
      return;
    }
    await putOp({ ...op, attempts, next_attempt_at: now() + backoffMs(attempts) });
  }

  export async function applyResult(
    result: OpResult, op: OutboxOp, now: () => number = Date.now,
  ): Promise<void> {
    if (result.status === "applied") {
      if (op.kind === "delete") {
        // Tombstone, don't merge: the server accepted an empty-payload delete, and merging {}
        // would leave the row looking untouched except for its rev.
        const local = (await getRow(op.entity, op.entity_id)) ?? op.payload;
        await putRow(op.entity, op.entity_id, {
          ...local, deleted_at: new Date(now()).toISOString(), rev: result.rev,
        });
        await deleteOp(op.op_id);
        return;
      }
      if (op.kind === "restore") {
        const local = await getRow(op.entity, op.entity_id);
        if (!local) {
          // Nothing here to un-tombstone (this device may have GC'd it already) and 'applied'
          // carries no row — only rev/seq. Roll the cursor back to just before this change so the
          // next pullChanges() re-fetches its full `current` snapshot from sync_changes.
          const cursor = await getCursor();
          if (result.seq - 1 < cursor) await setCursor(result.seq - 1);
          await deleteOp(op.op_id);
          return;
        }
        await putRow(op.entity, op.entity_id, { ...local, deleted_at: null, rev: result.rev });
        await deleteOp(op.op_id);
        return;
      }
      // create / update
      const local = (await getRow(op.entity, op.entity_id)) ?? {};
      await putRow(op.entity, op.entity_id, { ...local, ...op.payload, rev: result.rev });
      await deleteOp(op.op_id);
      return;
    }
    if (result.status === "conflict") return onConflict(result, op);
    if (result.status === "deleted") {
      await deleteRow(op.entity, op.entity_id);
      await deleteOp(op.op_id);
      return;
    }
    if (result.status === "unsupported") {
      console.warn(`sync: op ${op.op_id} (${op.entity} ${op.kind}) is unsupported by the server; dropping`);
      await deleteOp(op.op_id);
      return;
    }
    if (result.status === "error") {
      await parkOrRetry(op, result.message, now);
      return;
    }
    await deleteOp(op.op_id); // 'gone' and 'duplicate': the op has nothing left to do
  }

  export async function drainOutbox(push: PushFn, now: () => number = Date.now): Promise<DrainResult> {
    const at = now();
    const due = (await allOps()).filter((o) => o.next_attempt_at <= at).slice(0, MAX_OPS_PER_PUSH);
    const empty: DrainResult = {
      pushed: 0, applied: 0, conflicts: 0, dropped: 0, errored: 0, failed: false, retryAfterMs: null,
    };
    if (due.length === 0) return empty;

    let response: OpsResponse;
    try {
      response = await push(due.map(wireOp));
    } catch {
      let retryAfterMs = MAX_RETRY_MS;
      for (const op of due) {
        const attempts = op.attempts + 1;
        const wait = backoffMs(attempts);
        retryAfterMs = Math.min(retryAfterMs, wait);
        await putOp({ ...op, attempts, next_attempt_at: at + wait });
      }
      return { ...empty, failed: true, retryAfterMs };
    }

    const byId = new Map(due.map((o) => [o.op_id, o]));
    const out: DrainResult = { ...empty, pushed: due.length };
    for (const result of response.results) {
      const op = byId.get(result.op_id);
      if (!op) continue;
      await applyResult(result, op, now);
      if (result.status === "applied") out.applied += 1;
      else if (result.status === "conflict") out.conflicts += 1;
      else if (result.status === "error") out.errored += 1;
      else out.dropped += 1; // 'deleted', 'gone', 'duplicate', 'unsupported'
    }
    return out;
  }
  ```
- [ ] Run it. Expected: `Tests  16 passed (16)`.
  ```bash
  pnpm test lib/sync/outbox.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/sync/outbox.ts lib/sync/outbox.test.ts && git commit -m "feat(sync): drain the outbox and resolve every op result status"
  ```

---

## Task 10 — `lib/sync/client.ts`: `pullChanges`

**Files** — Create: `lib/sync/client.ts`. Test path: `lib/sync/client.test.ts`.

**Interfaces** — Consumes: `getCursor`, `setCursor`, `putRow`, `deleteRow` from `./idb`; `decodeKey`
from `./keys`; `ENTITIES`, `ChangesResponse`, `Entity` from `./types`. Produces:
```ts
export const SYNCED_EVENT: "sasha:synced";
export type SyncOptions = { fetchFn?: typeof fetch; maxPages?: number };
export type PullResult = { applied: number; cursor: number; hasMore: boolean; pages: number };
export function pullChanges(since?: number, options?: SyncOptions): Promise<PullResult>;
```

- [ ] Write the failing test.
  ```ts
  // lib/sync/client.test.ts
  import "fake-indexeddb/auto";
  import { IDBFactory } from "fake-indexeddb";
  import { beforeEach, describe, expect, it, vi } from "vitest";
  import { pullChanges } from "./client";
  import { closeSmcDb, getCursor, getRow, setCursor } from "./idb";
  import type { ChangeRow, ChangesResponse } from "./types";

  function row(seq: number, over: Partial<ChangeRow> = {}): ChangeRow {
    return {
      seq, entity: "water_log", entity_key: "2026-09-11", rev: seq, op: "update",
      at: "2026-09-11T10:00:00.000Z", current: { local_date: "2026-09-11", cups: seq, rev: seq },
      ...over,
    };
  }

  export function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  const pageFn = (body: ChangesResponse) => (async () => jsonResponse(body)) as unknown as typeof fetch;

  beforeEach(async () => {
    await closeSmcDb();
    globalThis.indexedDB = new IDBFactory();
  });

  describe("pullChanges", () => {
    it("writes each ChangeRow.current into its entity store", async () => {
      const fetchFn = vi.fn(async () => jsonResponse({ changes: [row(1), row(2)], next_cursor: 2, has_more: false }));
      const result = await pullChanges(0, { fetchFn: fetchFn as unknown as typeof fetch });
      expect(result).toMatchObject({ applied: 2, cursor: 2, hasMore: false, pages: 1 });
      await expect(getRow("water_log", "2026-09-11")).resolves.toEqual({
        local_date: "2026-09-11", cups: 2, rev: 2,
      });
      expect(fetchFn.mock.calls[0][0]).toBe("/api/sync/changes?since=0&limit=500");
    });

    it("deletes the row when current is null", async () => {
      await pullChanges(0, { fetchFn: pageFn({ changes: [row(1)], next_cursor: 1, has_more: false }) });
      await pullChanges(1, {
        fetchFn: pageFn({ changes: [row(2, { op: "delete", current: null })], next_cursor: 2, has_more: false }),
      });
      await expect(getRow("water_log", "2026-09-11")).resolves.toBeUndefined();
    });

    it("starts from the stored cursor and saves the next one only after the page is applied", async () => {
      await setCursor(41);
      const fetchFn = vi.fn(async () => jsonResponse({ changes: [row(42)], next_cursor: 42, has_more: false }));
      await pullChanges(undefined, { fetchFn: fetchFn as unknown as typeof fetch });
      expect(fetchFn.mock.calls[0][0]).toBe("/api/sync/changes?since=41&limit=500");
      await expect(getCursor()).resolves.toBe(42);
    });

    it("leaves the cursor alone when a row in the page is unusable", async () => {
      await setCursor(41);
      await expect(pullChanges(undefined, {
        fetchFn: pageFn({ changes: [row(42, { entity_key: "not-a-date" })], next_cursor: 42, has_more: false }),
      })).rejects.toThrow();
      await expect(getCursor()).resolves.toBe(41);
    });

    it("follows has_more across pages", async () => {
      const pages: ChangesResponse[] = [
        { changes: [row(1)], next_cursor: 1, has_more: true },
        { changes: [row(2)], next_cursor: 2, has_more: false },
      ];
      const fetchFn = vi.fn(async () => jsonResponse(pages.shift()!));
      const result = await pullChanges(0, { fetchFn: fetchFn as unknown as typeof fetch });
      expect(result).toMatchObject({ applied: 2, cursor: 2, pages: 2, hasMore: false });
    });

    it("throws on a non-2xx response", async () => {
      await expect(pullChanges(0, {
        fetchFn: (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch,
      })).rejects.toThrow(/429/);
    });
  });
  ```
- [ ] Run it. Expected failure: `Error: Failed to load url ./client (resolved id: …/lib/sync/client)`
  ```bash
  pnpm test lib/sync/client.test.ts
  ```
- [ ] Write the implementation (Task 11 appends the push half).
  ```ts
  // lib/sync/client.ts
  /**
   * The two network halves of sync. Pull reads the change feed and writes each row straight into
   * IndexedDB; push drains the outbox. Both take an injectable `fetch`, so the tests never touch the
   * network, and neither holds module-level state beyond the in-flight guard.
   */
  import { deleteRow, getCursor, putRow, setCursor } from "./idb";
  import { decodeKey } from "./keys";
  import { ENTITIES, type ChangesResponse, type Entity } from "./types";

  export const SYNCED_EVENT = "sasha:synced";

  const PAGE_LIMIT = 500;
  const DEFAULT_MAX_PAGES = 50;
  const SYNCED = new Set<string>(ENTITIES);

  export type SyncOptions = { fetchFn?: typeof fetch; maxPages?: number };
  export type PullResult = { applied: number; cursor: number; hasMore: boolean; pages: number };

  async function getJson<T>(url: string, fetchFn: typeof fetch): Promise<T> {
    const res = await fetchFn(url, { method: "GET", headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`sync: GET ${url} failed with ${res.status}`);
    return (await res.json()) as T;
  }

  /** Apply pages of `ChangeRow` until the feed runs out. The cursor is saved ONLY after a whole page
   *  is applied, so a crash mid-page replays that page rather than skipping it. */
  export async function pullChanges(since?: number, options: SyncOptions = {}): Promise<PullResult> {
    const fetchFn = options.fetchFn ?? globalThis.fetch;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    let cursor = since ?? (await getCursor());
    let applied = 0;
    let pages = 0;
    let hasMore = true;

    while (hasMore && pages < maxPages) {
      const page = await getJson<ChangesResponse>(
        `/api/sync/changes?since=${cursor}&limit=${PAGE_LIMIT}`, fetchFn,
      );
      for (const change of page.changes) {
        if (!SYNCED.has(change.entity as Entity)) continue;
        decodeKey(change.entity, change.entity_key); // throws on a key this client cannot address
        if (change.current === null) await deleteRow(change.entity, change.entity_key);
        else await putRow(change.entity, change.entity_key, change.current);
        applied += 1;
      }
      cursor = page.next_cursor;
      await setCursor(cursor);
      pages += 1;
      hasMore = page.has_more;
    }

    return { applied, cursor, hasMore, pages };
  }
  ```
- [ ] Run it. Expected: `Tests  6 passed (6)`.
  ```bash
  pnpm test lib/sync/client.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/sync/client.ts lib/sync/client.test.ts && git commit -m "feat(sync): pull the change feed into IndexedDB, cursor after apply"
  ```

---

## Task 11 — `lib/sync/client.ts`: `pushOutbox` and `syncOnce`

**Files** — Modify: `lib/sync/client.ts`, `lib/sync/client.test.ts`. Test path: `lib/sync/client.test.ts`.

**Interfaces** — Consumes: `drainOutbox`, `DrainResult` from `./outbox`; `getLastSyncAt`,
`setLastSyncAt` from `./idb`; `OpsResponse`, `SyncOp` from `./types`. Produces:
```ts
export function pushOutbox(options?: SyncOptions): Promise<DrainResult>;
export function syncOnce(options?: SyncOptions): Promise<{ pull: PullResult; push: DrainResult }>;
export function lastSyncAt(): Promise<string | null>;
```

- [ ] Append the failing tests.
  ```ts
  // appended to lib/sync/client.test.ts
  import { lastSyncAt, pushOutbox, syncOnce } from "./client";
  import { enqueue } from "./outbox";
  import type { OpsResponse, SyncOp } from "./types";

  const OP: SyncOp = {
    op_id: "11111111-1111-4111-8111-111111111111", entity: "water_log",
    entity_id: "2026-09-11", kind: "update", base_rev: 1,
    payload: { local_date: "2026-09-11", cups: 4 }, client_ts: "2026-09-11T10:00:00.000Z",
  };

  describe("pushOutbox", () => {
    it("POSTs the due ops to /api/sync/ops and applies the results", async () => {
      await enqueue(OP, 1_000);
      const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { ops: SyncOp[] };
        return jsonResponse({
          results: body.ops.map((o) => ({ op_id: o.op_id, status: "applied", rev: 2, seq: 9 })),
          server_time: "2026-09-11T10:00:05.000Z",
        } satisfies OpsResponse);
      });
      const result = await pushOutbox({ fetchFn: fetchFn as unknown as typeof fetch });
      expect(result).toMatchObject({ pushed: 1, applied: 1, failed: false });
      expect(fetchFn.mock.calls[0][0]).toBe("/api/sync/ops");
      expect(fetchFn.mock.calls[0][1].method).toBe("POST");
    });

    it("reports a failure instead of throwing when the route is down", async () => {
      await enqueue(OP, 1_000);
      const result = await pushOutbox({
        fetchFn: (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch,
      });
      expect(result.failed).toBe(true);
    });
  });

  describe("syncOnce", () => {
    it("pulls, then pushes, then stamps the last sync", async () => {
      const order: string[] = [];
      const fetchFn = vi.fn(async (url: string) => {
        order.push(url);
        return url.startsWith("/api/sync/changes")
          ? jsonResponse({ changes: [], next_cursor: 0, has_more: false })
          : jsonResponse({ results: [], server_time: "2026-09-11T10:00:05.000Z" } satisfies OpsResponse);
      });
      await enqueue(OP, 1_000);
      await syncOnce({ fetchFn: fetchFn as unknown as typeof fetch });
      expect(order[0]).toContain("/api/sync/changes");
      expect(order[1]).toBe("/api/sync/ops");
      await expect(lastSyncAt()).resolves.toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
  ```
- [ ] Run it. Expected failure: `TypeError: The requested module './client' does not provide an export named 'pushOutbox'`
  ```bash
  pnpm test lib/sync/client.test.ts
  ```
- [ ] Append the implementation to `lib/sync/client.ts`.
  ```ts
  // appended to lib/sync/client.ts
  import { getLastSyncAt, setLastSyncAt } from "./idb";
  import { drainOutbox, type DrainResult } from "./outbox";
  import type { OpsResponse, SyncOp } from "./types";

  export function lastSyncAt(): Promise<string | null> {
    return getLastSyncAt();
  }

  export async function pushOutbox(options: SyncOptions = {}): Promise<DrainResult> {
    const fetchFn = options.fetchFn ?? globalThis.fetch;
    return drainOutbox(async (ops: SyncOp[]) => {
      const res = await fetchFn("/api/sync/ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ops }),
      });
      if (!res.ok) throw new Error(`sync: POST /api/sync/ops failed with ${res.status}`);
      return (await res.json()) as OpsResponse;
    });
  }

  let inFlight: Promise<{ pull: PullResult; push: DrainResult }> | null = null;

  /** Pull before push, so a conflict merges against the freshest row we can see. Calls coalesce. */
  export async function syncOnce(
    options: SyncOptions = {},
  ): Promise<{ pull: PullResult; push: DrainResult }> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const pull = await pullChanges(undefined, options);
        const push = await pushOutbox(options);
        await setLastSyncAt(new Date().toISOString());
        globalThis.dispatchEvent?.(new Event(SYNCED_EVENT));
        return { pull, push };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }
  ```
- [ ] Run it. Expected: `Tests  9 passed (9)`.
  ```bash
  pnpm test lib/sync/client.test.ts
  ```
- [ ] Commit.
  ```bash
  git add lib/sync/client.ts lib/sync/client.test.ts && git commit -m "feat(sync): push the outbox and coalesce a full pull-then-push pass"
  ```

---

## Task 12 — `app/api/sync/ops/route.ts`

**Files** — Create: `app/api/sync/ops/route.ts`. Test path: `tests/sync/ops-route.test.ts`.

**Interfaces** — Consumes (contracts §5, Lane B): `requireUser(req): Promise<{ userId: string; client:
SupabaseClient }>`, `enforceRateLimit(key, limit, windowSeconds)`, `readJson<T>(req, schema, maxBytes)`,
`jsonError(e): Response`. Produces:
`export async function POST(req: Request): Promise<Response>` returning `OpsResponse`.

**Per-op error isolation.** Each `apply_sync_op` RPC call is wrapped in its own try/catch — a driver
error (`{ error }`) or a thrown exception becomes `{ op_id, status: 'error', message }` for that op
only, and the loop continues. The route never throws once it has started the loop, so a failure on
op 5 of 10 does not discard the four results already collected for ops 1–4; the response is always
`200` with exactly one result per op, in order.

- [ ] Lane B gate (expected: four paths printed, exit 0).
  ```bash
  cd /Users/zero-suminc./projects/clients/Sasha/meal-companion && ls lib/server/auth.ts lib/server/http.ts lib/server/ratelimit.ts lib/supabase/server.ts
  ```
- [ ] Write the failing test.
  ```ts
  // tests/sync/ops-route.test.ts
  import { beforeEach, describe, expect, it, vi } from "vitest";
  import type { SyncOp } from "@/lib/sync/types";

  const rpc = vi.fn();
  const requireUser = vi.fn();
  const enforceRateLimit = vi.fn();

  vi.mock("@/lib/server/auth", async () => {
    const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
    return { ...actual, requireUser: (req: Request) => requireUser(req) };
  });
  vi.mock("@/lib/server/ratelimit", () => ({
    enforceRateLimit: (...args: unknown[]) => enforceRateLimit(...args),
  }));

  const { POST } = await import("@/app/api/sync/ops/route");
  const { HttpError } = await import("@/lib/server/auth");

  const op = (over: Partial<SyncOp> = {}): SyncOp => ({
    op_id: crypto.randomUUID(), entity: "water_log", entity_id: "2026-09-11", kind: "update",
    base_rev: 1, payload: { local_date: "2026-09-11", cups: 4 },
    client_ts: "2026-09-11T10:00:00.000Z", ...over,
  });

  const request = (body: unknown) => new Request("https://x.test/api/sync/ops", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  beforeEach(() => {
    rpc.mockReset();
    enforceRateLimit.mockReset().mockResolvedValue(undefined);
    requireUser.mockReset().mockResolvedValue({ userId: "u1", client: { rpc } });
  });

  describe("POST /api/sync/ops", () => {
    it("returns 401 when there is no session", async () => {
      requireUser.mockRejectedValue(new HttpError(401, "unauthorized"));
      const res = await POST(request({ ops: [op()] }));
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: "unauthorized" });
    });

    it("rate-limits at 60 a minute, keyed by the user", async () => {
      rpc.mockResolvedValue({ data: { op_id: "x", status: "gone" }, error: null });
      await POST(request({ ops: [op()] }));
      expect(enforceRateLimit).toHaveBeenCalledWith("sync:ops:u1", 60, 60);
    });

    it("rejects a bad op shape with 400 and never echoes the body", async () => {
      const res = await POST(request({ ops: [{ ...op(), kind: "obliterate" }] }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: "bad_request" });
      expect(JSON.stringify(body)).not.toContain("obliterate");
    });

    it("rejects more than 200 ops", async () => {
      expect((await POST(request({ ops: Array.from({ length: 201 }, () => op()) }))).status).toBe(400);
    });

    it("calls apply_sync_op once per op, in array order, and returns the results", async () => {
      const a = op();
      const id = "6f2d1a3c-0b1e-4d2a-9a3b-1c2d3e4f5a6b";
      const b = op({ entity: "gut_log", entity_id: id, payload: { id, state: "good" } });
      rpc
        .mockResolvedValueOnce({ data: { op_id: a.op_id, status: "applied", rev: 2, seq: 8 }, error: null })
        .mockResolvedValueOnce({ data: { op_id: b.op_id, status: "duplicate" }, error: null });
      const res = await POST(request({ ops: [a, b] }));
      expect(res.status).toBe(200);
      expect(rpc.mock.calls[0]).toEqual(["apply_sync_op", { p_user_id: "u1", p_op: a }]);
      expect(rpc.mock.calls.map((c) => c[1].p_op.op_id)).toEqual([a.op_id, b.op_id]);
      const body = await res.json();
      expect(body.results.map((r: { status: string }) => r.status)).toEqual(["applied", "duplicate"]);
      expect(typeof body.server_time).toBe("string");
    });

    it("turns a single op's RPC error into an 'error' result, not a 500 for the whole batch", async () => {
      const failing = op();
      rpc.mockResolvedValue({ data: null, error: { message: "deadlock on log_entries" } });
      const res = await POST(request({ ops: [failing] }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([
        { op_id: failing.op_id, status: "error", message: "deadlock on log_entries" },
      ]);
    });

    it("keeps applying later ops after an earlier one errors, and never throws past the first success", async () => {
      const a = op();
      const b = op({ entity: "gut_log", entity_id: "6f2d1a3c-0b1e-4d2a-9a3b-1c2d3e4f5a6b" });
      rpc
        .mockResolvedValueOnce({ data: { op_id: a.op_id, status: "applied", rev: 2, seq: 8 }, error: null })
        .mockResolvedValueOnce({ data: null, error: { message: "deadlock on gut_log" } });
      const res = await POST(request({ ops: [a, b] }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([
        { op_id: a.op_id, status: "applied", rev: 2, seq: 8 },
        { op_id: b.op_id, status: "error", message: "deadlock on gut_log" },
      ]);
    });

    it("catches a thrown exception from one op's rpc call the same way as a driver error", async () => {
      const failing = op();
      rpc.mockImplementation(async () => { throw new Error("connection reset"); });
      const res = await POST(request({ ops: [failing] }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([{ op_id: failing.op_id, status: "error", message: "connection reset" }]);
    });
  });
  ```
- [ ] Run it. Expected failure: `Error: Failed to load url @/app/api/sync/ops/route`
  ```bash
  pnpm test tests/sync/ops-route.test.ts
  ```
- [ ] Write the route.
  ```ts
  // app/api/sync/ops/route.ts
  /**
   * POST /api/sync/ops — apply a batch of sync ops. §5 security matrix: Supabase JWT, 1 MB body,
   * 60/min/user, idempotent on `op_id`. Identity comes first because the rate-limit key IS the user
   * id. One `apply_sync_op` RPC per op, in array order; the RPC does the compare-and-swap.
   */
  import { requireUser } from "@/lib/server/auth";
  import { jsonError, readJson } from "@/lib/server/http";
  import { enforceRateLimit } from "@/lib/server/ratelimit";
  import { OpsRequestSchema, type OpResult, type OpsResponse } from "@/lib/sync/types";

  export const runtime = "nodejs";
  export const dynamic = "force-dynamic";

  const BODY_LIMIT_BYTES = 1_048_576;
  const RATE_LIMIT = 60;
  const RATE_WINDOW_SECONDS = 60;

  export async function POST(req: Request): Promise<Response> {
    try {
      const { userId, client } = await requireUser(req);
      await enforceRateLimit(`sync:ops:${userId}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
      const body = await readJson(req, OpsRequestSchema, BODY_LIMIT_BYTES);

      const results: OpResult[] = [];
      for (const op of body.ops) {
        // One op's failure must not lose the results already collected for the ops before it, and
        // must not stop the ops after it from running — each op gets its own try/catch, and the
        // batch always comes back 200 with one result per op.
        try {
          const { data, error } = await client.rpc("apply_sync_op", { p_user_id: userId, p_op: op });
          if (error) throw new Error(error.message);
          results.push(data as OpResult);
        } catch (e) {
          const message = e instanceof Error ? e.message : "unknown";
          results.push({ op_id: op.op_id, status: "error", message });
        }
      }

      const payload: OpsResponse = { results, server_time: new Date().toISOString() };
      return Response.json(payload);
    } catch (e) {
      return jsonError(e);
    }
  }
  ```
- [ ] Run it. Expected: `Tests  8 passed (8)`.
  ```bash
  pnpm test tests/sync/ops-route.test.ts
  ```
- [ ] Commit.
  ```bash
  git add app/api/sync/ops/route.ts tests/sync/ops-route.test.ts && git commit -m "feat(sync): add POST /api/sync/ops over apply_sync_op"
  ```

---

## Task 13 — `app/api/sync/changes/route.ts`

**Files** — Create: `app/api/sync/changes/route.ts`. Test path: `tests/sync/changes-route.test.ts`.

**Interfaces** — Consumes: `requireUser`, `HttpError`, `jsonError`, `enforceRateLimit` (as Task 12).
Produces: `export async function GET(req: Request): Promise<Response>` returning `ChangesResponse`.

- [ ] Write the failing test.
  ```ts
  // tests/sync/changes-route.test.ts
  import { beforeEach, describe, expect, it, vi } from "vitest";
  import type { ChangeRow } from "@/lib/sync/types";

  const rpc = vi.fn();
  const requireUser = vi.fn();
  const enforceRateLimit = vi.fn();

  vi.mock("@/lib/server/auth", async () => {
    const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
    return { ...actual, requireUser: (req: Request) => requireUser(req) };
  });
  vi.mock("@/lib/server/ratelimit", () => ({
    enforceRateLimit: (...args: unknown[]) => enforceRateLimit(...args),
  }));

  const { GET } = await import("@/app/api/sync/changes/route");
  const { HttpError } = await import("@/lib/server/auth");

  const change = (seq: number): ChangeRow => ({
    seq, entity: "water_log", entity_key: "2026-09-11", rev: seq, op: "update",
    at: "2026-09-11T10:00:00.000Z", current: { local_date: "2026-09-11", cups: seq },
  });

  const get = (query: string) => GET(new Request(`https://x.test/api/sync/changes${query}`));

  beforeEach(() => {
    rpc.mockReset().mockResolvedValue({ data: [], error: null });
    enforceRateLimit.mockReset().mockResolvedValue(undefined);
    requireUser.mockReset().mockResolvedValue({ userId: "u1", client: { rpc } });
  });

  describe("GET /api/sync/changes", () => {
    it("returns 401 with no session", async () => {
      requireUser.mockRejectedValue(new HttpError(401, "unauthorized"));
      expect((await get("?since=0")).status).toBe(401);
    });

    it("rate-limits 60 a minute per user", async () => {
      await get("?since=0");
      expect(enforceRateLimit).toHaveBeenCalledWith("sync:changes:u1", 60, 60);
    });

    it("rejects a non-numeric since, a negative since and a non-numeric limit", async () => {
      const res = await get("?since=yesterday");
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_request" });
      expect((await get("?since=-1")).status).toBe(400);
      expect((await get("?since=0&limit=lots")).status).toBe(400);
    });

    it("defaults since to 0 and limit to 500, and clamps limit to 500", async () => {
      await get("");
      expect(rpc).toHaveBeenCalledWith("sync_changes", { p_user_id: "u1", p_since: 0, p_limit: 500 });
      await get("?since=7&limit=9000");
      expect(rpc).toHaveBeenLastCalledWith("sync_changes", { p_user_id: "u1", p_since: 7, p_limit: 500 });
    });

    it("reports next_cursor as the last seq and has_more when the page is full", async () => {
      rpc.mockResolvedValue({ data: [change(8), change(9)], error: null });
      const body = await (await get("?since=7&limit=2")).json();
      expect(body).toMatchObject({ next_cursor: 9, has_more: true });
      expect(body.changes).toHaveLength(2);
    });

    it("keeps the caller's cursor when the page is empty", async () => {
      await expect((await get("?since=7")).json()).resolves.toMatchObject({
        changes: [], next_cursor: 7, has_more: false,
      });
    });
  });
  ```
- [ ] Run it. Expected failure: `Error: Failed to load url @/app/api/sync/changes/route`
  ```bash
  pnpm test tests/sync/changes-route.test.ts
  ```
- [ ] Write the route.
  ```ts
  // app/api/sync/changes/route.ts
  /**
   * GET /api/sync/changes?since=<seq>&limit=<≤500> — one page of the change feed. §5 matrix:
   * Supabase JWT, 60/min/user. The client saves `next_cursor` only after it has applied the whole
   * page (architecture §3.7).
   */
  import { HttpError, requireUser } from "@/lib/server/auth";
  import { jsonError } from "@/lib/server/http";
  import { enforceRateLimit } from "@/lib/server/ratelimit";
  import type { ChangeRow, ChangesResponse } from "@/lib/sync/types";

  export const runtime = "nodejs";
  export const dynamic = "force-dynamic";

  const MAX_LIMIT = 500;
  const RATE_LIMIT = 60;
  const RATE_WINDOW_SECONDS = 60;

  function parseCount(raw: string | null, fallback: number, max: number, field: string): number {
    if (raw === null || raw === "") return fallback;
    if (!/^\d+$/.test(raw)) {
      throw new HttpError(400, "bad_request", `${field} must be a non-negative integer`);
    }
    return Math.min(Number(raw), max);
  }

  export async function GET(req: Request): Promise<Response> {
    try {
      const { userId, client } = await requireUser(req);
      await enforceRateLimit(`sync:changes:${userId}`, RATE_LIMIT, RATE_WINDOW_SECONDS);

      const params = new URL(req.url).searchParams;
      const since = parseCount(params.get("since"), 0, Number.MAX_SAFE_INTEGER, "since");
      const limit = Math.max(1, parseCount(params.get("limit"), MAX_LIMIT, MAX_LIMIT, "limit"));

      const { data, error } = await client.rpc("sync_changes", {
        p_user_id: userId, p_since: since, p_limit: limit,
      });
      if (error) throw new HttpError(500, "internal", error.message);

      const changes = (data ?? []) as ChangeRow[];
      const payload: ChangesResponse = {
        changes,
        next_cursor: changes.length > 0 ? changes[changes.length - 1].seq : since,
        has_more: changes.length === limit,
      };
      return Response.json(payload);
    } catch (e) {
      return jsonError(e);
    }
  }
  ```
- [ ] Run it. Expected: `Tests  6 passed (6)`.
  ```bash
  pnpm test tests/sync/changes-route.test.ts
  ```
- [ ] Commit.
  ```bash
  git add app/api/sync/changes/route.ts tests/sync/changes-route.test.ts && git commit -m "feat(sync): add GET /api/sync/changes over sync_changes"
  ```

---

## Task 14 — `components/SyncBootstrap.tsx`

**Files** — Modify: `components/SyncBootstrap.tsx`. Test path: none. `vitest.config.ts` sets
`environment: "node"` and `include: ["**/*.test.ts"]`, so no `.tsx` test is collected and there is no
DOM. The component is deliberately thin: every decision it makes lives in `lib/sync/client.ts`, which
Tasks 10–11 test. Verification is `tsc --noEmit`, `pnpm lint` and the spec's manual gate.

**Interfaces** — Consumes: `syncOnce` from `@/lib/sync/client`; `setOnSave` from `@/lib/store`.
Produces: the default-exported client component already mounted in `app/layout.tsx:48`.

- [ ] Read the current wiring, so the four triggers survive (expected: `getSyncToken`,
      `installSyncHooks`, `visibilitychange`, `online`).
  ```bash
  cd /Users/zero-suminc./projects/clients/Sasha/meal-companion && cat components/SyncBootstrap.tsx
  ```
- [ ] Rewrite the file.
  ```tsx
  "use client";

  import { useEffect } from "react";
  import { setOnSave } from "@/lib/store";
  import { syncOnce } from "@/lib/sync/client";

  const SAVE_DEBOUNCE_MS = 1500;

  /**
   * Runs a sync pass on open, on return to the tab, when signal comes back, and 1.5 s after a local
   * save — the same four triggers the token-era bootstrap had. Identity is now the Supabase session
   * cookie, so there is no `#k=` token to capture and no install link to clean up.
   */
  export default function SyncBootstrap() {
    useEffect(() => {
      let timer: number | null = null;
      const run = () => {
        void syncOnce().catch(() => {
          // Offline or signed out. The outbox keeps the write and backs off on its own.
        });
      };

      run();

      const onVisible = () => {
        if (document.visibilityState === "visible") run();
      };
      const onOnline = () => run();
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("online", onOnline);

      setOnSave(() => {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = null;
          run();
        }, SAVE_DEBOUNCE_MS);
      });

      return () => {
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("online", onOnline);
        if (timer) window.clearTimeout(timer);
        setOnSave(null);
      };
    }, []);

    return null;
  }
  ```
- [ ] Compile, lint, and confirm the token path is gone (expected: no output from any of the three).
  ```bash
  pnpm exec tsc --noEmit && pnpm lint && grep -n 'getSyncToken\|#k=\|@/lib/sync"' components/SyncBootstrap.tsx
  ```
- [ ] Commit.
  ```bash
  git add components/SyncBootstrap.tsx && git commit -m "feat(sync): drive SyncBootstrap from the session, not the install token"
  ```

---

## Task 15 — `components/SyncStatus.tsx`

**Files** — Modify: `components/SyncStatus.tsx`. Test path: none, for the reason given in Task 14.
The numbers it renders come from `pendingCount()` and `lastSyncAt()`, covered by Tasks 8 and 11.

**Interfaces** — Consumes: `createClient` from `@/lib/supabase/client` (Lane B); `SYNCED_EVENT`,
`syncOnce`, `lastSyncAt` from `@/lib/sync/client`; `pendingCount` from `@/lib/sync/outbox`.
Produces: the default-exported card already rendered by `app/settings/page.tsx:179`.

- [ ] Lane B gate (expected: the path prints, exit 0).
  ```bash
  cd /Users/zero-suminc./projects/clients/Sasha/meal-companion && ls lib/supabase/client.ts
  ```
- [ ] Rewrite the file.
  ```tsx
  "use client";

  import { useCallback, useEffect, useState } from "react";
  import { createClient } from "@/lib/supabase/client";
  import { lastSyncAt, SYNCED_EVENT, syncOnce } from "@/lib/sync/client";
  import { pendingCount } from "@/lib/sync/outbox";

  type State = { email: string | null; pending: number; lastSync: string | null; syncing: boolean };

  function ago(iso: string | null): string {
    if (!iso) return "never";
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    return h < 24 ? `${h} h ago` : new Date(iso).toLocaleDateString();
  }

  /** Settings card: who is signed in, what is still queued, when this phone last agreed with the server. */
  export default function SyncStatus() {
    const [state, setState] = useState<State>({
      email: null, pending: 0, lastSync: null, syncing: false,
    });

    const refresh = useCallback(async () => {
      const { data } = await createClient().auth.getUser();
      const [pending, lastSync] = await Promise.all([pendingCount(), lastSyncAt()]);
      setState((s) => ({ ...s, email: data.user?.email ?? null, pending, lastSync }));
    }, []);

    useEffect(() => {
      void refresh();
      const onSynced = () => void refresh();
      window.addEventListener(SYNCED_EVENT, onSynced);
      const t = window.setInterval(onSynced, 30_000);
      return () => {
        window.removeEventListener(SYNCED_EVENT, onSynced);
        window.clearInterval(t);
      };
    }, [refresh]);

    const signedOut = state.email === null;

    return (
      <section className="flex flex-col gap-2 rounded-[26px] bg-fog p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-body-sm font-semibold text-graphite">
              {signedOut ? "Signed out" : state.email}
            </p>
            <p className="text-caption text-muted">
              {signedOut
                ? "This phone only. Sign in to see the same list on every device."
                : `Last synced ${ago(state.lastSync)}.${
                    state.pending > 0
                      ? ` ${state.pending} change${state.pending === 1 ? "" : "s"} waiting to send.`
                      : " Everything is sent."
                  }`}
            </p>
          </div>
          {!signedOut && (
            <button
              type="button"
              onClick={async () => {
                setState((s) => ({ ...s, syncing: true }));
                await syncOnce().catch(() => undefined);
                setState((s) => ({ ...s, syncing: false }));
                await refresh();
              }}
              className="tap shrink-0 rounded-[26px] bg-paper px-4 text-body-sm font-semibold text-tangerine"
            >
              {state.syncing ? "Syncing…" : "Sync now"}
            </button>
          )}
        </div>
      </section>
    );
  }
  ```
- [ ] Compile and lint (expected: no output from either, exit 0).
  ```bash
  pnpm exec tsc --noEmit && pnpm lint
  ```
- [ ] Commit.
  ```bash
  git add components/SyncStatus.tsx && git commit -m "feat(sync): show the signed-in email, pending count and last sync"
  ```

---

## Task 16 — `tests/sync/two-client.test.ts` [needs branch]

**Files** — Create: `tests/sync/two-client.test.ts`. Test path: `tests/sync/two-client.test.ts`.

**Interfaces** — Consumes: `SUPABASE_TEST_URL`, `SUPABASE_TEST_SERVICE_ROLE_KEY` (contracts §7);
Lane A's `apply_sync_op`, `sync_changes`, `next_change_seq`; `mergeEntity`, `rebaseOp` from
`@/lib/sync/merge`. Produces: the spec's integration row — the concurrent matrix, a rejected stale
update, a stale delete that does not erase a newer edit, the restore path, offline replay, an
idempotent retry, and cursor continuity under interleaved writes.

**[needs branch]** — the file is skipped unless both env vars are set, so `pnpm test` stays green on
CI and on the Mac.

```bash
# Lane A owns scripts/db-branch.sh; migrations …000100–…000600 must be applied to the branch.
./scripts/db-branch.sh create p0-sync
export SUPABASE_TEST_URL="https://<branch-ref>.supabase.co"
export SUPABASE_TEST_SERVICE_ROLE_KEY="$(zsvault get supabase_p0_branch_service_role)"
# Skip condition (CI and any machine without the branch): leave either variable unset.
```

- [ ] Write the test.
  ```ts
  // tests/sync/two-client.test.ts
  import { createClient, type SupabaseClient } from "@supabase/supabase-js";
  import { beforeAll, describe, expect, it } from "vitest";
  import { mergeEntity, rebaseOp } from "@/lib/sync/merge";
  import type { ChangeRow, OpResult, SyncOp } from "@/lib/sync/types";

  const URL = process.env.SUPABASE_TEST_URL;
  const KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
  const live = Boolean(URL && KEY);

  let admin: SupabaseClient;
  let userId: string;

  async function apply(op: SyncOp): Promise<OpResult> {
    const { data, error } = await admin.rpc("apply_sync_op", { p_user_id: userId, p_op: op });
    if (error) throw new Error(error.message);
    return data as OpResult;
  }

  async function changes(since: number, limit = 500): Promise<ChangeRow[]> {
    const { data, error } = await admin.rpc("sync_changes", {
      p_user_id: userId, p_since: since, p_limit: limit,
    });
    if (error) throw new Error(error.message);
    return (data ?? []) as ChangeRow[];
  }

  const waterOp = (over: Partial<SyncOp> = {}): SyncOp => ({
    op_id: crypto.randomUUID(), entity: "water_log", entity_id: "2026-09-12", kind: "update",
    base_rev: 1, payload: { local_date: "2026-09-12", cups: 1 },
    client_ts: new Date().toISOString(), ...over,
  });

  const entryOp = (id: string, over: Partial<SyncOp> = {}): SyncOp => ({
    op_id: crypto.randomUUID(), entity: "log_entries", entity_id: id, kind: "create",
    base_rev: null, client_ts: new Date().toISOString(),
    payload: {
      id, local_date: "2026-09-11", tz: "America/New_York", slot: "meal-1", method: "plan",
      eaten_at: "2026-09-11T16:00:00.000Z", note: null, items: [],
    },
    ...over,
  });

  describe.skipIf(!live)("two clients and an MCP writer against a branch", () => {
    beforeAll(async () => {
      admin = createClient(URL!, KEY!, { auth: { persistSession: false } });
      const { data, error } = await admin.auth.admin.createUser({
        email: `p0-sync-${crypto.randomUUID()}@example.test`, email_confirm: true,
      });
      if (error) throw new Error(error.message);
      userId = data.user!.id;
    });

    it("applies a create and starts the cursor at 1", async () => {
      const id = crypto.randomUUID();
      expect(await apply(entryOp(id))).toMatchObject({ status: "applied", rev: 1, seq: 1 });
      const feed = await changes(0);
      expect(feed).toHaveLength(1);
      expect(feed[0]).toMatchObject({ entity: "log_entries", entity_key: id, op: "create", rev: 1 });
      expect(feed[0].current).toMatchObject({ slot: "meal-1" });
    });

    it("is idempotent on op_id", async () => {
      const op = entryOp(crypto.randomUUID());
      await apply(op);
      expect(await apply(op)).toMatchObject({ status: "duplicate" });
    });

    it("rejects a stale update with the full current entity, writing nothing", async () => {
      const id = crypto.randomUUID();
      await apply(entryOp(id));
      await apply(entryOp(id, { kind: "update", base_rev: 1, payload: { id, slot: "meal-2", items: [] } }));
      const stale = await apply(
        entryOp(id, { kind: "update", base_rev: 1, payload: { id, slot: "meal-3", items: [] } }),
      ) as Extract<OpResult, { status: "conflict" }>;
      expect(stale).toMatchObject({ status: "conflict", current_rev: 2 });
      expect(stale.current).toMatchObject({ slot: "meal-2" });
    });

    it("merges a conflict to the larger cups, and the rebase lands", async () => {
      const before = (await changes(0)).at(-1)?.seq ?? 0;
      await apply(waterOp({ kind: "create", base_rev: null }));
      await apply(waterOp({ base_rev: 1, payload: { local_date: "2026-09-12", cups: 5 } }));
      const conflicted = await apply(
        waterOp({ base_rev: 1, payload: { local_date: "2026-09-12", cups: 3 } }),
      ) as Extract<OpResult, { status: "conflict" }>;
      expect(conflicted.status).toBe("conflict");
      const merged = mergeEntity("water_log",
        { local_date: "2026-09-12", cups: 3 },
        conflicted.current as Record<string, unknown>,
        new Date().toISOString(), new Date(Date.now() - 1000).toISOString());
      expect(merged.cups).toBe(5);
      expect(await apply(rebaseOp(waterOp({ base_rev: 1 }), merged, conflicted.current_rev)))
        .toMatchObject({ status: "applied" });
      expect((await changes(before)).at(-1)!.current).toMatchObject({ cups: 5 });
    });

    it("never resurrects a tombstone, and only restore revives it", async () => {
      const id = crypto.randomUUID();
      await apply(entryOp(id));
      await apply(entryOp(id, { kind: "delete", base_rev: 1, payload: {} }));
      const stale = await apply(
        entryOp(id, { kind: "update", base_rev: 1, payload: { id, slot: "meal-3", items: [] } }),
      );
      expect(stale.status).toBe("deleted");
      expect(await apply(entryOp(id, { kind: "restore", base_rev: 2, payload: {} })))
        .toMatchObject({ status: "applied", rev: 3 });
    });

    it("answers gone for an entity_id the server never had", async () => {
      const id = crypto.randomUUID();
      expect(await apply(entryOp(id, { kind: "update", base_rev: 1, payload: { id, items: [] } })))
        .toMatchObject({ status: "gone" });
    });

    it("replays an offline batch in order and keeps the cursor contiguous", async () => {
      const before = (await changes(0)).at(-1)?.seq ?? 0;
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      for (const id of ids) await apply(entryOp(id));
      const feed = await changes(before);
      expect(feed.map((c) => c.entity_key)).toEqual(ids);
      expect(feed.map((c) => c.seq)).toEqual([before + 1, before + 2, before + 3]);
    });

    it("pages the feed without skipping a change", async () => {
      const all = await changes(0);
      const first = await changes(0, 2);
      const rest = await changes(first.at(-1)!.seq);
      expect([...first, ...rest].map((c) => c.seq)).toEqual(all.map((c) => c.seq));
    });
  });
  ```
- [ ] Run it with no branch configured. Expected: `Test Files  1 skipped (1)`.
  ```bash
  env -u SUPABASE_TEST_URL -u SUPABASE_TEST_SERVICE_ROLE_KEY pnpm test tests/sync/two-client.test.ts
  ```
- [ ] Run it against the branch. **[needs branch]** Expected: `Tests  8 passed (8)`.
  ```bash
  pnpm test tests/sync/two-client.test.ts
  ```
- [ ] Commit.
  ```bash
  git add tests/sync/two-client.test.ts && git commit -m "test(sync): cover the two-client matrix and cursor continuity on a branch"
  ```

---

## Task 17 — `tests/sync/cross-user-http.test.ts` [needs branch]

**Files** — Create: `tests/sync/cross-user-http.test.ts`.

**Interfaces** — Consumes: `createTestUsers()`, `HAS_BRANCH` from `tests/helpers/supabase.ts` (Lane
A, contracts §1: returns `{ a: {client, userId}, b: {client, userId}, admin }`); the real `POST`
from `app/api/sync/ops/route.ts` and `GET` from `app/api/sync/changes/route.ts` (Task 12, Task 13).
Produces: nothing exported.

Task 16's `two-client.test.ts` calls `apply_sync_op`/`sync_changes` straight through the admin
client — it proves the RPCs are correct, never that a real request from a second user is denied at
the route. This test is that half: real HTTP `Request`s, carrying each user's own bearer token, so
RLS and `requireUser` do the actual work Lane A's `tests/rls/**` cannot exercise (no route) and
Task 16 does not exercise (no per-user session).

**[needs branch]** — skipped via `HAS_BRANCH`, exactly like Task 16.

- [ ] Write the test.
  ```ts
  // tests/sync/cross-user-http.test.ts
  import { beforeAll, describe, expect, it } from "vitest";
  import { GET as getChanges } from "../../app/api/sync/changes/route";
  import { POST as postOps } from "../../app/api/sync/ops/route";
  import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
  import type { SyncOp } from "@/lib/sync/types";

  const run = HAS_BRANCH ? describe : describe.skip;
  const A_WATER_DATE = "2026-09-11";

  function opsRequest(ops: SyncOp[], accessToken?: string): Request {
    return new Request("https://app.test/api/sync/ops", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ ops }),
    });
  }

  function changesRequest(accessToken?: string): Request {
    return new Request("https://app.test/api/sync/changes?since=0", {
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
  }

  run("sync routes cross-user denial", () => {
    let bToken = "";

    beforeAll(async () => {
      const { a, b, admin } = await createTestUsers();

      // A real water_log row for user A, created through apply_sync_op (not a raw insert) so it
      // also lands in change_log — otherwise sync_changes has nothing to (not) return.
      const created = await admin.rpc("apply_sync_op", {
        p_user_id: a.userId,
        p_op: {
          op_id: crypto.randomUUID(), entity: "water_log", entity_id: A_WATER_DATE, kind: "create",
          base_rev: null, payload: { local_date: A_WATER_DATE, cups: 3 },
          client_ts: new Date().toISOString(),
        },
      });
      expect(created.error).toBeNull();

      const session = await b.client.auth.getSession();
      expect(session.data.session).not.toBeNull();
      bToken = session.data.session!.access_token;
    });

    it("401s both routes with no session", async () => {
      const opsRes = await postOps(opsRequest([{
        op_id: crypto.randomUUID(), entity: "water_log", entity_id: A_WATER_DATE, kind: "update",
        base_rev: 1, payload: { local_date: A_WATER_DATE, cups: 9 },
        client_ts: new Date().toISOString(),
      }]));
      expect(opsRes.status).toBe(401);
      expect((await getChanges(changesRequest())).status).toBe(401);
    });

    it("user B's op against user A's entity key comes back 'gone', with zero effect", async () => {
      const res = await postOps(opsRequest([{
        op_id: crypto.randomUUID(), entity: "water_log", entity_id: A_WATER_DATE, kind: "update",
        base_rev: 1, payload: { local_date: A_WATER_DATE, cups: 9 },
        client_ts: new Date().toISOString(),
      }], bToken));
      expect(res.status).toBe(200);
      const body = await res.json();
      // 'gone': water_log is keyed by (user_id, local_date), so B's own table has no such row —
      // apply_sync_op never reaches, let alone touches, A's row.
      expect(body.results).toMatchObject([{ status: "gone" }]);
    });

    it("user B's GET /api/sync/changes returns none of user A's rows", async () => {
      const body = await (await getChanges(changesRequest(bToken))).json();
      const aRow = body.changes.find(
        (c: { entity_key: string }) => c.entity_key === A_WATER_DATE,
      );
      expect(aRow).toBeUndefined();
    });
  });
  ```
- [ ] Run it with no branch configured. Expected: `Test Files  1 skipped (1)`.
  ```bash
  env -u SUPABASE_TEST_URL -u SUPABASE_TEST_SERVICE_ROLE_KEY -u SUPABASE_TEST_ANON_KEY pnpm test tests/sync/cross-user-http.test.ts
  ```
- [ ] Run it against the branch. **[needs branch]** Expected: `Tests  3 passed (3)`.
  ```bash
  pnpm test tests/sync/cross-user-http.test.ts
  ```
- [ ] Commit.
  ```bash
  git add tests/sync/cross-user-http.test.ts && git commit -m "test(sync): deny user B's ops and changes read against user A's data at the route"
  ```

---

## Lane exit gate

Run from `/Users/zero-suminc./projects/clients/Sasha/meal-companion` on `feat/p0-sync`.

| # | Command | Expected |
|---|---|---|
| 1 | `pnpm exec tsc --noEmit` | no output, exit 0 |
| 2 | `pnpm lint` | no output, exit 0 |
| 3 | `pnpm test lib/sync tests/sync` | `Test Files 9 passed \| 2 skipped (11)` — the skips are `two-client` and `cross-user-http` without a branch |
| 4 | `pnpm build` | `✓ Compiled successfully`, with `/api/sync/ops` and `/api/sync/changes` listed as `ƒ` (dynamic) |
| 5 | `grep -rn "SASHA_SYNC_TOKEN\|getSyncToken\|#k=" components/SyncBootstrap.tsx components/SyncStatus.tsx` | no matches |
| 6 | `grep -rn "SUPABASE_SERVICE_ROLE_KEY" lib/sync app/api/sync` | no matches (spec acceptance 6) |
| 7 | `grep -rn "createClient\|createServerClient" app/api/sync` | no matches — both routes take their client from `requireUser` (spec acceptance 3) |
| 8 | `wc -l lib/sync/*.ts app/api/sync/*/route.ts components/Sync*.tsx` | every file under 400 lines |
| 9 | `pnpm test tests/sync/two-client.test.ts` with both env vars set **[needs branch]** | `Tests 8 passed (8)` |
| 10 | `pnpm test tests/sync/cross-user-http.test.ts` with both env vars set **[needs branch]** | `Tests 3 passed (3)` |

Do not run `pnpm test` with no path: the merge queue runs the full suite on the PR (AGENTS.md, "CI
and branches").

## Hand-off to integration

The integration branch owns the cut-over. This lane leaves it four jobs, none touching a file this
lane owns:

1. **Switch the store's reads.** `lib/store.ts` still writes localStorage and is the UI's only
   reader. Point `loadStore()` at `allRows()` from `lib/sync/idb.ts` (`user_foods`, `log_entries`,
   `water_log`, `plan_days`, `user_settings`, `gut_log`), keeping the localStorage blob as the
   offline-first write path until the read path is proven. `components/AuthGate.tsx` (Lane B) must
   render from IndexedDB before the session check resolves; `allRows()` is safe to call signed out.
2. **Emit ops on every local write.** Each `saveStore`-backed mutation in `lib/store.ts`
   (`updateDay`, `addExtra`, `updateExtra`, `removeExtra`, `setSlotNote`, `upsertFood`,
   `setFoodStatus`, `setFoodNote`) becomes one `enqueue()` call with
   `entity_id = encodeKey(entity, payload)` — `enqueue` throws when the two disagree, so a wrong
   mapping fails loudly. Reuse Lane D's `lib/migrate/legacy.ts` field mapping rather than writing a
   second one.
3. **Delete the legacy path.** `lib/sync.ts`, `lib/sync.test.ts`, `app/api/sync/route.ts` and
   `lib/server/db.ts` go in release B. Two imports outside this lane break and must move:
   `app/settings/page.tsx:11` imports `SYNCED_EVENT` from `@/lib/sync` — repoint it at
   `@/lib/sync/client`, which exports the same `"sasha:synced"` string; `app/api/mcp/route.ts`
   imports `pullAll` / `pushRecords` from `@/lib/server/db`, which Lane B's auth swap replaces.
4. **Wire the "targets changed elsewhere" notice.** `lib/sync/outbox.ts` dispatches
   `TARGETS_CHANGED_EVENT` (`"sasha:targets-changed"`) when a never-merged entity conflicts. Phase 0
   syncs no `target_profiles`, so nothing listens yet; the listener ships with Phase 2 targets.

`package.json` is untouched by this lane — `fake-indexeddb` was already a `main` devDependency
before Task 1 ran (contracts §7).

## Open questions

`user_food_prefs`'s entity key (bare `food_ref_id`, contracts §4), the fingerprint's floor-not-round
bucketing and its comma item separator (contracts §4.1), and whether `fake-indexeddb` needs a lane
dependency edit (contracts §7: it is a `main` devDependency already) are no longer open — the
2026-09-10 contract update answers all four.

1. **No server timestamp on a conflict.** `OpResult.conflict` carries `current` but no `at`.
   `serverTimestampOf` reads `updated_at`, then `changed_at`, then `eaten_at`, then `created_at`,
   and falls back to "now", which lets the server win a tie. `water_log`, `gut_log` and `log_items`
   have no timestamp column at all, so they always take the fallback. Adding `at timestamptz` to the
   conflict JSON in `apply_sync_op` removes the guesswork — one line in Lane A.
2. **`user_foods` has no merge rule.** It is in `ENTITIES` but appears in no row of the §3.7 merge
   table. This lane merges it newer-client_ts-per-field with dominant tombstones, like `plan_days`.
   Confirm, or name the fields that need a special rule — `per_100g` in particular, where field-wise
   newer-wins can mix two label scans of the same food.
3. **`gut_log.note` and `user_settings.first_opened_at`.** `gut_log` follows per-field newer-wins, so
   a note typed on the laptop can replace one typed on the phone — unlike `user_food_prefs.note`,
   which keeps both. Both are symptom evidence; should `gut_log.note` join too? Separately,
   `first_opened_at` drives the ramp stage, and per-field newer-wins lets a later value overwrite an
   earlier one; the earlier date is almost certainly the correct one.
4. **`entryFingerprint` is async.** It returns `Promise<string>` where the spec's Engines block
   writes `string`, because `subtle.digest` is async; `fingerprintSource` is the synchronous, pure
   half. Accept, or say the Phase 2 duplicate card needs a synchronous call and this lane should
   vendor a JS SHA-256.
