# Slice 1 — Device-state isolation (spec section 0)

> **IMPLEMENTED — see PR #248 (branch `fix/p9-device-state-isolation`, in review; latest `8a5b506`).**
> The PR code, its reviews in `docs/audit/code/` and spec section 0 (updated 2026-09-23 to match
> it) are the source of truth; the text below is the original plan and is superseded where they
> differ. Actual switch behavior at `8a5b506`: every data route requires `x-smc-account`
> (`401 account_header_required` when missing); the legacy `smc` database is never deleted in
> slice 1; on a switch only server-refillable caches (health daily, expenditure, proposals) are
> deleted and the account DB, store, drafts, scans, coach transcripts, coach-action marks, food refs
> and the shell cache are kept; unsaved in-memory edits are flushed to storage before the next
> account is bound. A re-plan to reload the page on every account switch is under evaluation.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a shared phone, nothing of account A is read, written, sent, shown or settled under account B. Work that started as A never writes after a switch. A's unsent work survives and sends as A. The server refuses an op or a direct request whose account is not the JWT subject.

**Architecture:** A new module `lib/device/account.ts` holds the bound account and an `epoch` that increments on every bind and unbind. Every IndexedDB and storage primitive takes an `AccountHandle` (`{ userId, epoch }`) and checks it before it writes, so TypeScript finds every caller and a stale handle throws `AccountChanged`. Each account gets its own database `smc-u-<userId>`. Outbox ops carry `user_id`; direct `/api/` calls go through `accountFetch`, which adds `x-smc-account`; `requireUser` refuses a mismatch with `409`. The legacy `smc` database is read once per row for adoption and its ops are held, never sent.

**Tech Stack:** TypeScript, React 19, `idb`, Vitest 5 with `fake-indexeddb` (node environment) and `jsdom` (per-file pragma), Zod 4.

**Spec:** `docs/specs/phase-9-tenancy-blank-slate.md`, section 0 and the Slices list item 1.

**Branch:** `fix/p9-device-state-isolation` (a live production bug). One PR, unmerged. **No migration.**

## Global Constraints

See `README.md` in this directory. For this slice in particular:

- No migration. `apply_sync_op` already refuses a `p_user_id` that is not `auth.uid()`
  (`supabase/migrations/20260911000600_rpc.sql:8-19`).
- **The server refuses every op without a proven owner (spec 0.5; plan decision P8, reversed in
  round 2).** Missing `user_id` → `{ status: "error", message: "account_unbound" }`; a `user_id`
  that is not the JWT subject → `{ status: "error", message: "account_mismatch" }`. Neither writes.
  Reason: two same-origin tabs share one session cookie, so an ownerless op from an old tab can be
  A's change sent under B's cookie (audit plan r2 finding 1).
- **Why `error` keeps an old tab's ops (checked in the current client).** An old build handles a
  per-op `error` in `applyResult` (`lib/sync/outbox.ts:309-312`) with `parkOrRetry`
  (`:198-208`): it retries with backoff, then parks the op with `next_attempt_at` one year out. It
  never deletes it (`:194-197`). `log_entries` ops reach the same branch, because
  `handleLogEntryResult` handles only `applied`, `duplicate` and `conflict`
  (`lib/sync/log-entry-ops.ts:143-161`); `food_membership` ops too, because
  `applyFoodMembershipResult` handles only `rejected` and `applied`
  (`lib/sync/outbox-membership.ts:16-37`). An unknown status would be dropped (`outbox.ts:305-308,320`),
  so the status stays `error`.
- **The old tab upgrades by itself.** The service worker `CACHE_VERSION` goes to `v3` in this slice,
  and `activate` calls `client.navigate(client.url)` on every window it controls after
  `clients.claim()` (Task 10a). `install` already calls `skipWaiting()` (`public/sw.js:28-41`), so an
  old tab reloads into the new build at the first update check (a navigation, or a fetch event more
  than 24 hours after the last check). After the reload, the parked ops are in the legacy `smc`
  database and are held, not sent (spec 0.6). They are not lost: `smc` is kept while it holds them
  (Task 9 rule 5).
- **No legacy op is re-stamped.** A legacy op has no owner proof: a queued water op carries no
  `user_id` in its payload or its mirror row (`lib/water-client.ts:48-51`), and a phone that
  served two accounts cannot tell whose it is. Stamping one would be the same guess the server now
  refuses. Legacy records that *do* carry an owner (pending log records, weigh-ins, target
  revisions) are adopted by owner (Task 9 rule 4a). Recovery of held ops stays "Later" (spec).
- **Residual risk, stated for Devin:** a change Sasha makes in an old tab between the deploy and that
  tab's reload is refused, parked and then held on the phone (counted in Settings → Sync, not
  sent). Rollout step 0 (open the app online once) and the human step "close and reopen the app
  right after the deploy" keep that window short.
- ~~A missing `x-smc-account` header is accepted in this slice.~~ **As implemented in PR #248
  (review r3 #1), the header is required: a request without it answers `401
  account_header_required`** (`fix/p9-device-state-isolation:lib/server/auth.ts:32-43`). The old
  build reads `401` as a lapsed session and keeps its writes queued; the `v3` service worker then
  reloads it. A present, different header is `409 account_mismatch`. Slices 4–8 follow PR #248.
- Legacy `smc` ops are never stamped, sent, shown or exported. Only their count is shown.
- The database name is `smc-u-<userId>`, version 1, created by the same upgrade loop over
  `ENTITIES` (`lib/sync/idb.ts:43-57`).
- Storage keys: `smc:u:<userId>:<name>`. Device-level keys stay as they are.

## Review Focus (this slice)

1. Same-user token refresh fires `onAuthStateChange` with the same id: the epoch must not change.
   Test in Task 1.
2. Blocked IndexedDB: open failure must not be cached (keep `lib/sync/idb.ts:58-61` behavior per
   account). Test in Task 2.
3. A write that awaits between its read and its write (for example `lib/water-client.ts:41-51`)
   across a switch: the write throws `AccountChanged` and nothing lands. Test in Task 3.
4. Two tabs: tab 1 still bound to A while the cookie is now B. The server answers `409` for A's
   request. Test in Task 7.
5. The first boot of the new build with a legacy database that holds another account's rows. Test
   in Task 9.

## Current code this slice changes (verified 2026-09-22 at `1d5790d`)

| Fact | Where |
|---|---|
| One database for every account, `DB_NAME = "smc"`, cached in `dbPromise` | `lib/sync/idb.ts:12,39-63` |
| Primitives without an account | `lib/sync/idb.ts:72-86` (`putRow`, `getRow`, `deleteRow`, `allRows`), `:97-121` (`appendOp`, `appendOpWithRow`), `:156-179` (`writeOp`), `:199-246` (`mutateRowWithOp`), `:248-289` (outbox, cursor, last sync, last error) |
| Direct `openSmcDb()` users outside `idb.ts` | `lib/targets/client.ts:142,152,160,169`; `lib/health/weigh-in-client.ts:102,112`; `lib/favorites-client.ts:28,33`; `lib/db/catalog-cache.ts:41,55,65,77`; `lib/log/pending.ts:100,115`; `lib/foods/adopt-client.ts:69,83`; `lib/sync/plan-cache.ts:12`; `lib/sync/plan-days.ts:20,51` |
| All non-test importers of `@/lib/sync/idb` (36 files) | `components/AuthGate.tsx`, `components/LoggedExtras.tsx`, `components/add-food/catalog-food.ts`, `lib/activity/prompt-client.ts`, `lib/body-profile-client.ts`, `lib/coach/apply-entries.ts`, `lib/coach/apply-log.ts`, `lib/coach/apply-prefs.ts`, `lib/coach/role-advice.ts`, `lib/db/catalog-cache.ts`, `lib/favorites-client.ts`, `lib/foods/adopt-client.ts`, `lib/foods/prefs-client.ts`, `lib/health/weigh-in-client.ts`, `lib/log-commit-client.ts`, `lib/log-commit-settle.ts`, `lib/log-note-client.ts`, `lib/log/delete-entry.ts`, `lib/log/pending.ts`, `lib/log/reconcile.ts`, `lib/log/retry-unsaved.ts`, `lib/log/today-state.ts`, `lib/plan-day-client.ts`, `lib/profile/onboarding-client.ts`, `lib/recipes-client.ts`, `lib/sync/client.ts`, `lib/sync/log-entry-ops.ts`, `lib/sync/outbox-membership.ts`, `lib/sync/outbox.ts`, `lib/sync/plan-cache.ts`, `lib/sync/plan-days.ts`, `lib/sync/settings-intents.ts`, `lib/sync/settings.ts`, `lib/targets/client.ts`, `lib/water-client.ts` (the spec lists 24; the grep at `1d5790d` finds these 36 — the spec's count missed the `openSmcDb`/`META_STORE` users) |
| `SyncOp` without an account; wire strip | `lib/sync/types.ts:29-33`; `lib/sync/outbox.ts:127-132` (`wireOp`) |
| Server applies every op to the JWT user | `app/api/sync/ops/route.ts:79,84-93` |
| `SyncOpSchema` (Zod strips unknown keys, so `user_id` is dropped today) | `lib/sync/types.ts:54-62` |
| `requireUser` | `lib/server/auth.ts:22-30` |
| Log commit POST without account | `lib/log-commit-client.ts:274-279` (`fetchWithDeadline("commit", "/api/log/commit", …)`) |
| Delayed settle | `lib/log-commit-settle.ts:101-116` (`rollbackMirror`), `:122` (`settleAccepted`), `:166` (`settleRefused`) |
| Store cache | `lib/store.ts:13` (key), `:128` (`cached`), `:135` (`persistFailed`), `:194-196` (`currentStore`), `:322-325` (`clearFoodProjection`), `:354-357` (`__resetStoreCache`) |
| Module globals | `lib/log-client.ts:89` `refCache`; `lib/sync/plan-day-queue.ts:1` `pendingDates`; `lib/sync/client.ts:248,256` `inFlight`, `runAgain`; `lib/coach/apply-client.ts:33-34` `applying`, `undoing`; `lib/log/live-commits.ts:24,99` `live`, `deletedWhileLive`; `lib/log-note-client.ts:8` `saves`; `lib/health/weigh-in-client.ts:271` `inFlight`; `lib/foods/prefs-client.ts:99,427,435,438` `membershipRevisions`, `inFlight`, `failedIds`, `stateOwner`; `lib/health/capability.ts:15-16` `sessionValue`, `inFlight` |
| Unkeyed user storage | `lib/coach-client.ts:21` `smc:coach:`; `lib/capture/drafts.ts:12` `smc:draft:`; `lib/coach/apply-client.ts:30-31` `smc:coach-action:` + index; `lib/health-client.ts:54` `smc:health_daily`; `lib/estimator-client.ts:17-18` `smc:expenditure`, `smc:proposals`; `lib/barcode/scan-cache.ts:9` `smc:pending_scans`; `lib/store.ts:13` `meal-companion:store:v1`; `lib/log-client.ts:88` `meal-companion:food-refs`; `lib/profile/onboarding-state.ts:19-20` `meal-companion:onboardingInviteDismissedAt` |
| `SyncBootstrap` outside `AuthGate`; starts a pass at mount | `app/layout.tsx:47-49`; `components/SyncBootstrap.tsx:26-95` (`run()` at `:58`) |
| `AuthGate` session handling | `components/AuthGate.tsx:254-261` (`forget`), `:273-319` (`applySession`), `:227-232` (`acknowledgeEatenDates`), `:350` (Sign out) |
| Sync status card | `components/SyncStatus.tsx:96-102` (`loadSyncStatus`) |
| Shell caches | `public/sw.js:22-23` (`CACHE_VERSION`, `sasha-shell-${CACHE_VERSION}`) |
| Legacy eaten-migration marker | `lib/sync/plan-days.ts:11` (`grandfathered_eaten:`), `:14-33` |

## File structure

Create:
- `lib/device/account.ts` — binding, epoch, handle, errors, `accountKey`, `accountFetch`, ready/gone listeners. One responsibility: "which account is this phone acting for now".
- `lib/device/account-storage.ts` — `readAccountItem`, `writeAccountItem`, `removeAccountItem`, `listAccountKeys` over `localStorage`, all taking a handle; `DEVICE_KEYS` allow-list.
- `lib/device/purge.ts` — `purgeAccountMemory()` and `PURGED_STATE` (the list the scan test checks).
- `lib/device/legacy-adoption.ts` — `adoptLegacyDevice(handle)`, `legacyHeldCount()`.
- `lib/device/forget.ts` — `forgetAccount(previous)`: delete re-fetchable caches and SW shell caches; keep every account DB and its `store`, drafts and scans; the device registry; `pendingWork` for the sign-out notice.
- `lib/sync/account-sync.ts` — `startAccountSync(handle)`: the old `SyncBootstrap` effect body, per handle.
- Tests: `tests/device/account.test.ts`, `tests/device/account-storage.test.ts`, `tests/device/storage-keys.test.ts`, `tests/device/module-state.test.ts`, `tests/device/account-fetch.test.ts`, `tests/device/legacy-adoption.test.ts`, `tests/device/forget.test.ts`, `tests/sync/account-isolation.test.ts`, `tests/sync/account-sync.test.ts`, `tests/sync/ops-route-account.test.ts`, `tests/log/commit-account-mismatch.test.ts`.

Modify: every file in the "Current code" table.

## Interfaces (produced by this slice; later slices use them)

```ts
// lib/device/account.ts
export type AccountHandle = Readonly<{ userId: string; epoch: number }>;
export class AccountNotBound extends Error {}
export class AccountChanged extends Error {}
export function bindAccount(userId: string): AccountHandle;          // same id → same handle, no epoch change
export function unbindAccount(): AccountHandle | null;               // returns the previous handle
export function markAccountReady(h: AccountHandle): void;            // after adoption; fires onAccountReady
export function accountHandle(): AccountHandle;                      // throws AccountNotBound
export function currentAccountOrNull(): AccountHandle | null;
export function isCurrent(h: AccountHandle): boolean;
export function assertCurrent(h: AccountHandle): void;               // throws AccountChanged
export function onAccountReady(fn: (h: AccountHandle) => void): () => void; // fires at once if ready
export function onAccountGone(fn: (h: AccountHandle) => void): () => void;
export function accountKey(h: AccountHandle, name: string): string;  // "smc:u:<id>:<name>"
export const ACCOUNT_HEADER = "x-smc-account";
export function accountFetch(
  h: AccountHandle, input: string, init?: RequestInit,
  opts?: { budget?: Budget; fetchImpl?: typeof fetch },
): Promise<Response>;

// lib/sync/idb.ts
export function accountDbName(userId: string): string;               // "smc-u-<userId>"
export function openAccountDb(h: AccountHandle): Promise<IDBPDatabase>;
export function closeAccountDb(userId: string): Promise<void>;
export function closeAllAccountDbs(): Promise<void>;
export type OwnedOp = SyncOp & { user_id: string };
export type OutboxOp = OwnedOp & { seq: number; attempts: number; error_attempts: number; queued_at: string; next_attempt_at: number; intents?: …; generation?: number };
// every primitive: (h: AccountHandle, …old params)

// lib/sync/client.ts
export function syncOnce(h: AccountHandle, options?: SyncOptions): Promise<{ pull: PullResult; push: DrainResult }>;
export function pullChanges(h: AccountHandle, since?: number, options?: SyncOptions): Promise<PullResult>;
export function pushOutbox(h: AccountHandle, options?: SyncOptions): Promise<DrainResult>;
export function flushOutboxNow(h: AccountHandle, options?: SyncOptions): Promise<boolean>;
```

---

### Task 1: The account binding (`lib/device/account.ts`)

**Files:**
- Create: `lib/device/account.ts`
- Test: `tests/device/account.test.ts`

**Interfaces:** Produces everything in the `lib/device/account.ts` block above except `accountFetch` (Task 7).

- [ ] **Step 1: Write the failing test**

```ts
// tests/device/account.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountChanged, AccountNotBound, accountHandle, accountKey, assertCurrent, bindAccount,
  currentAccountOrNull, isCurrent, markAccountReady, onAccountGone, onAccountReady, unbindAccount,
} from "@/lib/device/account";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => { unbindAccount(); });

describe("account binding", () => {
  it("throws AccountNotBound when nothing is bound", () => {
    expect(() => accountHandle()).toThrow(AccountNotBound);
    expect(currentAccountOrNull()).toBeNull();
  });

  it("gives the bound user id and a fresh epoch", () => {
    const h = bindAccount(A);
    expect(accountHandle()).toEqual(h);
    expect(h.userId).toBe(A);
  });

  it("keeps the same handle when the same user binds again (token refresh)", () => {
    const h1 = bindAccount(A);
    const h2 = bindAccount(A);
    expect(h2).toEqual(h1);
    expect(() => assertCurrent(h1)).not.toThrow();
  });

  it("makes an old handle stale after a switch, even back to the same user", () => {
    const a1 = bindAccount(A);
    bindAccount(B);
    expect(() => assertCurrent(a1)).toThrow(AccountChanged);
    unbindAccount();
    const a2 = bindAccount(A);
    expect(isCurrent(a1)).toBe(false);
    expect(isCurrent(a2)).toBe(true);
  });

  it("fires ready only after markAccountReady, and at once for a late subscriber", () => {
    const early = vi.fn();
    const stop = onAccountReady(early);
    const h = bindAccount(A);
    expect(early).not.toHaveBeenCalled();
    markAccountReady(h);
    expect(early).toHaveBeenCalledWith(h);
    const late = vi.fn();
    onAccountReady(late);
    expect(late).toHaveBeenCalledWith(h);
    stop();
  });

  it("refuses markAccountReady with a stale handle", () => {
    const a = bindAccount(A);
    bindAccount(B);
    expect(() => markAccountReady(a)).toThrow(AccountChanged);
  });

  it("fires gone with the previous handle on unbind and on switch", () => {
    const gone = vi.fn();
    onAccountGone(gone);
    const a = bindAccount(A);
    bindAccount(B);
    expect(gone).toHaveBeenCalledWith(a);
  });

  it("builds account-scoped storage keys", () => {
    const h = bindAccount(A);
    expect(accountKey(h, "coach:t1")).toBe(`smc:u:${A}:coach:t1`);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/device/account.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/device/account"`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// lib/device/account.ts
/**
 * Which account this phone acts for now (spec Phase 9 §0.1). Every device primitive takes the
 * handle this module gives out and calls `assertCurrent` before it writes, so work that started
 * as one account cannot settle under another.
 */
export type AccountHandle = Readonly<{ userId: string; epoch: number }>;

export class AccountNotBound extends Error {
  constructor() { super("No account is bound on this device."); this.name = "AccountNotBound"; }
}
export class AccountChanged extends Error {
  constructor() { super("The account changed while this work was running."); this.name = "AccountChanged"; }
}

let epoch = 0;
let bound: string | null = null;
let ready = false;
const readyListeners = new Set<(h: AccountHandle) => void>();
const goneListeners = new Set<(h: AccountHandle) => void>();

function snapshot(): AccountHandle | null {
  return bound === null ? null : { userId: bound, epoch };
}

export function unbindAccount(): AccountHandle | null {
  const previous = snapshot();
  epoch += 1;
  bound = null;
  ready = false;
  if (previous) for (const fn of goneListeners) fn(previous);
  return previous;
}

export function bindAccount(userId: string): AccountHandle {
  if (bound === userId) return { userId, epoch };
  if (bound !== null) unbindAccount();
  epoch += 1;
  bound = userId;
  ready = false;
  return { userId, epoch };
}

export function currentAccountOrNull(): AccountHandle | null { return snapshot(); }

export function accountHandle(): AccountHandle {
  const h = snapshot();
  if (!h) throw new AccountNotBound();
  return h;
}

export function isCurrent(h: AccountHandle): boolean {
  return h.epoch === epoch && h.userId === bound;
}

export function assertCurrent(h: AccountHandle): void {
  if (!isCurrent(h)) throw new AccountChanged();
}

export function markAccountReady(h: AccountHandle): void {
  assertCurrent(h);
  ready = true;
  for (const fn of readyListeners) fn(h);
}

export function onAccountReady(fn: (h: AccountHandle) => void): () => void {
  readyListeners.add(fn);
  const h = snapshot();
  if (ready && h) fn(h);
  return () => { readyListeners.delete(fn); };
}

export function onAccountGone(fn: (h: AccountHandle) => void): () => void {
  goneListeners.add(fn);
  return () => { goneListeners.delete(fn); };
}

export const ACCOUNT_KEY_PREFIX = "smc:u:";
export function accountKey(h: AccountHandle, name: string): string {
  return `${ACCOUNT_KEY_PREFIX}${h.userId}:${name}`;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run tests/device/account.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/device/account.ts tests/device/account.test.ts
git commit -m "fix: add account handle and epoch for device state"
```

---

### Task 2: Per-account IndexedDB with handle-checked primitives (`lib/sync/idb.ts`)

**Files:**
- Modify: `lib/sync/idb.ts:12-289` (whole module)
- Modify: `lib/sync/types.ts:29-33` (no change to `SyncOp`; `OwnedOp` lives in `idb.ts`)
- Test: `lib/sync/idb.test.ts` (update every call to pass a handle), `tests/sync/idb.test.ts` (same), new cases in `lib/sync/idb.test.ts`

**Interfaces:**
- Consumes: `AccountHandle`, `assertCurrent`, `bindAccount`, `unbindAccount` (Task 1).
- Produces: the `lib/sync/idb.ts` block above. Every primitive's first parameter is `h: AccountHandle`: `putRow(h, entity, key, row)`, `getRow(h, entity, key)`, `deleteRow(h, entity, key)`, `allRows(h, entity)`, `appendOp(h, op, now?)`, `appendOpWithRow(h, row, op, now?)`, `mutateRowWithOp(h, entity, key, mutate, now?)`, `putOp(h, op)`, `allOps(h)`, `deleteOp(h, opId)`, `countOps(h)`, `getCursor(h)`, `setCursor(h, seq)`, `getLastSyncAt(h)`, `setLastSyncAt(h, iso)`, `getLastError(h)`, `setLastError(h, message)`, plus two new meta helpers `getMeta(h, key)` / `putMeta(h, key, value)` / `deleteMeta(h, key)` that replace every direct `openSmcDb()` + `META_STORE` user.

- [ ] **Step 1: Write the failing tests** (add to `lib/sync/idb.test.ts`; change `beforeEach` to bind)

```ts
import { bindAccount, unbindAccount, AccountChanged } from "@/lib/device/account";
import { accountDbName, closeAllAccountDbs, openAccountDb, putRow, getRow, appendOp, allOps,
  setCursor, getCursor, DB_VERSION } from "./idb";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(async () => {
  await closeAllAccountDbs();
  unbindAccount();
  globalThis.indexedDB = new IDBFactory();
});

describe("per-account database", () => {
  it("opens smc-u-<userId> at version 1 with every store", async () => {
    const h = bindAccount(A);
    const db = await openAccountDb(h);
    expect([db.name, db.version]).toEqual([accountDbName(A), 1]);
    expect(DB_VERSION).toBe(1);
    for (const s of [...ENTITIES, "outbox", "meta", "catalog_revisions"]) {
      expect([...db.objectStoreNames]).toContain(s);
    }
  });

  it("keeps A's rows out of B's database", async () => {
    const a = bindAccount(A);
    await putRow(a, "water_log", "2026-09-11", { local_date: "2026-09-11", cups: 4, user_id: A });
    const b = bindAccount(B);
    await expect(getRow(b, "water_log", "2026-09-11")).resolves.toBeUndefined();
  });

  it("refuses a write with a stale handle and writes nothing", async () => {
    const a = bindAccount(A);
    bindAccount(B);
    await expect(putRow(a, "water_log", "d", { cups: 1 })).rejects.toBeInstanceOf(AccountChanged);
    const a2 = (unbindAccount(), bindAccount(A));
    await expect(getRow(a2, "water_log", "d")).resolves.toBeUndefined();
  });

  it("refuses a read with a stale handle", async () => {
    const a = bindAccount(A);
    bindAccount(B);
    await expect(getCursor(a)).rejects.toBeInstanceOf(AccountChanged);
  });

  it("drops a read that was pending when the account changed (audit plan r2 finding 7)", async () => {
    const a = bindAccount(A);
    await putRow(a, "water_log", "d", { local_date: "d", cups: 3, user_id: A });
    await openAccountDb(a);                           // DB open, so only the read is pending below
    const pendingRow = getRow(a, "water_log", "d");   // IDB request in flight
    const pendingAll = allRows(a, "water_log");
    const pendingMeta = getMeta(a, "cursor");
    bindAccount(B);                                   // switch while the requests are pending
    await expect(pendingRow).rejects.toBeInstanceOf(AccountChanged);
    await expect(pendingAll).rejects.toBeInstanceOf(AccountChanged);
    await expect(pendingMeta).rejects.toBeInstanceOf(AccountChanged);
  });

  it("stamps user_id on every appended op", async () => {
    const h = bindAccount(A);
    await appendOp(h, op("o1"));
    expect((await allOps(h))[0]).toMatchObject({ op_id: "o1", user_id: A });
  });

  it("does not save a cursor for a handle that went stale mid-pass", async () => {
    const a = bindAccount(A);
    await setCursor(a, 5);
    bindAccount(B);
    await expect(setCursor(a, 9)).rejects.toBeInstanceOf(AccountChanged);
    unbindAccount();
    await expect(getCursor(bindAccount(A))).resolves.toBe(5);
  });

  it("does not cache a failed open", async () => {
    const h = bindAccount(A);
    const real = globalThis.indexedDB;
    globalThis.indexedDB = { open: () => { throw new Error("blocked"); } } as unknown as IDBFactory;
    await expect(openAccountDb(h)).rejects.toThrow("blocked");
    globalThis.indexedDB = real;
    await expect(openAccountDb(h)).resolves.toBeTruthy();
  });
});
```

Update every existing test in `lib/sync/idb.test.ts` and `tests/sync/idb.test.ts` to call `const h = bindAccount(A)` and pass `h` first. The old "is version 1 … `DB_NAME`" test is replaced by the first test above.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run lib/sync/idb.test.ts tests/sync/idb.test.ts`
Expected: FAIL — `openAccountDb` / `accountDbName` are not exported; type errors on the extra argument.

- [ ] **Step 3: Implement**

Replace the top of `lib/sync/idb.ts` (lines 12–86) with:

```ts
import { openDB, type IDBPDatabase } from "idb";
import { assertCurrent, type AccountHandle } from "@/lib/device/account";
import { encodeKey } from "./keys";
import { ENTITIES, type Entity, type SyncOp } from "./types";

/** The pre-Phase-9 shared database. Read only by lib/device/legacy-adoption.ts. */
export const LEGACY_DB_NAME = "smc";
export const ACCOUNT_DB_PREFIX = "smc-u-";
/** v1 of the per-account database: the same upgrade loop, run once from empty. */
export const DB_VERSION = 1;
export const OUTBOX_STORE = "outbox";
export const META_STORE = "meta";
export const CATALOG_STORE = "catalog_revisions";

export function accountDbName(userId: string): string { return `${ACCOUNT_DB_PREFIX}${userId}`; }

/** The stamped op: what an outbox row holds, and what goes on the wire. */
export type OwnedOp = SyncOp & { user_id: string };
export type OutboxOp = OwnedOp & { seq: number; attempts: number; error_attempts: number;
  queued_at: string; next_attempt_at: number;
  intents?: { key: string; value: unknown }[]; generation?: number };

export function upgradeStores(db: IDBPDatabase): void {
  for (const entity of ENTITIES) {
    if (!db.objectStoreNames.contains(entity)) db.createObjectStore(entity);
  }
  if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
    db.createObjectStore(OUTBOX_STORE, { keyPath: "op_id" }).createIndex("by_seq", "seq", { unique: true });
  }
  if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
  if (!db.objectStoreNames.contains(CATALOG_STORE)) {
    db.createObjectStore(CATALOG_STORE, { keyPath: "revision_id" }).createIndex("by_cached_at", "cached_at");
  }
}

const dbs = new Map<string, Promise<IDBPDatabase>>();

/** Keyed by user id. A rejected open is not cached (one failed open must not wedge sync). */
export async function openAccountDb(h: AccountHandle): Promise<IDBPDatabase> {
  assertCurrent(h);
  let p = dbs.get(h.userId);
  if (!p) {
    p = openDB(accountDbName(h.userId), DB_VERSION, { upgrade: upgradeStores })
      .catch((e: unknown) => { dbs.delete(h.userId); throw e; });
    dbs.set(h.userId, p);
  }
  const db = await p;
  assertCurrent(h);
  return db;
}

export async function closeAccountDb(userId: string): Promise<void> {
  const p = dbs.get(userId);
  if (!p) return;
  dbs.delete(userId);
  (await p.catch(() => null))?.close();
}

export async function closeAllAccountDbs(): Promise<void> {
  await Promise.all([...dbs.keys()].map(closeAccountDb));
}

/** The check that matters: after every await, immediately before the request that writes. */
async function write(h: AccountHandle, fn: (db: IDBPDatabase) => Promise<unknown>): Promise<void> {
  const db = await openAccountDb(h);
  assertCurrent(h);
  await fn(db);
}

export async function putRow(h: AccountHandle, entity: Entity, key: string, row: Record<string, unknown>): Promise<void> {
  await write(h, (db) => db.put(entity, row, key));
}
/** Every read checks the handle AFTER the request resolves (audit plan r2 finding 7): a read that
 *  started as A and finishes after B binds returns nothing to its caller. */
async function read<T>(h: AccountHandle, fn: (db: IDBPDatabase) => Promise<unknown>): Promise<T> {
  const value = await fn(await openAccountDb(h));
  assertCurrent(h);
  return value as T;
}
export async function getRow(h: AccountHandle, entity: Entity, key: string): Promise<Record<string, unknown> | undefined> {
  return read(h, (db) => db.get(entity, key));
}
export async function deleteRow(h: AccountHandle, entity: Entity, key: string): Promise<void> {
  await write(h, (db) => db.delete(entity, key));
}
export async function allRows(h: AccountHandle, entity: Entity): Promise<Record<string, unknown>[]> {
  return read(h, (db) => db.getAll(entity));
}
export async function getMeta<T>(h: AccountHandle, key: string): Promise<T | undefined> {
  return read(h, (db) => db.get(META_STORE, key));
}
export async function putMeta(h: AccountHandle, key: string, value: unknown): Promise<void> {
  await write(h, (db) => db.put(META_STORE, value, key));
}
export async function deleteMeta(h: AccountHandle, key: string): Promise<void> {
  await write(h, (db) => db.delete(META_STORE, key));
}
```

Then, in the rest of the file:
- `outboxRow(op, seq, now)` becomes `outboxRow(h, op, seq, now)` and returns `{ ...op, user_id: h.userId, seq, … }`.
- `appendOp(h, op, now)`, `appendOpWithRow(h, row, op, now)` and `writeOp(h, op, mirror, now)`: `const db = await openAccountDb(h);` then, after `await outbox.get(op.op_id)` and before the first `put`, call `assertCurrent(h)` (the transaction is still open; a throw aborts it: wrap in the same `try { … } catch { tx.abort(); … throw }` pattern as `mutateRowWithOp`).
- `mutateRowWithOp(h, entity, key, mutate, now)`: add `assertCurrent(h);` on the line after `await mutate(current, { ops, meta })` (today line 218) and before any `put`.
- `putOp`, `deleteOp`, `setCursor`, `setLastSyncAt`, `setLastError`: use `write(h, …)`. `allOps`, `countOps`, `getCursor`, `getLastSyncAt`, `getLastError`: use `read(h, …)`.
- **Raw-handle callers** (code that calls `openAccountDb(h)` and runs its own transaction:
  `lib/sync/plan-cache.ts`, `lib/sync/plan-days.ts`, `lib/targets/client.ts`,
  `lib/foods/adopt-client.ts`, `lib/db/catalog-cache.ts`, `writeOp`, `mutateRowWithOp`): call
  `assertCurrent(h)` after **every** awaited request and before the value is used or returned.
  Guard test `tests/device/raw-db-reads.test.ts`: every client file (outside `lib/sync/idb.ts`) that
  contains `openAccountDb(` also contains `assertCurrent(`; and a behavior test that starts
  `restoreCachedPlanDays(a)`, switches to B while its first read is pending, and asserts it resolves
  to 0 and writes nothing to the store.
- Delete `DB_NAME`, `dbPromise`, `openSmcDb`, `closeSmcDb`. Keep `OUTBOX_SEQ_KEY` exported.

- [ ] **Step 4: Run and see them pass**

Run: `pnpm exec vitest run lib/sync/idb.test.ts tests/sync/idb.test.ts`
Expected: PASS. `tsc` still fails in the callers; Task 3 fixes them. Do not commit a red `tsc`: continue to Task 3 and commit Tasks 2 and 3 together.

---

### Task 3: Every caller passes the handle it started with

**Files (modify; TypeScript lists them all after Task 2):** the 36 importers in the "Current code" table.

**Rule for every caller** (write it once, apply it everywhere):
1. A public entry point that the UI calls (a click, a sheet save, an effect) takes the handle once
   at its top: `const h = accountHandle();` and passes `h` down. It never calls `accountHandle()`
   again after an `await`.
2. A function that runs after an `await` of network or user time (settle, reconcile, retry,
   rollback, drain) takes `h` as a parameter from its caller. It never calls `accountHandle()`.
3. A caught `AccountChanged` is not an error to show: the work ends quietly
   (`if (e instanceof AccountChanged) return <the no-op result>;`). Every other error keeps its
   current handling.
4. Replace every `openSmcDb()` + `META_STORE` get/put with `getMeta(h, key)` / `putMeta(h, key, v)`;
   replace other `openSmcDb()` uses with `openAccountDb(h)`.

**Specific call sites** (verified lines):

| File | Change |
|---|---|
| `lib/log-commit-client.ts:177` `commitLogEntry(req, opts)` | take `const h = accountHandle()` before `joinCommit`; pass `h` to `postCommit(h, req, opts)`, `recordFirst`, `writeLocalFirst`, `safeQueue`, every settle call |
| `lib/log-commit-settle.ts:101,122,166,246,259,272,289,356` | add `h: AccountHandle` as the first parameter of `rollbackMirror`, `settleAccepted`, `settleRefused`, `dropCommitOp`, `ownWriteQueued`, `dropQueuedOps`, `hasQueuedOp`, `reconcileMirror`; `rollbackMirror` keeps its `catch` but rethrows nothing: an `AccountChanged` returns `false` with no warning |
| `lib/log/reconcile.ts`, `lib/log/retry-unsaved.ts`, `lib/log/delete-entry.ts`, `lib/log/today-state.ts`, `lib/log/pending.ts:100,115` | handle parameter; `pending.ts` uses `getMeta/putMeta` |
| `lib/water-client.ts:39-60` `addCups` | `const h = accountHandle()` at the top; `getRow(h, …)`, `putRow(h, …)`, `enqueue(h, …)`, `setLastError(h, …)`; in `catch`, `if (e instanceof AccountChanged) throw e;` before `setLastError` (never write an error into the new account) |
| `lib/sync/outbox.ts:70,82,103,110,213,283,353` | `enqueue(h, op)`, `enqueueWithRow(h, row, op)`, `mutateUserSettings(h, …)`, `pendingCount(h)`, `retryParked(h)`, `applyResult(h, …)`, `drainOutbox(h, push, now)` |
| `lib/sync/client.ts:106,196,230,259` | Task 6 |
| `lib/sync/plan-cache.ts:9-12` | `restoreCachedPlanDays(h, isCurrent?)` — drop the `userId` parameter; the row check becomes `row?.user_id === h.userId`; `isCurrent` default is `() => isCurrent(h)` |
| `lib/sync/plan-days.ts:14-33,51` | `:14-33` is removed in Task 9 (rule 9); `:51` `applyPlanDay` takes `h` |
| `lib/targets/client.ts:142-169`, `lib/health/weigh-in-client.ts:102-112`, `lib/favorites-client.ts:28-33`, `lib/foods/adopt-client.ts:69-83`, `lib/db/catalog-cache.ts:41-77` | `getMeta/putMeta` or `openAccountDb(h)`; entry points take `accountHandle()` |
| `components/AuthGate.tsx:227-232` `acknowledgeEatenDates` | removed in Task 9 (rule 9) |
| `components/LoggedExtras.tsx`, `components/add-food/catalog-food.ts` | take `accountHandle()` in the event handler, not at render |

**Test for the rule** (the mid-`await` switch; add to `tests/sync/account-isolation.test.ts`, created here):

```ts
// tests/sync/account-isolation.test.ts
// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount, AccountChanged } from "@/lib/device/account";

/** The read-to-write interval is controlled, not guessed: `getRow` waits for `gate` after it has
 *  read, so the test switches exactly between the read and the write. */
const control = vi.hoisted(() => ({ gate: null as Promise<void> | null, readDone: null as (() => void) | null }));
vi.mock("@/lib/sync/idb", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/sync/idb")>();
  return { ...real, getRow: async (...args: Parameters<typeof real.getRow>) => {
    const row = await real.getRow(...args);
    control.readDone?.();
    if (control.gate) await control.gate;
    return row;
  } };
});
const { closeAllAccountDbs, getRow, allOps, putRow } = await import("@/lib/sync/idb");
const { addCups } = await import("@/lib/water-client");

export const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(async () => {
  control.gate = null; control.readDone = null;
  await closeAllAccountDbs();
  unbindAccount();
  globalThis.indexedDB = new IDBFactory();
});

describe("a write that spans a switch", () => {
  it("writes nothing when the account changes between its read and its write", async () => {
    const a = bindAccount(A);
    await putRow(a, "water_log", "2026-09-22", { local_date: "2026-09-22", cups: 2, rev: 1, user_id: A });
    let release!: () => void;
    control.gate = new Promise<void>((r) => { release = r; });
    const read = new Promise<void>((r) => { control.readDone = r; });
    const pending = addCups("2026-09-22", 1);
    await read;                                   // A's row has been read
    bindAccount(B);                               // switch before the write
    release();
    await expect(pending).rejects.toBeInstanceOf(AccountChanged);
    control.gate = null;
    expect(await allOps(bindAccount(B))).toEqual([]);
    unbindAccount();
    const a2 = bindAccount(A);
    expect(await getRow(a2, "water_log", "2026-09-22")).toMatchObject({ cups: 2, rev: 1 });
    expect(await allOps(a2)).toEqual([]);
  });
});
```

- [ ] **Step 1: Write the test above.** Run: `pnpm exec vitest run tests/sync/account-isolation.test.ts` — Expected: FAIL (type error: `addCups` still calls the old primitives, or the write lands).
- [ ] **Step 2: Apply the rule, file by file, until `pnpm exec tsc --noEmit` reports zero errors.** Work in this order so each group compiles before the next: `lib/sync/*` → `lib/log*` and `lib/log/*` → the remaining `lib/*` → `components/*`.
- [ ] **Step 3: Update the existing tests that call the changed functions.** Every test that mocks `@/lib/sync/idb` (for example `components/AuthGate.test.tsx:39` `vi.mock("@/lib/sync/idb", () => ({ allOps: … }))`) keeps its mock; every test that uses the real module binds an account in `beforeEach` (`bindAccount(A)`) and passes the handle. Replace `closeSmcDb()` with `closeAllAccountDbs()` and add `unbindAccount()` in `beforeEach` (`lib/catalog-client.test.ts:263,304`, `lib/log-client.test.ts:34`, `lib/db/catalog-cache.test.ts:18`, `lib/sync/*.test.ts`).
- [ ] **Step 4: Run the targeted tests.**

Run:
```bash
pnpm exec tsc --noEmit
pnpm exec vitest run tests/sync/account-isolation.test.ts lib/sync tests/sync/idb.test.ts \
  lib/log-client.test.ts lib/log-note-client.test.ts lib/catalog-client.test.ts lib/db \
  tests/log/commit.test.ts tests/water components/AuthGate.test.tsx tests/onboarding/auth-gate.test.tsx
```
Expected: `tsc` clean; all PASS.

- [ ] **Step 5: Commit (Tasks 2 and 3 together)**

```bash
git add lib components tests
git commit -m "fix: per-account IndexedDB; every primitive takes the account handle"
```

---

### Task 4: Account-keyed storage and the store cache

**Files:**
- Create: `lib/device/account-storage.ts`
- Modify: `lib/store.ts:13,128-196,322-357`; `lib/coach-client.ts:21,79-110`; `lib/capture/drafts.ts:12-30`; `lib/coach/apply-client.ts:30-82`; `lib/health-client.ts:54,72-84`; `lib/estimator-client.ts:17-18,42-97`; `lib/barcode/scan-cache.ts:9,30-40`; `lib/log-client.ts:88-97`; `lib/profile/onboarding-state.ts:19-20,150-170`
- Test: `tests/device/account-storage.test.ts`, `tests/device/storage-keys.test.ts`

**Interfaces:**
- Consumes: `AccountHandle`, `accountKey`, `currentAccountOrNull` (Task 1).
- Produces:
```ts
// lib/device/account-storage.ts
export function readAccountItem(h: AccountHandle, name: string): string | null;
export function writeAccountItem(h: AccountHandle, name: string, value: string): void; // asserts h
export function removeAccountItem(h: AccountHandle, name: string): void;
export function listAccountKeys(userId: string): string[];      // every "smc:u:<id>:*" key
export const DEVICE_KEYS: readonly string[];                    // device-level allow-list
export const LEGACY_PREFIX = "smc:legacy:";
// lib/store.ts
export function resetStoreCache(): void;                        // clears cached + persistFailed
```

Names under `accountKey` (the old literal → the new `name`): `smc:coach:<t>` → `coach:<t>`;
`smc:draft:<id>` → `draft:<id>`; `smc:coach-action:<id>` → `coach-action:<id>` and the index →
`coach-action:index`; `smc:health_daily` → `health_daily`; `smc:expenditure` → `expenditure`;
`smc:proposals` → `proposals`; `smc:pending_scans` → `pending_scans`;
`meal-companion:store:v1` → `store`; `meal-companion:food-refs` → `food-refs`;
`meal-companion:onboardingInviteDismissedAt` → `onboarding-invite-dismissed-at`.

`DEVICE_KEYS` (device-level, not account data): `smc:body_capability`
(`lib/health/capability.ts:13`), `meal-companion:install-prompt-dismissed`
(`components/InstallPrompt.tsx:5`), `smc:device:accounts` (new, Task 10). Already per-account by
user id and left as they are: `meal-companion:onboarding-disposition:<id>`
(`components/AuthGate.tsx:66`), `smc:coach:current:<id>` (`app/coach/CoachScreen.tsx:17`),
`meal-companion:food-pref-refs` (`lib/foods/prefs-client.ts:54`, owner inside the value).
`sessionStorage` `smc:coach:return` (`components/CoachFab.tsx:5`) is device-level. Window event
names (`meal-companion:synced`, `:outbox-queued`, `:targets-changed`, `:log-queued`,
`:body-profile-changed`) are not storage.

**`lib/store.ts` rule (plan decision P2):** `STORAGE_KEY` is gone. `loadStore()` and `saveStore()`
read `currentAccountOrNull()`. No account → in-memory default only, never persisted. Account →
`smc:u:<id>:store`. The cache remembers which user id it holds (`cachedFor`); a read for a
different id reloads. `resetStoreCache()` clears `cached`, `cachedFor` and `persistFailed`.
`__resetStoreCache` becomes an alias of `resetStoreCache` (tests keep working).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/device/account-storage.test.ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { bindAccount, unbindAccount, AccountChanged } from "@/lib/device/account";
import { listAccountKeys, readAccountItem, writeAccountItem } from "@/lib/device/account-storage";
import { loadStore, saveStore, resetStoreCache, defaultStore } from "@/lib/store";
import { vi } from "vitest";
import { writeCache, readCache } from "@/lib/coach-client";
import { fetchDaily } from "@/lib/health-client";
import { fetchExpenditure } from "@/lib/estimator-client";
import { saveStoreFor } from "@/lib/store";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => { localStorage.clear(); unbindAccount(); resetStoreCache(); });

describe("account storage", () => {
  it("namespaces values by account", () => {
    const a = bindAccount(A);
    writeAccountItem(a, "expenditure", "1");
    const b = bindAccount(B);
    expect(readAccountItem(b, "expenditure")).toBeNull();
    expect(listAccountKeys(A)).toEqual([`smc:u:${A}:expenditure`]);
  });

  it("refuses a write with a stale handle", () => {
    const a = bindAccount(A);
    bindAccount(B);
    expect(() => writeAccountItem(a, "x", "1")).toThrow(AccountChanged);
  });

  it("keeps A's coach transcript out of B's reads", () => {
    const a = bindAccount(A);
    writeCache(a, "t1", { messages: [{ role: "user", text: "A secret" } as never], actions: [] });
    const b = bindAccount(B);
    expect(readCache(b, "t1").messages).toEqual([]);
  });

  it("an A health response that arrives after B binds is not cached for B and not returned", async () => {
    let answer!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
    const a = bindAccount(A);
    const pending = fetchDaily(a, "2026-09-20", "2026-09-22", { fetchImpl: fetchImpl as never });
    const b = bindAccount(B);
    answer(new Response(JSON.stringify({ days: [{ date: "2026-09-22", steps: 1234 }] }), { status: 200 }));
    await expect(pending).rejects.toBeInstanceOf(AccountChanged);
    expect(readAccountItem(b, "health_daily")).toBeNull();
    expect(readAccountItem(a, "health_daily")).toBeNull();   // stale handle: nothing written for A either
  });

  it("an A expenditure response that arrives after B binds is not cached for B", async () => {
    let answer!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
    const a = bindAccount(A);
    const pending = fetchExpenditure(a, fetchImpl as never);
    const b = bindAccount(B);
    answer(new Response(JSON.stringify({ value: 2100 }), { status: 200 }));
    await expect(pending).rejects.toBeInstanceOf(AccountChanged);
    expect(readAccountItem(b, "expenditure")).toBeNull();
  });

  it("a store save with a stale handle writes nothing", () => {
    const a = bindAccount(A);
    bindAccount(B);
    expect(() => saveStoreFor(a, defaultStore())).toThrow(AccountChanged);
    expect(localStorage.getItem(`smc:u:${B}:store`)).toBeNull();
  });

  it("serves B a fresh store, not A's cache", () => {
    bindAccount(A);
    saveStore({ ...defaultStore(), days: { "2026-09-22": { eaten: { "meal-1": "x" } } } as never });
    bindAccount(B);
    resetStoreCache();
    expect(loadStore().days).toEqual({});
    expect(localStorage.getItem(`smc:u:${A}:store`)).not.toBeNull();
  });

  it("does not persist a store with no bound account", () => {
    saveStore(defaultStore());
    expect(Object.keys(localStorage)).toEqual([]);
  });
});
```

**Rule for responses (audit plan r1 finding 2).** No storage helper reads "the account bound
now". Every read and write helper takes the handle of the work that started it:
`writeCache(h, threadId, …)`, `readCache(h, threadId)` (`lib/coach-client.ts:79-110`),
`writeCachedDaily(h, …)` / `readCachedDaily(h)` and `fetchDaily(h, from, to, opts?: { fetchImpl?: typeof fetch })`
(`lib/health-client.ts:70-109`; today the cache write follows `await res.json()` at `:102-103`),
`fetchCached(h, key, url, fetchFn)` / `fetchExpenditure(h, …)` / `fetchProposals(h, …)`
(`lib/estimator-client.ts:40-85`; today the write follows `await res.json()` at `:68-69`),
the drafts, scan-cache, coach-action and food-ref helpers. After every `await` that precedes a
cache write or a returned value, the function calls `assertCurrent(h)`. Every existing
`catch { … read the cache … }` fallback rethrows `AccountChanged` first
(`if (e instanceof AccountChanged) throw e;`), so it never answers with the new account's cache
for the old account's request. The React caller that started the work drops the result on
`AccountChanged` (it is unmounted or re-keyed by the account change anyway).

`lib/store.ts` gets `saveStoreFor(h, store)` (asserts `h`, then writes `smc:u:<h.userId>:store`).
Every `saveStore` call that runs after an `await` moves to `saveStoreFor(h, …)` with the
initiating handle: `lib/sync/client.ts:67,84` (pulled settings and target profile mirrors),
`lib/sync/plan-cache.ts`, `lib/sync/plan-days.ts` (pulled plan day projection),
`lib/store.ts:314-325` (`replaceFoodsFromSync(h, …)`). A synchronous save from a click handler
may keep `saveStore(store)` (it reads the bound account in the same turn as the click). Find the
async callers with `grep -rn "saveStore(" lib components app` and check each for a preceding
`await` in the same function.

```ts
// tests/device/storage-keys.test.ts
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CLIENT_GLOBS = ["lib/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "app/**/*.{ts,tsx}"];
const SERVER_ONLY = /^(lib\/server|lib\/mcp|lib\/ai|app\/api)\//;
const ALLOWED = new Set([
  "smc:body_capability", "meal-companion:install-prompt-dismissed", "smc:device:accounts",
  "smc:coach:return", "smc:u:", "smc:legacy:", "smc-u-",
  "meal-companion:onboarding-disposition:", "smc:coach:current:", "meal-companion:food-pref-refs",
  "meal-companion:synced", "meal-companion:outbox-queued", "meal-companion:targets-changed",
  "meal-companion:log-queued", "meal-companion:body-profile-changed",
]);
const LITERAL = /["'`]((?:smc|meal-companion)[:-][A-Za-z0-9_:.-]*)/g;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("every storage key is account-scoped or device-level", () => {
  it("has no unscoped smc:/meal-companion: literal in client code", () => {
    const offenders: string[] = [];
    for (const file of CLIENT_GLOBS.flatMap((g) => globSync(g))) {
      if (SERVER_ONLY.test(file) || /\.test\.tsx?$/.test(file)) continue;
      if (file === "lib/device/legacy-adoption.ts") continue; // reads the old keys once, by design
      for (const m of stripComments(readFileSync(file, "utf8")).matchAll(LITERAL)) {
        const lit = m[1];
        if (![...ALLOWED].some((a) => lit === a || lit.startsWith(a))) offenders.push(`${file}: ${lit}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

(`fs.globSync` exists in Node 22+; check `.node-version`. If it is older, use `fast-glob`-free
`readdirSync(dir, { recursive: true })` and filter by extension.)

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run tests/device/account-storage.test.ts tests/device/storage-keys.test.ts`
Expected: FAIL — module missing; the scan lists the ten unscoped literals above.

- [ ] **Step 3: Implement** `lib/device/account-storage.ts` (every function wraps `localStorage` in `try/catch`, as `lib/store.ts:178-186` does; `writeAccountItem` calls `assertCurrent(h)` first and lets `AccountChanged` through), then move each file in the Files list to it with the name map above, and apply the `lib/store.ts` rule.
- [ ] **Step 4: Run and see them pass** — same command, plus `pnpm exec vitest run lib/store.test.ts tests/coach tests/capture tests/barcode tests/expenditure tests/health`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add lib components app tests
git commit -m "fix: account-scoped storage keys and store cache"
```

---

### Task 5: Module memory purge and the scan test

**Files:**
- Create: `lib/device/purge.ts`
- Modify (add one exported reset function each): `lib/log-client.ts:89` → `resetFoodRefCache()`; `lib/sync/plan-day-queue.ts:1` → `resetPlanDayQueue()`; `lib/sync/client.ts:248,256` → `resetSyncPasses()` (Task 6 replaces the globals with a per-handle map); `lib/coach/apply-client.ts:33-34` → `resetApplyState()`; `lib/log/live-commits.ts:24,99` → `resetLiveCommits()`; `lib/log-note-client.ts:8` → `resetNoteSaves()`; `lib/health/weigh-in-client.ts:271` → `resetWeighInDrains()`; `lib/foods/prefs-client.ts:99,427,435,438` → `resetPrefsState()`; `lib/health/capability.ts:15-16` → `resetCapabilityCache()`; `lib/store.ts` → `resetStoreCache()` (Task 4)
- Test: `tests/device/module-state.test.ts`, `tests/device/purge.test.ts`

**Interfaces:**
```ts
// lib/device/purge.ts
export const PURGED_STATE: readonly string[]; // "file:name" of every account-bearing module global
export function purgeAccountMemory(): void;   // calls every reset above; awaits nothing
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/device/module-state.test.ts
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PURGED_STATE } from "@/lib/device/purge";

/** Account-free module state: constants, timing marks, cross-tab lock chains, device counters.
 *  A new `let` or top-level Map/Set in client code must be added here WITH a reason, or to
 *  PURGED_STATE with a reset. */
const ACCOUNT_FREE = new Set([
  "lib/capture/quantity.ts:VAGUE", "lib/capture/presentation.ts:CAPTURE_METHOD_SET",
  "lib/nutrients/codes.ts:CODE_SET", "lib/reference.ts:RETIRED_ALLERGEN_KEYS",
  "lib/health/normalize.ts:HAE_ADDITIVE_TYPES", "lib/food-db.ts:BY_ID", "lib/units.ts:BY_ID",
  "lib/units.ts:BY_NAME", "lib/search/gtin.ts:GTIN_LENGTHS", "lib/coach/compose.ts:STOP_WORDS",
  "lib/health-client.ts:APPLE_SOURCE_KINDS", "lib/log-commit-client.ts:RETRY_STATUSES",
  "lib/log/reconcile.ts:LOGGED_SLOTS", "lib/log/grams.ts:UNIT_SET",
  "lib/log/read-result.ts:REFUSAL_STATUSES", "lib/foods/facets.ts:FACET_SET",
  "lib/sync/settings-intents.ts:SERVER_OWNED", "lib/sync/keys.ts:ID_KEYED",
  "lib/sync/keys.ts:DATE_KEYED", "lib/sync/keys.ts:REF_KEYED", "lib/sync/client.ts:SYNCED",
  "lib/media/validate.ts:SOF", "components/coach/blocks/log_draft.tsx:VALID_SLOTS",
  "components/Onboarding/OnboardingFlow.tsx:BODY_FIELDS", "components/DayNutrients.tsx:DRI_BY_CODE",
  "app/page.tsx:MINOR_SLOTS",
  // timing marks: no user data, flushed to /api/timings under the sender's own handle
  "lib/timing.ts:open", "lib/timing.ts:known", "lib/timing.ts:currentByPath", "lib/timing.ts:runSeq",
  "lib/timing.ts:buffer", "lib/timing.ts:flushTimer", "lib/timing.ts:inFlight",
  "lib/timing.ts:STEP_ORDER", "lib/timing.ts:PATH_ORDER",
  // lock chains: hold no data; every link asserts its own handle
  "lib/targets/client.ts:pendingLock", "lib/health/weigh-in-client.ts:pendingLock", "lib/log/pending.ts:chain",
  // device-level
  "lib/dom/scroll-lock.ts:lockCount", "lib/dom/scroll-lock.ts:restoreValue",
  "lib/log/web-lock.ts:wedgedName", "lib/log/web-lock.ts:wedgedUntil", "lib/log/web-lock.ts:warned",
  "lib/fetch-with-deadline.ts:live", "lib/store.ts:migrated", "lib/store.ts:onSave",
  "app/sign-in/attempt-limit.ts:windows",
  // the binding itself and the per-account DB map (closed by forget, Task 10)
  "lib/device/account.ts:epoch", "lib/device/account.ts:bound", "lib/device/account.ts:ready",
  "lib/device/account.ts:readyListeners", "lib/device/account.ts:goneListeners", "lib/sync/idb.ts:dbs",
]);
const DECL = /^(?:export\s+)?(?:let\s+(\w+)|const\s+(\w+)\s*(?::[^=]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b)/gm;
const SERVER_ONLY = /^(lib\/server|lib\/mcp|lib\/ai|app\/api)\//;

function clientFiles(): string[] {
  return ["lib", "components", "app"].flatMap((dir) =>
    (readdirSync(dir, { recursive: true }) as string[]).map((f) => `${dir}/${f}`))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !SERVER_ONLY.test(f));
}

describe("module state is purged or declared account-free", () => {
  it("every top-level let / Map / Set is in PURGED_STATE or ACCOUNT_FREE", () => {
    const unknown: string[] = [];
    for (const file of clientFiles()) {
      for (const m of readFileSync(file, "utf8").matchAll(DECL)) {
        const id = `${file}:${m[1] ?? m[2]}`;
        if (!PURGED_STATE.includes(id) && !ACCOUNT_FREE.has(id)) unknown.push(id);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("names no state that no longer exists", () => {
    const all = new Set(clientFiles().flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(DECL)].map((m) => `${file}:${m[1] ?? m[2]}`)));
    expect(PURGED_STATE.filter((id) => !all.has(id))).toEqual([]);
  });
});
```

```ts
// tests/device/purge.test.ts
import { describe, expect, it } from "vitest";
import { purgeAccountMemory } from "@/lib/device/purge";
import { serializePlanDay, __pendingDateCount } from "@/lib/sync/plan-day-queue";

describe("purgeAccountMemory", () => {
  it("drops queued plan-day work so the next account starts empty", async () => {
    void serializePlanDay("2026-09-22", () => new Promise(() => {})); // never settles
    expect(__pendingDateCount()).toBe(1);
    purgeAccountMemory();
    expect(__pendingDateCount()).toBe(0);
  });
});
```

(`__pendingDateCount` is a test-only export added in `lib/sync/plan-day-queue.ts`, like
`__resetStoreCache`.)

- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run tests/device/module-state.test.ts tests/device/purge.test.ts` — Expected: FAIL (`lib/device/purge` missing).
- [ ] **Step 3: Implement** the reset functions (each one line: `.clear()` or `= null`/`= false`) and `purge.ts`:

```ts
// lib/device/purge.ts
import { resetStoreCache } from "@/lib/store";
import { resetFoodRefCache } from "@/lib/log-client";
import { resetPlanDayQueue } from "@/lib/sync/plan-day-queue";
import { resetSyncPasses } from "@/lib/sync/client";
import { resetApplyState } from "@/lib/coach/apply-client";
import { resetLiveCommits } from "@/lib/log/live-commits";
import { resetNoteSaves } from "@/lib/log-note-client";
import { resetWeighInDrains } from "@/lib/health/weigh-in-client";
import { resetPrefsState } from "@/lib/foods/prefs-client";
import { resetCapabilityCache } from "@/lib/health/capability";

export const PURGED_STATE: readonly string[] = [
  "lib/store.ts:cached", "lib/store.ts:cachedFor", "lib/store.ts:persistFailed",
  "lib/log-client.ts:refCache", "lib/sync/plan-day-queue.ts:pendingDates",
  "lib/sync/client.ts:passes",
  "lib/coach/apply-client.ts:applying", "lib/coach/apply-client.ts:undoing",
  "lib/log/live-commits.ts:live", "lib/log/live-commits.ts:deletedWhileLive",
  "lib/log-note-client.ts:saves", "lib/health/weigh-in-client.ts:inFlight",
  "lib/foods/prefs-client.ts:membershipRevisions", "lib/foods/prefs-client.ts:inFlight",
  "lib/foods/prefs-client.ts:failedIds", "lib/foods/prefs-client.ts:stateOwner",
  "lib/health/capability.ts:sessionValue", "lib/health/capability.ts:inFlight",
];

/** Spec §0.3. In-flight promises are not awaited: their settle hits assertCurrent and stops. */
export function purgeAccountMemory(): void {
  resetStoreCache(); resetFoodRefCache(); resetPlanDayQueue(); resetSyncPasses();
  resetApplyState(); resetLiveCommits(); resetNoteSaves(); resetWeighInDrains();
  resetPrefsState(); resetCapabilityCache();
}
```

- [ ] **Step 4: Run and see them pass** — same command. Expected: PASS. If the scan lists a name not in either list, decide per the rule in the comment and add it with a reason.
- [ ] **Step 5: Commit** — `git add lib tests && git commit -m "fix: purge account module memory on unbind"`

---

### Task 6: Sync runs only for a ready account

**Files:**
- Create: `lib/sync/account-sync.ts`
- Modify: `lib/sync/client.ts:106-302` (handle on `pullChanges`, `pushOutbox`, `flushOutboxNow`, `syncOnce`, `lastSyncAt`, `lastError`; `inFlight`/`runAgain` → `passes: Map<number /* epoch */, …>`); `lib/sync/post-sync.ts:31-60` (`syncThenCatchUp(h, foods)`, `catchUpAfterSync(h, foods)`); `components/SyncBootstrap.tsx:25-98` (subscribe only); `app/layout.tsx:47` (remove `<SyncBootstrap />`); `components/AuthGate.tsx:332-360` (render `<SyncBootstrap />` inside the gate for every view except `signed-out` and exempt routes); `components/SyncStatus.tsx:96-102` (pass the handle)
- Test: `tests/sync/account-sync.test.ts`; update `lib/sync/client.test.ts`, `tests/sync/post-sync.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `startAccountSync(h: AccountHandle, deps?: { run?: (h) => Promise<void>; win?: Window }): () => void`; `mountAccountSync(start?: typeof startAccountSync): () => void` (the ready/gone subscription that `SyncBootstrap` calls, so a test can drive the real subscription); `resetSyncPasses(): void`.

`syncOnce(h)` behavior: one pass per epoch (coalesce as today, keyed by `h.epoch`); on
`AccountChanged` from any step, the pass rejects with `AccountChanged` **before** calling
`setLastError` and never calls `setCursor`/`setLastSyncAt`. The `runAgain` follow-up checks
`isCurrent(h)` first.

`SyncBootstrap` becomes:

```tsx
export default function SyncBootstrap() {
  useEffect(() => {
    return mountAccountSync();
  }, []);
  return null;
}
```

`startAccountSync(h)` holds today's effect body (`components/SyncBootstrap.tsx:27-94`) with three
changes: `restoreCachedPlanDays(h)` instead of the auth listener (`:36-56` is deleted — the ready
event already means "this session's account"); `run()` calls `syncThenCatchUp(h, …)` and ignores
`AccountChanged`; every listener is removed by the returned stop.

```ts
// lib/sync/account-sync.ts
export function mountAccountSync(start: typeof startAccountSync = startAccountSync): () => void {
  let stop: (() => void) | null = null;
  const offReady = onAccountReady((h) => { stop?.(); stop = start(h); });
  const offGone = onAccountGone(() => { stop?.(); stop = null; });
  return () => { offReady(); offGone(); stop?.(); stop = null; };
}
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/sync/account-sync.test.ts
// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, markAccountReady, unbindAccount, AccountChanged, type AccountHandle }
  from "@/lib/device/account";
import { mountAccountSync, startAccountSync } from "@/lib/sync/account-sync";
import { closeAllAccountDbs, getCursor, setCursor } from "@/lib/sync/idb";
import { pullChanges } from "@/lib/sync/client";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(async () => { await closeAllAccountDbs(); unbindAccount(); globalThis.indexedDB = new IDBFactory(); });

describe("sync gating", () => {
  it("starts no pass before ready, one pass at ready, and none after the account is gone", async () => {
    const run = vi.fn(async (_h: AccountHandle) => {});
    const unmount = mountAccountSync((h) => startAccountSync(h, { run }));
    const h = bindAccount(A);                         // bound, adoption not finished
    window.dispatchEvent(new Event("online"));
    expect(run).not.toHaveBeenCalled();              // nothing before ready
    markAccountReady(h);
    expect(run).toHaveBeenCalledTimes(1);            // the ready event starts the pass
    unbindAccount();                                  // gone: timers and listeners stop
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(run).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("a pass in progress during a switch saves no cursor", async () => {
    const a = bindAccount(A);
    await setCursor(a, 3);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchFn = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ changes: [], next_cursor: 99, has_more: false }));
    }) as unknown as typeof fetch;
    const pass = pullChanges(a, undefined, { fetchFn });
    bindAccount(B);
    release();
    await expect(pass).rejects.toBeInstanceOf(AccountChanged);
    unbindAccount();
    expect(await getCursor(bindAccount(A))).toBe(3);
  });

  it("the new account's pass starts after the switch, and only after B is ready", async () => {
    const run = vi.fn(async (_h: AccountHandle) => {});
    const unmount = mountAccountSync((h) => startAccountSync(h, { run }));
    markAccountReady(bindAccount(A));
    const b = bindAccount(B);                         // switch: A is gone, B not ready yet
    window.dispatchEvent(new Event("online"));
    expect(run.mock.calls.map(([h]) => h.userId)).toEqual([A]);
    markAccountReady(b);
    expect(run.mock.calls.map(([h]) => h.userId)).toEqual([A, B]);
    unmount();
  });
});
```

- [ ] **Step 2: Run and see it fail** — `pnpm exec vitest run tests/sync/account-sync.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** as described; pass `fetchImpl: options.fetchFn` into `accountFetch` once Task 7 lands (until then keep `fetchFn` and move to `accountFetch` in Task 7).
- [ ] **Step 4: Run and see it pass** — `pnpm exec vitest run tests/sync/account-sync.test.ts lib/sync/client.test.ts tests/sync/post-sync.test.ts components/AuthGate.test.tsx` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add app components lib tests && git commit -m "fix: start sync only for a ready account, one pass per account"`

---

### Task 7: Ops carry `user_id`; `accountFetch`; the server refuses a mismatch

**Files:**
- Modify: `lib/device/account.ts` (add `ACCOUNT_HEADER`, `accountFetch`)
- Modify: `lib/sync/outbox.ts:127-132` (`wireOp` keeps `user_id`; `PushFn` takes `OwnedOp[]`)
- Modify: `lib/sync/types.ts:54-62` (`SyncOpSchema` gets `user_id: z.uuid().optional()`)
- Modify: `app/api/sync/ops/route.ts:37-43,84-93` (per-op check; strip `user_id` before the RPC)
- Modify: `lib/server/auth.ts:22-30` (header check)
- Modify: every client module that calls an app route: `lib/barcode/client.ts`, `lib/capture-client.ts`, `lib/catalog-client.ts`, `lib/coach-client.ts`, `lib/coach-transcribe-client.ts`, `lib/constraints-client.ts`, `lib/estimator-client.ts`, `lib/health-client.ts`, `lib/health/capability.ts`, `lib/health/today-card.ts`, `lib/health/weigh-in-client.ts`, `lib/log-commit-client.ts:274`, `lib/profile/prefs-client.ts`, `lib/sync/client.ts:196-212`, `lib/targets/client.ts`, `lib/today/water-and-weight.ts`, `lib/timing.ts`, `components/BodyTodayCardGate.tsx` (re-run `grep -rnE "[\"'\`]/api/" lib components app` excluding `app/api`, `lib/server`, `lib/mcp` before you start; the list at `1d5790d` is above)
- Test: `tests/device/account-fetch.test.ts`, `tests/sync/ops-route-account.test.ts`, `tests/log/commit-account-mismatch.test.ts`, additions to `lib/server/auth.test.ts`, `tests/sync/cross-user-http.test.ts` (extend)

**Interfaces:**
```ts
export const ACCOUNT_HEADER = "x-smc-account";
/** Checks the handle before the send AND after the response resolves (audit plan r2 finding 8). */
export async function accountFetch(h, input, init = {}, opts = {}): Promise<Response> {
  assertCurrent(h);
  const headers = new Headers(init.headers);
  headers.set(ACCOUNT_HEADER, h.userId);
  const next = { ...init, headers };
  const res = await (opts.budget
    ? fetchWithDeadline(opts.budget, input, next, { fetchImpl: opts.fetchImpl })
    : (opts.fetchImpl ?? fetch)(input, next));
  assertCurrent(h);
  return res;
}
/** The only way client code reads a body from accountFetch: each checks the handle after parsing. */
export async function accountJson<T>(h: AccountHandle, res: Response): Promise<T> {
  const body = (await res.json()) as T; assertCurrent(h); return body;
}
export async function accountText(h: AccountHandle, res: Response): Promise<string> {
  const body = await res.text(); assertCurrent(h); return body;
}
export async function accountBlob(h: AccountHandle, res: Response): Promise<Blob> {
  const body = await res.blob(); assertCurrent(h); return body;
}
```

Every account-data path reads its body with `accountJson`/`accountText`/`accountBlob`, including
coach turns (`lib/coach-client.ts:128`) and constraints (`lib/constraints-client.ts:22`). A stream
reader (coach streaming, if present) calls `assertCurrent(h)` after each chunk. The React caller
drops the result on `AccountChanged`.

Allow-list for the guard test: only `lib/warm-client.ts` (`/api/warm` ping; no user data in the
request or the answer). **No export exemption** (audit plan r2 finding 6): the export links
(`components/ExportCard.tsx:59` and its siblings, `href={exportHref(…)}`) become buttons that call
`downloadExport(h, kind, from, to)` in `lib/export-client.ts` (new): `accountFetch(h, exportHref(…))`
→ `accountBlob(h, res)` → an object URL on a temporary `<a download="<kind>-<from>-<to>.csv">`,
clicked, then revoked. The export route calls `requireUser`, so a stale tab gets
`409 account_mismatch` (`app/api/export/route.ts:152`). The link text and look stay the same.
Everything else goes through `accountFetch`.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/server/auth.test.ts — add inside describe("requireUser")
it("answers 409 account_mismatch when x-smc-account is not the JWT subject", async () => {
  mockedCreate.mockReturnValue(clientWith({ data: { claims: { sub: B } }, error: null }));
  const req = new Request("https://app.test/api/x", { headers: { "x-smc-account": A } });
  await expect(requireUser(req)).rejects.toMatchObject({ status: 409, code: "account_mismatch" });
});
it("accepts a matching header and a missing header", async () => {
  mockedCreate.mockReturnValue(clientWith({ data: { claims: { sub: B } }, error: null }));
  await expect(requireUser(new Request("https://app.test/api/x", { headers: { "x-smc-account": B } })))
    .resolves.toMatchObject({ userId: B });
  await expect(requireUser(new Request("https://app.test/api/x"))).resolves.toMatchObject({ userId: B });
});
```
(`A`/`B` are UUID constants at the top of the file.)

```ts
// tests/log/commit-account-mismatch.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
const applyLogEntry = vi.fn();
const getClaims = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createRequestClient: () => ({ auth: { getClaims } }) }));
vi.mock("@/lib/server/log", () => ({ applyLogEntry: (...a: unknown[]) => applyLogEntry(...a) }));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: async () => {} }));
const { POST } = await import("@/app/api/log/commit/route");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => { applyLogEntry.mockReset(); getClaims.mockResolvedValue({ data: { claims: { sub: B } }, error: null }); });

describe("POST /api/log/commit account check", () => {
  it("answers 409 account_mismatch for A's header on B's JWT and writes nothing", async () => {
    const res = await POST(new Request("https://x.test/api/log/commit", {
      method: "POST", headers: { "content-type": "application/json", "x-smc-account": A },
      body: JSON.stringify({ entry_id: crypto.randomUUID() }),
    }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "account_mismatch" });
    expect(applyLogEntry).not.toHaveBeenCalled();
  });
});
```

```ts
// tests/sync/ops-route-account.test.ts (same mocks as tests/sync/ops-route.test.ts:1-50;
// requireUser resolves { userId: B, client: { rpc } })
it("refuses an op stamped for another account with error/account_mismatch and does not apply it", async () => {
  const res = await POST(request({ ops: [op({ user_id: A } as never)] }));
  const body = await res.json();
  expect(body.results[0]).toMatchObject({ status: "error", message: "account_mismatch" });
  expect(rpc).not.toHaveBeenCalled();
});
it("refuses an op with no user_id with error/account_unbound and does not apply it", async () => {
  const res = await POST(request({ ops: [op()] }));
  expect((await res.json()).results[0]).toMatchObject({ status: "error", message: "account_unbound" });
  expect(rpc).not.toHaveBeenCalled();
});
it("applies an op stamped for the JWT user, without user_id in p_op", async () => {
  rpc.mockResolvedValue({ data: { op_id: "x", status: "applied", rev: 2, seq: 1 }, error: null });
  const o = op({ user_id: B } as never);
  await POST(request({ ops: [o] }));
  expect(rpc.mock.calls[0][1].p_op).not.toHaveProperty("user_id");
});
```

Note: the existing tests in `tests/sync/ops-route.test.ts` send ops without `user_id`. Change its
`op()` helper to stamp `user_id` with the mocked user (make the mocked user a UUID), so they keep
testing what they test today.

Old-client behavior test (proves the refusal keeps an old tab's op; runs the **current**
`applyResult` logic, which the new build keeps for `error`), in `lib/sync/outbox.test.ts`:

```ts
it("an account_unbound error parks the op and never deletes it", async () => {
  const h = bindAccount(A);
  const queued = await appendOp(h, waterOp("o1"));
  for (let i = 0; i < MAX_ERROR_ATTEMPTS + 2; i += 1) {
    await applyResult(h, { op_id: "o1", status: "error", message: "account_unbound" },
      (await allOps(h))[0], () => 1_000 * i);
  }
  const [op] = await allOps(h);
  expect(op.op_id).toBe(queued.op_id);
  expect(op.next_attempt_at).toBeGreaterThan(300 * 24 * 3600 * 1000);   // parked, one year out
});
```

Two-tab server test (audit plan r2 finding 1), in `tests/sync/cross-user-http.test.ts` (DB, CI
`integration`): A's water row exists; B's cookie posts an op **without** `user_id` for A's date →
`account_unbound`; A's row and B's rows are unchanged. And one client test: every op that
`drainOutbox` hands to `push` carries `user_id` equal to the handle's user id.

```ts
// tests/device/account-fetch.test.ts
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { accountFetch, accountJson, bindAccount, unbindAccount, AccountChanged } from "@/lib/device/account";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALLOWED = new Set(["lib/device/account.ts", "lib/warm-client.ts", "lib/fetch-with-deadline.ts"]);
const HREF_API = /href=\{?["'`]?[^}"'`]*\/api\//;     // no plain <a href="/api/..."> in client code
const RAW_BODY = /\.(json|text|blob)\(\)/;              // bodies go through accountJson/Text/Blob
const RAW_CALL = /\b(fetch|fetchWithDeadline|fetchFn|fetchImpl|doFetch|globalThis\.fetch)\s*\(/;
const API_LITERAL = /["'`]\/api\//;
const SERVER_ONLY = /^(lib\/server|lib\/mcp|lib\/ai|app\/api)\//;

describe("accountFetch", () => {
  it("adds x-smc-account", async () => {
    const f = vi.fn(async () => new Response("{}"));
    await accountFetch(bindAccount(A), "/api/x", {}, { fetchImpl: f as never });
    expect(new Headers((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get("x-smc-account")).toBe(A);
  });
  it("drops a response that arrives after the account changed", async () => {
    let answer!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
    const a = bindAccount(A);
    const pending = accountFetch(a, "/api/coach/turn", {}, { fetchImpl: f as never });
    bindAccount(B);
    answer(new Response(JSON.stringify({ reply: "A only" })));
    await expect(pending).rejects.toBeInstanceOf(AccountChanged);
  });
  it("drops a body parsed after the account changed", async () => {
    const a = bindAccount(A);
    const res = await accountFetch(a, "/api/constraints", {}, { fetchImpl: (async () => new Response("{\"x\":1}")) as never });
    bindAccount(B);
    await expect(accountJson(a, res)).rejects.toBeInstanceOf(AccountChanged);
  });
  it("sends nothing with a stale handle", async () => {
    unbindAccount();
    const a = bindAccount(A); bindAccount(B);
    const f = vi.fn();
    await expect(accountFetch(a, "/api/x", {}, { fetchImpl: f as never })).rejects.toBeInstanceOf(AccountChanged);
    expect(f).not.toHaveBeenCalled();
  });
  it("is the only way client code calls an app /api/ route", () => {
    const offenders: string[] = [];
    const files = ["lib", "components", "app"].flatMap((d) =>
      (readdirSync(d, { recursive: true }) as string[]).map((f) => `${d}/${f}`))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !SERVER_ONLY.test(f));
    for (const file of files) {
      if (ALLOWED.has(file)) continue;
      const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (API_LITERAL.test(src) && RAW_CALL.test(src)) offenders.push(file);
      if (HREF_API.test(src) || /exportHref\(/.test(src) && /href=\{exportHref/.test(src)) offenders.push(`${file} (href)`);
      if (/accountFetch\(/.test(src) && RAW_BODY.test(src)) offenders.push(`${file} (raw body)`);
      if (/location\.(assign|replace|href)\s*[=(]\s*["'`]\/api\//.test(src)) offenders.push(`${file} (navigation to /api/)`);
    }
    expect(offenders).toEqual([]);
  });
});
```

Direct-request test (switch before the POST), in `tests/sync/account-isolation.test.ts` (this
file runs under `// @vitest-environment jsdom` so `window` events fire). Behavior to implement:
when a step after the switch throws `AccountChanged` (`writeLocalFirst` or `accountFetch`),
`postCommit` sends nothing, writes nothing more, and returns `{ status: "owned_elsewhere" }` (the
existing "this tab did not send it" result, `lib/log-commit-client.ts:196-200`). A's pending
record, written by `recordFirst` (`lib/log-commit-client.ts:63-70`, `lib/log/pending.ts`) before
the switch, stays in A's database and is retried as A later.

The switch is made deterministic by the event `postCommit` already fires between the local record
and the POST: with `optimistic` set, `announceLog()` dispatches `LOG_QUEUED_EVENT`
(`lib/log/pending.ts:93-95`) after `recordFirst` and before `writeLocalFirst` and the fetch.

```ts
it("sends nothing when the session switches between the local write and the POST", async () => {
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
  const a = bindAccount(A);
  let forgotten: Promise<void> = Promise.resolve();
  const onLog = () => {                               // the same steps, in the same order, as AuthGate
    window.removeEventListener(LOG_QUEUED_EVENT, onLog);
    forgotten = runTransition(async () => {
      const prev = unbindAccount()!;
      purgeAccountMemory();
      await forgetAccount(prev, { keep: B });
      bindAccount(B);
    });
  };
  window.addEventListener(LOG_QUEUED_EVENT, onLog);
  const req = sampleCommit();
  const result = await commitLogEntry(req, {
    fetchImpl: fetchImpl as never, optimistic: { date: "2026-09-22", entry: sampleEntry(req) },
  });
  expect(result).toEqual({ status: "owned_elsewhere" });
  expect(fetchImpl).not.toHaveBeenCalled();
  await forgotten;                                    // audit plan r1 finding 1: A's DB survives
  expect((await indexedDB.databases()).map((d) => d.name)).toContain(accountDbName(A));
  const b = accountHandle();
  expect(await allRows(b, "log_entries")).toEqual([]);
  expect(await allOps(b)).toEqual([]);
  unbindAccount();
  const a2 = bindAccount(A);
  expect(await getMeta(a2, PENDING_LOG_KEY)).toEqual(
    expect.arrayContaining([expect.objectContaining({ request: expect.objectContaining({ entry_id: req.entry_id }) })]));
  void a;
});
```

`sampleCommit()` and `sampleEntry()` build a `LogCommitRequest` and its `LoggedFood` card with the
helpers in `tests/log/fixtures.ts`. `PENDING_LOG_KEY` is the meta key in `lib/log/pending.ts`
(export it if it is not exported). If the record shape differs, assert on the entry id only.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run lib/server/auth.test.ts tests/log/commit-account-mismatch.test.ts tests/sync/ops-route-account.test.ts tests/device/account-fetch.test.ts tests/sync/account-isolation.test.ts`
Expected: FAIL (no header check, no per-op check, raw fetches listed).

- [ ] **Step 3: Implement**

```ts
// lib/server/auth.ts — inside requireUser, after the 401 check
const claimed = req.headers.get("x-smc-account");
if (claimed !== null && claimed !== userId) {
  throw new HttpError(409, "account_mismatch", "This request belongs to another account on this device.");
}
```

```ts
// app/api/sync/ops/route.ts — in the loop, before applyOp
const owner = (op as SyncOp & { user_id?: string }).user_id;
if (owner === undefined) { results.push(errorResult(op, "account_unbound")); continue; }
if (owner !== userId) { results.push(errorResult(op, "account_mismatch")); continue; }
const { user_id: _owner, ...wire } = op as SyncOp & { user_id?: string };
results.push(await applyOp(client, userId, wire));
```

Then move each listed client module to `accountFetch(h, …)`, handle captured per Task 3's rule.

Export test (audit plan r2 finding 6), `tests/export/download-account.test.ts` (jsdom): tab state
bound to A, then B binds (the two-tab switch), then the user taps "Download meals CSV" in A's
still-mounted card: `downloadExport(a, "meals", "", "")` rejects with `AccountChanged`, the fetch
is never called, and `URL.createObjectURL` is never called. A second case: the fetch answers after
the switch → rejects, no object URL. A route case (mocks like `tests/log/commit-account-mismatch.test.ts`):
`GET /api/export?kind=meals` with `x-smc-account: A` and B's JWT → `409 account_mismatch`, and no
export query runs.

**Oura connect goes through `accountFetch` (audit plan r3 finding 4).** Today `connectOura()` is a
full navigation to `/api/health/oura/start` (`lib/health-client.ts:127-131`), which sends no account
header, and the route binds the OAuth state to whichever user the shared cookie authenticates
(`app/api/health/oura/start/route.ts:11-19`, `startOura(adminClient(), userId)`). Change:
- the route gets a `POST` handler with the same body as `GET` except the answer: `requireUser`
  (so `x-smc-account` ≠ JWT → `409`, before `startOura` runs), then `Response.json({ url })`;
  the `GET` handler is kept for old builds (it is what an old tab calls; its behavior is unchanged);
- `connectOura(h)`: `const res = await accountFetch(h, "/api/health/oura/start", { method: "POST" })`;
  `const { url } = await accountJson<{ url: string }>(h, res)`; then `window.location.assign(url)`
  (an absolute Oura URL, so the `no-location-assign-relative-destination` lint comment goes);
- the caller takes the handle when the user taps "Connect Oura".
Tests, `tests/health/oura-start-account.test.ts`: route `POST` with `x-smc-account: A` and B's JWT
→ `409` and `startOura` not called; matching header → `200 { url }`; client: A bound, B binds
before the tap is handled → `connectOura(a)` rejects `AccountChanged`, no fetch, no
`location.assign`; the fetch answers after the switch → rejects, no `location.assign`.

- [ ] **Step 4: Run and see them pass** — same command plus `pnpm exec vitest run tests/sync/ops-route.test.ts lib/sync/outbox.test.ts`. Expected: PASS. `tests/sync/cross-user-http.test.ts` (extend with the two cases: B's cookie + op stamped A → `account_mismatch`, A's row unchanged; op without `user_id` from B's cookie → `account_unbound`, no row changed) runs in CI `integration`.
- [ ] **Step 5: Commit** — `git add app lib components tests && git commit -m "fix: bind ops and direct requests to their account; refuse a mismatch"`

---

### Task 7b: Direct Supabase calls from the client (audit plan r3 finding 3)

Some client modules call Supabase directly with `browserClient()`, which uses the shared session
cookie. Inventory (`grep -rnE "browserClient\(\)|supabase\.(from|rpc)|\.(from|rpc)\(\"" lib components app`,
without `lib/server`, `lib/mcp`, `lib/ai`, `app/api`, the `server-only` modules
`lib/foods/facet-warm.ts`, `lib/coach/suggest-policy.ts`, `lib/coach/blocks/index.ts`, and the auth
screens `app/sign-in/*`, `components/PasswordSignInForm.tsx`), at `1d5790d`:

| Call | Kind | How the database binds it | Change in this slice |
|---|---|---|---|
| `lib/foods/prefs-client.ts:248` `rpc("set_food_membership", { p_user })` | write | `_sync_assert_caller(p_user)` refuses `p_user ≠ auth.uid()` (`20261023090400_food_membership_v2.sql:3-12`) | pass `p_user: h.userId` (never a claims read after an `await`) |
| `lib/foods/prefs-client.ts:324`, `lib/foods/adopt-client.ts:132`, `lib/recipes-client.ts:96`, `lib/log-client.ts:123` `rpc("get_or_create_food_ref", { p_user_id })` | write | `_sync_assert_caller(p_user_id)` (`20260911000600_rpc.sql:21-26`) | `p_user_id: h.userId` |
| `components/add-food/catalog-food.ts:63` `rpc("apply_sync_op", { p_user_id })` | write | `apply_sync_op` refuses `p_user_id ≠ auth.uid()` (`20260911000600_rpc.sql:8-19`) | `p_user_id: h.userId` |
| `lib/foods/prefs-client.ts:355`, `lib/foods/adopt-client.ts:120`, `components/add-food/catalog-food.ts:44` `from("user_foods").upsert({ user_id, … })` | write | RLS `user_foods_rw … with check (user_id = auth.uid())` (`20260911000500_rls.sql:5-23`) | row `user_id: h.userId` |
| `lib/log-note-client.ts:31`, `lib/coach/apply-entries.ts:139`, `lib/log/delete-entry.ts:103`, `lib/log/reconcile.ts:143`, `lib/recipes/use-recipe-sheet.ts:60,63`, `components/add-food/catalog-food.ts:55,58` | read | RLS `using (user_id = auth.uid())` (`20260911000500_rls.sql:5-23`; `log_items` through its parent): a read under B's JWT returns B's rows or none | post-resolve `assertCurrent(h)`; drop the result on `AccountChanged` |
| `lib/foods/prefs-client.ts:198,482,494`, `lib/foods/adopt-client.ts:151`, `lib/recipes-client.ts:93`, `lib/log-client.ts:120`, `lib/targets/client.ts:118`, `lib/health/weigh-in-client.ts:93`, `lib/log/reconcile.ts:40` `auth.getClaims()` used as "who am I" | identity | — | replace with `h.userId`; where a claims read stays (as a session check), require `claims.sub === h.userId`, else `AccountChanged` |
| `lib/profile/onboarding-state.ts:124` (via `AuthGate` and `components/Onboarding/OnboardingInvite.tsx:74`), `app/coach/CoachScreen.tsx:48` | read / session | RLS; `AuthGate` owns the session | post-resolve check against the handle `AuthGate` bound |

Rule (one helper, `lib/device/account-supabase.ts`):

```ts
/** Run one direct Supabase call for the account that started the work. The owner goes INTO the
 *  call (p_user / p_user_id / row.user_id = h.userId), so the database refuses it under another
 *  account's JWT; the handle is checked before the call and after it resolves. */
export async function withAccount<T>(h: AccountHandle, run: (userId: string) => PromiseLike<T>): Promise<T> {
  assertCurrent(h);
  const result = await run(h.userId);
  assertCurrent(h);
  return result;
}
```

Every call in the table goes through `withAccount`. `backfillFoodPrefs(h, foods, opts)` takes the
handle from its caller (`catchUpAfterSync(h, …)`, Task 6) instead of reading claims
(`lib/foods/prefs-client.ts:478-495`); the "still the same user?" check at `:494-495` becomes
`isCurrent(h)`.

Residual window, stated: between the pre-call check and the database commit, another tab can
change the cookie. For the writes above the owner is in the call, so the database refuses it
(`forbidden` / RLS) instead of writing into the other account; the caller treats that refusal like
`AccountChanged`. For the reads, the post-resolve check drops the answer.

- [ ] **Step 1: Failing tests** (`tests/device/account-supabase.test.ts`, fake Supabase client that
  records calls and can hold a promise open):
  - `backfillFoodPrefs(a, foods, { supabase: fake })` with the claims read (or the first RPC) held
    open; B binds; release → no `set_food_membership`, no `get_or_create_food_ref`, no
    `user_foods` write is issued after the switch; the call resolves with `synced: 0`;
  - every RPC the fake records carries `p_user`/`p_user_id` = A, never a value read from claims
    after the switch;
  - `withAccount(a, …)` whose promise resolves after B binds → rejects `AccountChanged`;
  - guard: every client file in the table's inventory that calls `.rpc(` or `.from(` also calls
    `withAccount(` (source scan, same file walker as `tests/device/account-fetch.test.ts`).
- [ ] **Step 2:** `pnpm exec vitest run tests/device/account-supabase.test.ts` — FAIL.
- [ ] **Step 3:** implement the helper and move each call. The DB-bound refusal tests for the RPCs
  already exist (`tests/rls/apply-sync-op.test.ts`, `tests/rls/cross-user.test.ts`); add one case to
  `tests/rls/cross-user.test.ts`: B's client calls `set_food_membership` with `p_user = A` →
  `forbidden`, A's rows unchanged (DB, CI `integration`).
- [ ] **Step 4:** PASS. **Step 5:** commit `fix: bind direct Supabase calls to the starting account`.

---

### Task 8: Settle paths keep their handle (the delayed writer)

**Files:** `lib/log-commit-settle.ts`, `lib/log-commit-client.ts` (already threaded in Task 3); test in `tests/sync/account-isolation.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it("a log commit that starts as A and is answered after a switch to B writes into neither database", async () => {
  let answer!: (r: Response) => void;
  const fetchImpl = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
  const a = bindAccount(A);
  const pending = commitLogEntry(sampleCommit(), { fetchImpl: fetchImpl as never });
  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
  const beforeA = await allRows(a, "log_entries");
  const b = bindAccount(B);
  answer(new Response(JSON.stringify(acceptedBody()), { status: 200 }));
  await pending;
  expect(await allRows(b, "log_entries")).toEqual([]);
  unbindAccount();
  expect(await allRows(bindAccount(A), "log_entries")).toEqual(beforeA);
});
```

- [ ] **Step 2: Run** — `pnpm exec vitest run tests/sync/account-isolation.test.ts -t "answered after a switch"` — Expected: FAIL if any settle path still reads a fresh handle; PASS if Task 3 threaded it correctly. If it passes at once, break it on purpose (call `accountHandle()` inside `settleAccepted`), see it fail, restore.
- [ ] **Step 3: Fix** any path that fails: the settle catches `AccountChanged` and returns without writing (spec 0.2 last bullet).
- [ ] **Step 4: Run** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -am "test: delayed log settle writes nothing after an account switch"`

---

### Task 9: Legacy adoption (first boot of the new build)

**Files:**
- Create: `lib/device/legacy-adoption.ts`
- Modify: `components/SyncStatus.tsx:96-102` (show the held line), `components/AuthGate.tsx` (call adoption between bind and ready; Task 10)
- Test: `tests/device/legacy-adoption.test.ts`

**Interfaces:**
```ts
export async function adoptLegacyDevice(h: AccountHandle): Promise<{ copied: number; heldOps: number }>;
export async function legacyHeldCount(): Promise<number>;  // 0 when there is no legacy DB
export const HELD_LINE = (n: number) => `${n} changes from before the update are held on this phone.`;
```

Rules (spec 0.6 plus plan decision P3):
1. Open `smc` **without creating it**: `openDB("smc")` with no version; in `upgrade` (fires only
   when the database did not exist, `oldVersion === 0`) set a flag; if the flag is set, close and
   `indexedDB.deleteDatabase("smc")` and return `{ copied: 0, heldOps: 0 }`.
2. For each entity store in `ENTITIES`, copy a row into `smc-u-<h.userId>` only when
   `row.user_id === h.userId`, and only when the target key is empty (never overwrite a newer
   row). Rows without `user_id` are not copied.
3. Copy the meta key `grandfathered_eaten:<h.userId>` if present (owner-keyed, so provable). Do
   not copy the cursor, `outbox_seq`, `last_error` or any other meta.
4. Never read, stamp or copy an outbox op. Count them (`count(OUTBOX_STORE)`).
4a. **Owner-stamped pending records are adopted by owner (audit plan r2 finding 2).** The legacy
   `meta` store holds three durable queues whose records carry the account that made them:
   `pending_log_entries` (`PendingLogEntry.userId`, `lib/log/pending.ts:79,180-194`),
   `pending_weigh_ins` (`PendingWeighIn.userId`, `lib/health/weigh-in-client.ts:67-68`),
   `pending_target_revisions` (`PendingTargetRevision.ownerId`, `lib/targets/client.ts:57-64`). A
   record whose owner equals `h.userId` is copied into the same key of the account DB (merged by
   `entryId` / `request.localDate` / `requestId`; an existing record in the account DB wins). A
   record with another owner or a null owner is not copied. Nothing is removed from `smc`.
5. **`smc` is deleted only when every store with unsent work is proven empty** (audit plan r2
   finding 2): the outbox count is 0 **and** the three meta queues of rule 4a are absent or empty
   **and** no other `meta` key starts with `pending_` (a future queue fails closed). Any read error
   → keep `smc`. Otherwise keep it untouched, whatever was adopted. `legacyHeldCount()` reports
   the outbox count plus the records of the three queues that no bound account on this phone has
   adopted (records with a null owner count as held).
6. `localStorage`: delete the unprefixed account caches (`smc:coach:*` except `smc:coach:current:*`
   and `smc:coach:return`, `smc:coach-action:*`, `smc:health_daily`, `smc:expenditure`,
   `smc:proposals`, `meal-companion:food-refs`, `meal-companion:onboardingInviteDismissedAt`);
   move `smc:draft:*`, `smc:pending_scans` and `meal-companion:store:v1` under
   `smc:legacy:<old key>` (held: never shown, never sent).
7. Idempotent: a device key `smc:device:legacy-adopted:<userId>` = `"1"` skips steps 2–3 on later
   boots; steps 4–6 are cheap and safe to repeat.
8. Every write asserts `h`. `AccountChanged` aborts adoption quietly (the next bind runs it again).
   Any other error rejects `adoptLegacyDevice` (no catch-all); Task 10 decides what the gate shows.
   The device key of rule 7 is written only after steps 1–5 all succeed.
9. **Legacy eaten ticks are held and never imported (audit plan r3 finding 2; replaces the
   r1/r2 import design).** Today's D1 migration (`lib/sync/plan-days.ts:14-33`) reads ticks from
   the shared store blob (`loadStore().days`, `:23-24`). The blob carries no account id, and the
   server's "grandfathered" answer (`components/AuthGate.tsx:215-220`) proves only that an account
   has an old row, not who made the ticks. So no account can prove it owns them. The new build:
   - does **not** import ticks from the held blob `smc:legacy:meal-companion:store:v1` for any
     account; the blob stays held (never shown, never sent);
   - removes the D1 call from `AuthGate` (`components/AuthGate.tsx:311-315`) and the code that only
     it uses: `acknowledgeEatenDates` (`:227-232`), `grandfatheredForEaten` (`:215-220`),
     `migrateGrandfatheredEaten` (`lib/sync/plan-days.ts:14-33`) and `EATEN_MIGRATION_PREFIX`
     (`:11`), with their tests (`tests/plan/eaten-migration.test.ts`, the cases in
     `lib/sync/plan-days.test.ts`, `components/AuthGate.test.tsx` and
     `tests/onboarding/auth-gate.test.tsx` that name them);
   - still copies the legacy marker `grandfathered_eaten:<userId>` (rule 3) so the record of a
     finished migration is kept.
   Cost, stated: an account whose D1 migration never finished on this phone loses the display of
   ticks made before `plan_days.eaten_slots` existed. Losing ticks is acceptable; giving them to
   the wrong account is not. For Sasha, the D1 migration ran on every online open with a server
   read since it shipped, so her marker is expected to be set.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/device/legacy-adoption.test.ts
// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { openDB } from "idb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { adoptLegacyDevice, legacyHeldCount } from "@/lib/device/legacy-adoption";
import { loadStore } from "@/lib/store";
import { purgeAccountMemory } from "@/lib/device/purge";
import { allOps, closeAllAccountDbs, getRow, getMeta, upgradeStores } from "@/lib/sync/idb";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function seedLegacy(): Promise<void> {
  const db = await openDB("smc", 4, { upgrade: upgradeStores });
  await db.put("plan_days", { local_date: "2026-09-01", user_id: A, rev: 3 }, "2026-09-01");
  await db.put("plan_days", { local_date: "2026-09-02", user_id: B, rev: 1 }, "2026-09-02");
  await db.put("water_log", { local_date: "2026-09-03", cups: 5, rev: 1 }, "2026-09-03"); // no owner
  await db.put("outbox", { op_id: "w1", entity: "water_log", entity_id: "2026-09-03", kind: "update",
    base_rev: 0, payload: { local_date: "2026-09-03", cups: 5 }, client_ts: "2026-09-03T08:00:00Z",
    seq: 1, attempts: 0, error_attempts: 0, queued_at: "2026-09-03T08:00:00Z", next_attempt_at: 0 });
  await db.put("meta", 41, "cursor");
  await db.put("meta", true, `grandfathered_eaten:${A}`);
  db.close();
}

beforeEach(async () => {
  await closeAllAccountDbs(); unbindAccount(); localStorage.clear();
  globalThis.indexedDB = new IDBFactory();
});

describe("legacy adoption", () => {
  it("copies only the current account's owner-stamped rows and its eaten marker", async () => {
    await seedLegacy();
    const a = bindAccount(A);
    await adoptLegacyDevice(a);
    expect(await getRow(a, "plan_days", "2026-09-01")).toMatchObject({ user_id: A });
    expect(await getRow(a, "plan_days", "2026-09-02")).toBeUndefined();
    expect(await getRow(a, "water_log", "2026-09-03")).toBeUndefined();
    expect(await getMeta(a, `grandfathered_eaten:${A}`)).toBe(true);
    expect(await getMeta(a, "cursor")).toBeUndefined();
  });

  it("holds an unowned water op under A and under B: not copied, not sent, counted", async () => {
    await seedLegacy();
    const a = bindAccount(A);
    await adoptLegacyDevice(a);
    expect(await allOps(a)).toEqual([]);
    const b = bindAccount(B);
    await adoptLegacyDevice(b);
    expect(await allOps(b)).toEqual([]);
    expect(await legacyHeldCount()).toBe(1);
  });

  it("keeps smc while it holds ops, deletes it when it holds none", async () => {
    await seedLegacy();
    await adoptLegacyDevice(bindAccount(A));
    expect((await indexedDB.databases()).map((d) => d.name)).toContain("smc");
    const db = await openDB("smc"); await db.clear("outbox"); db.close();
    await adoptLegacyDevice(bindAccount(B));
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain("smc");
  });

  it.each(["pending_log_entries", "pending_weigh_ins", "pending_target_revisions", "pending_future_queue"])(
    "keeps smc when the outbox is empty but meta %s holds a record", async (key) => {
      await seedLegacy();
      const db = await openDB("smc"); await db.clear("outbox");
      await db.put("meta", [{ userId: null, ownerId: null, entryId: "e1", requestId: "r1" }], key);
      db.close();
      await adoptLegacyDevice(bindAccount(A));
      expect((await indexedDB.databases()).map((d) => d.name)).toContain("smc");
      expect(await legacyHeldCount()).toBeGreaterThan(0);
    });

  it("adopts owner-stamped pending records of the current account only", async () => {
    await seedLegacy();
    const db = await openDB("smc");
    await db.put("meta", [
      { entryId: "eA", userId: A, confirmed: false, state: "in_flight" },
      { entryId: "eB", userId: B, confirmed: false, state: "in_flight" },
      { entryId: "eN", userId: null, confirmed: false, state: "in_flight" },
    ], "pending_log_entries");
    await db.put("meta", [{ userId: A, request: { localDate: "2026-09-20", lb: 150, tz: "UTC" } }], "pending_weigh_ins");
    await db.put("meta", [{ ownerId: B, requestId: "rB", body: {} }], "pending_target_revisions");
    db.close();
    const a = bindAccount(A);
    await adoptLegacyDevice(a);
    expect((await getMeta<{ entryId: string }[]>(a, "pending_log_entries"))!.map((r) => r.entryId)).toEqual(["eA"]);
    expect(await getMeta(a, "pending_weigh_ins")).toHaveLength(1);
    expect(await getMeta(a, "pending_target_revisions")).toBeUndefined();
    expect((await indexedDB.databases()).map((d) => d.name)).toContain("smc");   // B's and null records remain held
  });

  it("does not create smc on a phone that never had it", async () => {
    await adoptLegacyDevice(bindAccount(A));
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain("smc");
  });

  it("deletes legacy caches and holds drafts, scans and the store blob", async () => {
    localStorage.setItem("smc:coach:t1", "{}");
    localStorage.setItem("smc:draft:d1", "{}");
    localStorage.setItem("meal-companion:store:v1", "{}");
    await adoptLegacyDevice(bindAccount(A));
    expect(localStorage.getItem("smc:coach:t1")).toBeNull();
    expect(localStorage.getItem("smc:draft:d1")).toBeNull();
    expect(localStorage.getItem("smc:legacy:smc:draft:d1")).toBe("{}");
    expect(localStorage.getItem("smc:legacy:meal-companion:store:v1")).toBe("{}");
  });

  it("never gives held legacy ticks to any account, B signing in first (audit plan r3 finding 2)", async () => {
    localStorage.setItem("meal-companion:store:v1", JSON.stringify({ version: 1,
      days: { "2026-09-01": { eaten: { "meal-1": "2026-09-01T12:00:00Z" } } } }));
    const b = bindAccount(B);
    await adoptLegacyDevice(b);
    expect(await allOps(b)).toEqual([]);
    expect(loadStore().days["2026-09-01"]).toBeUndefined();
    unbindAccount(); purgeAccountMemory();
    const a = bindAccount(A);
    await adoptLegacyDevice(a);
    expect(await allOps(a)).toEqual([]);
    expect(loadStore().days["2026-09-01"]).toBeUndefined();
    expect(localStorage.getItem("smc:legacy:meal-companion:store:v1")).not.toBeNull();   // still held
  });
});
```

- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run tests/device/legacy-adoption.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `lib/device/legacy-adoption.ts` per the rules (keep functions under 50 lines: `copyOwnedRows`, `copyEatenMarker`, `countAndMaybeDeleteLegacy`, `sweepLegacyStorage`), and remove the D1 migration code named in
rule 9 with its tests. In `components/SyncStatus.tsx`, `loadSyncStatus` also reads `legacyHeldCount()` and renders `HELD_LINE(n)` when `n > 0` (no action button).
- [ ] **Step 4: Run and see them pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git add lib components tests && git commit -m "fix: adopt legacy device rows per owner; hold legacy ops unsent"`

---

### Task 10: `AuthGate` binds, adopts, readies; `forget()` purges caches only; Sign out notice

**Files:**
- Create: `lib/device/forget.ts`
- Modify: `components/AuthGate.tsx:227-232,254-261,273-319,337-358`; `public/sw.js` (no change; the purge deletes `sasha-shell-*` caches from the page)
- Test: `tests/device/forget.test.ts`, `tests/onboarding/auth-gate.test.tsx` (add cases)

**Interfaces:**
```ts
// lib/device/forget.ts
export const DEVICE_ACCOUNTS_KEY = "smc:device:accounts";   // [{ userId, lastUsedAt }]
export function touchAccount(userId: string, now?: number): void;
export async function forgetAccount(previous: AccountHandle,
  opts?: { keep?: string | null; beforeClose?: () => Promise<void> }): Promise<void>; // beforeClose: test seam
// lib/device/transition.ts
export function runTransition(step: () => Promise<void>): Promise<void>; // one at a time, in call order
export type PendingWork = { ops: number; logRecords: number; targetRevisions: number;
  weighIns: number; drafts: number; scans: number };
/** Every kind of durable unsent work of one account, for the sign-out notice only (nothing is
 *  deleted on its answer). "unknown" when the DB exists but cannot be read. */
export async function pendingWork(userId: string): Promise<PendingWork | "unknown">;
export function hasPendingWork(w: PendingWork | "unknown"): boolean; // "unknown" → true
```

Durable unsent work counted by the notice (audit plan r1 finding 1), from the code at `1d5790d`:
- outbox rows (`OUTBOX_STORE`);
- meta `pending_log_entries` (`lib/log/pending.ts:31`) — a log commit writes this record in
  `recordFirst` (`lib/log-commit-client.ts:63-70`) **before** it queues the op
  (`writeLocalFirst`, `:245`), so for a moment it is the only retry record;
- meta `pending_target_revisions` (`lib/targets/client.ts:57`);
- meta `pending_weigh_ins` (`lib/health/weigh-in-client.ts:43`);
- `smc:u:<id>:draft:*` and `smc:u:<id>:pending_scans` in `localStorage`.
The implementer re-runs `grep -rn "PENDING_.*_KEY\|pending_" lib --include=*.ts` and adds any new
durable queue to `PendingWork` before the PR.

`pendingWork` reads a DB that is no longer bound (after unbind), so it does not use
`openAccountDb`: it opens `accountDbName(userId)` with no version, and if the `upgrade` callback
fires (the DB did not exist) it closes and deletes the empty DB and counts zero. Any other open
or read error → `"unknown"`.

**`forgetAccount(previous)` deletes no account data (plan decision P9; audit plan r3 finding 1).**
Order: `closeAccountDb(previous.userId)` (this waits for open transactions to finish); delete only
the re-fetchable caches of that account: `smc:u:<id>:coach:<thread>` (the server holds the thread),
`health_daily`, `expenditure`, `proposals`, `food-refs`; delete `caches` whose name starts with
`sasha-shell-` (guard `typeof caches !== "undefined"`). It **keeps** the account DB, `store`,
`draft:*`, `pending_scans`, `coach-action:*` and `onboarding-invite-dismissed-at`.
Reason: no check in this slice can prove that an account has no unsynced state. Example: "Type it
from the label" saves its meal only through `addExtra` into the store (`app/page.tsx:374-383` (`logFromLabel` → `addExtra`),
`lib/store.ts:212`); it makes no op and no pending record, so an empty outbox proves nothing. The
DB and the store are per account, so keeping them is safe: no other account can read them (Tasks
2 and 4). **No 3-DB cap in slice 1** (the spec's 0.7 cap is deferred): a later slice may delete an
account DB only when the account has no local-only state **and** the server confirms that sync has
caught up (for example, a server change cursor equal to the local one after a full push). The
registry `smc:device:accounts` is still written, so that later cap has its data.

`AuthGate` changes:
- **Account transitions are serialized (audit plan r2 finding 5).** A module-level promise chain
  in `lib/device/transition.ts`, `runTransition(step: () => Promise<void>)`, runs each unbind and
  bind one after the other. `applySession`, when `userId` is new or changed, calls
  `void runTransition(async () => { await forget(); const h = bindAccount(userId); touchAccount(userId); void adoptThenReady(h); })`.
  So the next account is bound only **after** `forgetAccount(previous)` has finished. A quick
  return to A waits for A's cleanup, then reopens A's kept database. `adoptThenReady` is:

  ```ts
  /** Ready only after a successful adoption (spec 0.1; audit plan r1 finding 7). */
  async function adoptThenReady(h: AccountHandle): Promise<void> {
    if (typeof indexedDB === "undefined") { markAccountReady(h); return; } // nothing to adopt; today's behavior
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await adoptLegacyDevice(h);
        if (isCurrent(h)) markAccountReady(h);
        return;
      } catch (e) {
        if (e instanceof AccountChanged || !isCurrent(h)) return;
        console.warn("Legacy adoption failed", e instanceof Error ? e.name : "unknown");
      }
    }
    if (isCurrent(h)) setAdoptionFailed(true);   // the gate shows the retry view below
  }
  ```

- **No account screen renders before adoption finishes (audit plan r2 finding 3).** `AuthGate`
  keeps `readyFor: string | null` (set by `onAccountReady` to the handle's user id; cleared by
  `onAccountGone`). `gateView(gate, pathname, blocked, ready, adoptionFailed)`:
  `adoptionFailed` → `"blocked"` with the body "This phone could not finish the update." and the
  existing Retry (re-runs `applySession` via `attempt`) and Sign out buttons; else when `gate` is
  `"in"` or `"onboarding"` but `ready` is false → `"shell"` (the existing "Setting up this device…"
  loading view, `components/AuthGate.tsx:359`); else today's rules. `ready` is true only when
  `readyFor === account.current.userId`. The disposition read still runs in parallel with
  adoption; only the rendering of children waits for both.
- `forget()` becomes `async`: `const previous = unbindAccount(); purgeAccountMemory();
  if (previous) await forgetAccount(previous, { keep: nextUserId });` then the existing lines
  (`clearCachedDisposition`, `setBlocked(false)`, `setGate("unknown")`; `clearFoodProjection` is
  removed — the store cache reset covers it). The sign-out path (`userId === null`) runs it through
  `runTransition` too.
- **`forgetAccount(previous, { keep })` touches only the previous account (audit plan r2
  finding 5).** It deletes only the listed cache keys under the prefix `smc:u:<previous.userId>:`
  and deletes no database. `keep` names the account about to bind; a key or cache of `keep` is
  never touched.
- The D1 eaten migration call and its helpers are removed (Task 9 rule 9).
- Sign out (`:350`): on tap, `const w = await pendingWork(userId)`; `n` = the sum of its counts
  (`"unknown"` → show "Some changes may not be synced yet. They stay on this phone."); if `n > 0` show
  "`${n} changes are not synced yet. They stay on this phone and send when you sign in again.`"
  with a second "Sign out" button that calls `signOut()`; else call `signOut()` at once. An
  account switch without sign-out runs the same purge with no notice.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/device/forget.test.ts
// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { forgetAccount, pendingWork, touchAccount, DEVICE_ACCOUNTS_KEY } from "@/lib/device/forget";
import { addExtra, loadStore } from "@/lib/store";
import { purgeAccountMemory } from "@/lib/device/purge";
import { runTransition } from "@/lib/device/transition";
import type { AccountHandle } from "@/lib/device/account";
import { allOps, appendOp, closeAllAccountDbs, accountDbName, putMeta } from "@/lib/sync/idb";
import { PENDING_LOG_KEY } from "@/lib/log/pending";
import { PENDING_WEIGH_INS_KEY } from "@/lib/health/weigh-in-client";
import { PENDING_TARGET_REVISIONS_KEY } from "@/lib/targets/client";
import { writeAccountItem } from "@/lib/device/account-storage";

const ids = ["1", "2", "3", "4", "5"].map((n) => `${n.repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
const dbNames = async () => (await indexedDB.databases()).map((d) => d.name);
const op = (id: string) => ({ op_id: id, entity: "water_log" as const, entity_id: "2026-09-22",
  kind: "update" as const, base_rev: 1, payload: { cups: 1 }, client_ts: "2026-09-22T08:00:00Z" });

beforeEach(async () => { await closeAllAccountDbs(); unbindAccount(); localStorage.clear(); globalThis.indexedDB = new IDBFactory(); });

describe("forget", () => {
  it("deletes only re-fetchable caches; keeps DB, store, drafts, scans and coach-action marks", async () => {
    const a = bindAccount(ids[0]); touchAccount(ids[0], 1);
    for (const k of ["expenditure", "health_daily", "proposals", "food-refs", "coach:t1"]) writeAccountItem(a, k, "x");
    for (const k of ["draft:d1", "pending_scans", "coach-action:x1", "store"]) writeAccountItem(a, k, "keep");
    await appendOp(a, op("o1"));
    await forgetAccount(unbindAccount()!);
    for (const k of ["expenditure", "health_daily", "proposals", "food-refs", "coach:t1"]) {
      expect(localStorage.getItem(`smc:u:${ids[0]}:${k}`)).toBeNull();
    }
    for (const k of ["draft:d1", "pending_scans", "coach-action:x1", "store"]) {
      expect(localStorage.getItem(`smc:u:${ids[0]}:${k}`)).toBe("keep");
    }
    expect(await dbNames()).toContain(accountDbName(ids[0]));
  });

  it("keeps a label-typed meal that lives only in the store, with an empty outbox (audit plan r3 finding 1)", async () => {
    const a = bindAccount(ids[0]); touchAccount(ids[0], 1);
    addExtra("2026-09-22", { id: "x1", name: "Label meal", kcal: 400 } as never);   // store only, no op
    expect(await allOps(a)).toEqual([]);
    await forgetAccount(unbindAccount()!);
    purgeAccountMemory();
    bindAccount(ids[1]); await forgetAccount(unbindAccount()!);            // a switch through B
    bindAccount(ids[0]);
    expect(loadStore().days["2026-09-22"]?.extras?.map((e) => e.id)).toEqual(["x1"]);
  });

  it("deletes no account database, even with five accounts on the phone", async () => {
    for (let i = 0; i < 5; i++) {
      const h = bindAccount(ids[i]); touchAccount(ids[i], i);
      await appendOp(h, op(`o${i}`));
      const { deleteOp } = await import("@/lib/sync/idb"); await deleteOp(h, `o${i}`);   // empty outbox
      await forgetAccount(unbindAccount()!);
    }
    const names = await dbNames();
    for (const id of ids) expect(names).toContain(accountDbName(id));
    expect(JSON.parse(localStorage.getItem(DEVICE_ACCOUNTS_KEY)!)).toHaveLength(5);
  });

  it("a quick return to A waits for A's cleanup; A's new op survives (audit plan r2 finding 5)", async () => {
    const a = bindAccount(ids[0]); touchAccount(ids[0], 1);
    await appendOp(a, op("o1"));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const leaving = runTransition(async () => {
      await forgetAccount(unbindAccount()!, { beforeClose: () => gate });  // pause inside the cleanup
    });
    let a2: AccountHandle | null = null;
    const returning = runTransition(async () => { a2 = bindAccount(ids[0]); });
    await Promise.resolve();
    expect(a2).toBeNull();                             // A is not bound while its cleanup runs
    release();
    await leaving; await returning;
    await appendOp(a2!, op("o2"));
    expect((await allOps(a2!)).map((o) => o.op_id)).toEqual(["o1", "o2"]);
  });

  it("forgetting A never touches B's keys or database", async () => {
    const b = bindAccount(ids[1]); touchAccount(ids[1], 2); writeAccountItem(b, "expenditure", "b");
    await appendOp(b, op("ob"));
    unbindAccount();
    bindAccount(ids[0]); touchAccount(ids[0], 1);
    await forgetAccount(unbindAccount()!, { keep: ids[1] });
    expect(await dbNames()).toContain(accountDbName(ids[1]));
    expect(localStorage.getItem(`smc:u:${ids[1]}:expenditure`)).toBe("b");
  });

  it("pendingWork counts each kind for the sign-out notice, and answers unknown when unreadable", async () => {
    const a = bindAccount(ids[0]); touchAccount(ids[0], 1);
    await appendOp(a, op("o1"));
    await putMeta(a, PENDING_LOG_KEY, [{ entryId: "e1" }]);
    await putMeta(a, PENDING_WEIGH_INS_KEY, [{ userId: ids[0] }]);
    await putMeta(a, PENDING_TARGET_REVISIONS_KEY, [{ ownerId: ids[0] }]);
    writeAccountItem(a, "draft:d1", "x");
    await closeAllAccountDbs(); unbindAccount();
    expect(await pendingWork(ids[0])).toMatchObject({ ops: 1, logRecords: 1, weighIns: 1, targetRevisions: 1, drafts: 1 });
    const real = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, "open").mockImplementation((name, v) => {
      if (name === accountDbName(ids[0])) throw new Error("blocked");
      return real(name, v);
    });
    expect(await pendingWork(ids[0])).toBe("unknown");
    vi.restoreAllMocks();
  });
});
```

(`addExtra`, `loadStore` from `@/lib/store`; `purgeAccountMemory` from `@/lib/device/purge`.)

Add to `tests/onboarding/auth-gate.test.tsx` (it already drives the real gate with a fake
`browserClient`; follow its session helpers):
- a session for A then a session for B: `unbindAccount` ran (A's handle is stale), `forgetAccount`
  was called with A's handle, `bindAccount(B)` happened, `markAccountReady` fires only after
  `adoptLegacyDevice` resolves (mock it with a deferred promise);
- **fast disposition, slow adoption** (audit plan r2 finding 3): the onboarding read answers
  `"none"` at once while `adoptLegacyDevice` is a pending deferred promise → the gate renders the
  "Setting up this device…" shell and **no child**; resolve the deferred → children render;
- the gate never calls an eaten-tick migration (audit plan r3 finding 2);
- `adoptLegacyDevice` rejects twice with a non-`AccountChanged` error: `markAccountReady` is never
  called, the gate renders "This phone could not finish the update." with Retry, and Retry runs
  adoption again; a success on retry marks ready and renders the children;
- Sign out with 2 queued ops shows the notice text and does not call `signOut` until the second
  tap; with 0 ops it calls `signOut` at once.

- [ ] **Step 2: Run and see them fail** — `pnpm exec vitest run tests/device/forget.test.ts tests/onboarding/auth-gate.test.tsx components/AuthGate.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** `lib/device/forget.ts` and the `AuthGate` changes. Update the `vi.mock` lines in `components/AuthGate.test.tsx:35-39` for the new imports (`@/lib/device/account` is real; mock `@/lib/device/legacy-adoption` and `@/lib/device/forget`).
- [ ] **Step 4: Run and see them pass** — same command. Expected: PASS.
- [ ] **Step 5: Commit** — `git add lib components tests && git commit -m "fix: bind, adopt and ready on sign-in; purge caches on sign-out or switch"`

---

### Task 10a: Service worker v3 reloads old tabs (audit plan r2 finding 1)

**Files:** Modify `public/sw.js:22` (`CACHE_VERSION = "v3"`) and `:44-51` (`activate`); Test
`tests/sw/sw-reload.test.ts` (same loading pattern as `tests/sw/sw-api-offline.test.ts`).

`activate` becomes: delete other caches → `self.clients.claim()` → for each
`await self.clients.matchAll({ type: "window" })` client, `client.navigate(client.url)` (catch and
ignore a rejection per client: a client that cannot navigate reloads at its next open).

- [ ] **Step 1: Failing test** — load `public/sw.js` into a fake `self` with `caches`, `clients`
  and `addEventListener` stubs; fire `activate`; expect `CACHE_VERSION` `v3` (the cache
  `sasha-shell-v3` is kept, `sasha-shell-v2` deleted), `clients.claim` called, then `navigate`
  called once per window client with its own URL, and a rejecting `navigate` does not stop the
  others.
- [ ] **Step 2:** `pnpm exec vitest run tests/sw/sw-reload.test.ts` — FAIL.
- [ ] **Step 3:** implement. **Step 4:** PASS. **Step 5:** commit `fix: new service worker reloads old tabs into the new build`.

Slice 6 bumps `CACHE_VERSION` again (to `v4`) for its own gate.

---

### Task 11: The end-to-end isolation test and the PR

**Files:** `tests/sync/account-isolation.test.ts` (add the spec 0.8 headline case).

- [ ] **Step 1: Write the test**

```ts
it("A's offline plan_days op and coach transcript never reach B; A's op sends as A later", async () => {
  const pushed: { user: string; ops: { user_id?: string }[] }[] = [];
  const server = (user: string) => vi.fn(async (url: string, init: RequestInit) => {
    if (String(url).startsWith("/api/sync/changes")) {
      return new Response(JSON.stringify({ changes: [], next_cursor: 0, has_more: false }));
    }
    const body = JSON.parse(String(init.body));
    pushed.push({ user, ops: body.ops });
    return new Response(JSON.stringify({ results: body.ops.map((o: { op_id: string }) =>
      ({ op_id: o.op_id, status: "applied", rev: 1, seq: 1 })), server_time: new Date().toISOString() }));
  }) as unknown as typeof fetch;

  const a = bindAccount(A);
  await savePlanDayOffline(a, "2026-09-22");           // helper: queues a plan_days op via lib/plan-day-client
  writeCache(a, "thread-1", { messages: [{ role: "user", text: "A only" } as never], actions: [] });

  unbindAccount(); purgeAccountMemory();
  const b = bindAccount(B);
  await syncOnce(b, { fetchFn: server(B) });
  expect(pushed.filter((p) => p.user === B).flatMap((p) => p.ops)).toEqual([]);
  expect(await allRows(b, "plan_days")).toEqual([]);
  expect(readCache(b, "thread-1").messages).toEqual([]);
  expect(Object.keys(loadStore().days)).toEqual([]);

  unbindAccount(); purgeAccountMemory();
  const a2 = bindAccount(A);
  await syncOnce(a2, { fetchFn: server(A) });
  const sent = pushed.filter((p) => p.user === A).flatMap((p) => p.ops);
  expect(sent).toHaveLength(1);
  expect(sent[0].user_id).toBe(A);
});
```

`savePlanDayOffline` is a local helper in the test file that calls the public writer in
`lib/plan-day-client.ts` (for example the eaten-slot save used by Today) with a `fetch` that
rejects, so the op stays queued.

- [ ] **Step 2: Run** — `pnpm exec vitest run tests/sync/account-isolation.test.ts` — Expected: PASS (all earlier tasks in place). If it fails, the failure names the leaking path; fix it in the owning task's file.
- [ ] **Step 3: Fast gates and the targeted set**

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm exec vitest run --changed origin/main
```
Expected: all clean. Do **not** run `pnpm test` or `pnpm test:integration`.

- [ ] **Step 4: Commit and open the PR (unmerged)**

```bash
git add tests
git commit -m "test: shared-phone isolation end to end"
git push -u origin fix/p9-device-state-isolation
gh pr create --base main --title "fix: device-state isolation on a shared phone (Phase 9 slice 1)" \
  --body-file /tmp/p9-slice1-pr.md
```

The PR body holds: summary; the list of plan decisions P1–P6 (README); the note that ops without
`user_id` (old builds) are refused with `error: account_unbound`, which an old build parks and
keeps, and the residual-risk paragraph from Global Constraints; "Preview test steps" and "Rollback" below; the
human steps; the test plan (the test files of this slice). Then save the independent review to
`docs/audit/code/<date>-p9-slice-1-gpt6-sol.md` (contract task 7). Do not merge.

---

## Preview test steps (Devin and Sasha, on the Vercel preview of this PR)

Use two accounts Devin controls: Sasha's test account (T) and Devin's own (D). Use one phone or one
desktop browser profile. Do not use Sasha's real account on the preview.

1. Open the preview URL. Sign in as T. Log one water cup and one food on Today. Open Coach and send
   one message.
2. Turn on airplane mode (or DevTools → Network → Offline). Log a second water cup as T. Settings →
   Sync shows "1 change waiting" (or similar pending count).
3. Turn the network back on **but do not wait**: at once open `/sign-in` and sign in as D (same
   browser).
4. As D: Today shows no cups and no food from T; Coach shows no T messages; Settings → Sync pending
   count is 0. In DevTools → Application → IndexedDB there are databases `smc-u-<T id>` and
   `smc-u-<D id>`; `smc-u-<D id>` → `outbox` is empty.
5. Sign out (from the "Connect once" screen if shown, or clear the session), then sign in as T again.
   Within one minute, Settings → Sync pending is 0 and the second cup appears on Today. In the
   Supabase preview branch table editor (`water_log`), T's row has 2 cups; D has no row for that
   date.
6. Held legacy line (only if you tested the old build on this browser before): Settings → Sync
   shows "N changes from before the update are held on this phone." and no button.
7. Two tabs on the **same preview URL** (same origin, so one cookie jar, one IndexedDB, one
   localStorage; audit plan r1 finding 11). Tab 1: sign in as T, open DevTools → Network, go
   offline in tab 1 only (DevTools throttling applies per tab) and log one water cup. Tab 2: sign
   in as D. Tab 1: go back online and tap the water button once more.
   Expected, one of two safe outcomes:
   - tab 1 picked up the session change (Supabase broadcasts it to other tabs) and now shows D's
     empty day — T's cups are not shown; or
   - tab 1 still shows T and its next `/api/` request in the Network panel answers
     `409 account_mismatch` (request header `x-smc-account` = T's id, cookie = D).
   In both cases: DevTools → Application → IndexedDB → `smc-u-<T id>` → `outbox` still holds T's
   queued cup, and D's `water_log` row on the branch has no cup from tab 1. Sign in as T again:
   the queued cup arrives under T.

8. Export in two tabs (audit plan r2 finding 6): tab 1 as T on Settings → Export; tab 2 signs in
   as D; in tab 1 tap "Download meals CSV". Expected: no file downloads with D's meals. Either
   tab 1 has already switched to D's screen, or the Network panel shows `/api/export…` answered
   `409 account_mismatch` and no file is saved. Signed in as T in one tab only, the same button
   downloads T's CSV as before.
9. Fast sign-in (audit plan r2 finding 3): sign out, sign in as T. The "Setting up this device…"
   screen shows until the device is ready; Today never flashes with empty or other data.

Pass = every "shows no … from T" is true, and T's queued cup arrives under T only.

## Rollback

- Code only: revert the merge commit of this PR and redeploy. No migration to undo.
- Device data after a rollback: the old build opens `smc` again. Per-account databases
  (`smc-u-*`) stay on phones unused; they are harmless and the next forward deploy reuses them.
  Rows adopted from `smc` were copied, not moved, so the old build still has them. Held legacy ops
  are still in `smc` and the old build will send them as today (this is the pre-slice behavior).
- Server: the `requireUser` header check and the per-op check leave with the revert.

## Human steps for Devin (this slice)

1. **Before this PR deploys to production:** ask Sasha to open the app online once, so her old
   outbox drains under the old build (spec 0.6, Open for Devin 3). Check it: Settings → Sync shows
   0 pending on her phone.
2. **Right after the deploy:** ask Sasha to close the app fully and open it again (online). This is
   a navigation, so the new service worker installs and reloads any old tab (Task 10a). Until
   then, a change made in an old tab is refused with `account_unbound`, parked, and later held on
   the phone (not lost, not sent; see Global Constraints, residual risk).
3. Run the Preview test steps above with T and D, and ask Sasha to check her own account on the
   preview only after step 1 of this list.
4. Review and merge the PR (the run never merges).
