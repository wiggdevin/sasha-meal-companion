# Coach Undo: immutable receipts (t25 option B)

Date: 2026-10-06. Revision 4. Owner: Devin.
Status: spec only. Nothing here is built and no migration is applied. Base: `main` at d52d2ef
(PR #436), which carries PR #419's paging.

**Revision 4** applies the round-3 check (one BLOCK, one WARN). A one-date slot op sends the
whole `plan_days` row, and a conflict rebase can carry another slot's stale override with it. A
slot receipt is now issued only when the server proves the op changed nothing but the stamped slot
(§3.3); any other difference leaves the action on today's phone-only Undo (status `other_change`).
The slot Undo also checks the `plan_days` revision (§4.2).

**Revision 3** applied option A of the post-round-2 re-plan (`undo-receipt-replan.final.md`):
a **one-write receipt v1**. Receipts cover three cases only — a `log_meal` create, a
`save_recipe` create and a single-date `set_slot_meal` — with exactly one op and one receipt per
action. Every other kind, and every multi-date slot change, stays on today's path. Receipt
records are created fresh and never attached to a legacy record. An immutable `record_mode`
decides the Undo path. Both legacy closing endpoints refuse receipt records. Legacy `save_recipe`
server Undo becomes phone-only. The writer ships last, and rollback keeps the receipt-aware
function. Revisions 1 and 2 failed review; §11 records every finding.

**Why.** Three review rounds of `feat/undo-followups` (t25r1, t25r2) failed for one reason: the
server tied an Undo record to its card by weaker evidence than the write itself — a recipe by its
name, a slot by a guess, a card by its index. The re-plan (`t25-replan.md`, option B) asks for one
fix: record exactly what a coach write applied, in the write's own transaction, and decide that
record's Undo from it only. Two spec rounds then showed that "one coach action" is not always
"one reversible write" (a slot series writes up to 31 times; list marks can also write a note or a
food role). v1 therefore covers only the actions that are one write.

**What this spec closes.**

| Re-plan defect | Closed by |
|---|---|
| 1. Wrong source binding: an Eggs idea recorded against a beef slot write; a same-name recipe undone | §3.4 checks the persisted foods against the source; §4 undoes only the receipt's own row, checked by identity; §5 makes legacy recipe server Undo phone-only |
| 2. Missing legacy card: a valid older record drew no card when two cards matched | §5: every legacy record gets a generic card, never one inferred from messages |
| 3. Partial "complete" list | Fixed on `main` by PR #419. The receipt read is all-or-nothing too (§6.4). |

---

## 1. Terms

- **Coach write.** The one sync op a receipt-kind action writes: the log commit
  (`/api/log/commit`) or an op in `/api/sync/ops`. Both end in `apply_sync_op`.
- **Stamp.** A small `coach` object the phone puts on that op. It names the action. It never
  describes what was written.
- **Receipt.** One `coach_action_receipts` row, written in the same transaction as the op, from
  the rows the op changed. It is never updated.
- **Record.** A `coach_action_undos` row. Its immutable `record_mode` is `receipt_v1` (made with
  a receipt, §3.5) or `legacy` (every other record, today's path).

## 2. Scope

| Action | v1 path |
|---|---|
| `log_meal` (entry create) | receipt |
| `save_recipe` (recipe create) | receipt |
| `set_slot_meal` writing **one** date (an issued action with one date, or a card's or idea's "Put it in …") | receipt |
| `set_slot_meal` writing two or more dates | legacy, phone-only Undo, as today |
| `skip_slot`, `restore_slot`, `log_water`, all four food-list marks | legacy, as today |
| every other kind | legacy, as today |

`ReceiptKind = "log_meal" | "save_recipe" | "set_slot_meal"`. Each receipt action writes exactly
one op and has exactly one receipt.

Excluded on purpose: a slot series writes once per date (`lib/coach/apply-slot.ts:89`); a removal
mark writes a food note (`lib/coach/apply-prefs.ts:77`); an add mark can write a food role
(`lib/coach/apply-prefs.ts:96`); a skip or restore is a transform the source check cannot match
by foods. Receipts for them are follow-ups (§9).

In scope for the UI lane: a legacy record must show as a generic "Coach change" card on a device
that does not hold its token (§6.5, test U1). Out of scope: paging (PR #419) and the Undo copy on
the phone that holds the token.

## 3. Writing a receipt

### 3.1 The stamp

`SyncOpSchema` (`lib/sync/types.ts`) and the log commit request gain one optional field:

```ts
type CoachStamp =
  | { actionId: string; kind: ReceiptKind; source?: CoachActionSource; threadId?: string }
  | { undoOf: string };            // the phone's own Undo of a receipt action (§4.4)

type CoachActionSource =           // kept from feat/undo-followups
  | { messageId: string; cardIndex: number }                  // composed card
  | { messageId: string; blockId: string; ideaIndex: number } // food_ideas idea
```

There is no `part` or `parts`. The apply bindings pass the stamp to the one write each makes:
`commitLogEntry` (`lib/coach/apply-log.ts`), `saveRecipe` (`lib/coach/apply-entries.ts`) and
`saveMealEdit` (`lib/coach/apply-slot.ts`, only when `dates.length === 1`). A queued op keeps its
stamp in the outbox. For these actions the new client stops calling `startRecording`
(`lib/coach/undo-client.ts`): the stamped op makes the record.

### 3.2 Allowed entity and op kind

`apply_coach_op` validates the stamp before it takes any lock. Anything else is applied as an
ordinary op through `apply_sync_op`, writes no receipt, and answers `receipt.status = "refused"`.

| Stamp | Entity | Op kind | Target key |
|---|---|---|---|
| `log_meal` | `log_entries` | `create` | entry id |
| `save_recipe` | `recipes` | `create` | recipe id |
| `set_slot_meal` | `plan_days` | `create` or `update` | the one local date; the slot is the stamped action's (§3.4); the op may change that slot only (§3.3) |
| `undoOf` a `log_meal` / `save_recipe` | `log_entries` / `recipes` | `delete` | the receipt's entity id |
| `undoOf` a `set_slot_meal` | `plan_days` | `update` | the receipt's date |

### 3.3 Proof that the op changed the row

`applied` alone is not proof (`apply_sync_op` answers `applied` for a `restore` of a live row
without writing). A receipt is written only when all of these hold inside the transaction:

- a `change_log` row with this `op_id` and `user_id` exists after the call (the duplicate check
  runs first, so it did not exist before);
- the row's `rev` advanced: absent before and 1 after for a create, or `before.rev + 1`;
- for `plan_days`, the stamped slot's state (`_coach_undo_slot_state`) differs before and after;
- for `plan_days`, **the op changed nothing except the stamped slot.** The server compares the
  full row before and after: every other slot's `item_overrides` entry, `eaten_slots`,
  `slot_notes`, `swaps`, `day_type_override`, `floor_day`, `day_complete_at` and every other
  column, except `rev` and `updated_at`. For a create, "before" is the row the defaults would give
  (no overrides, no marks, no notes).

Why: the phone sends the whole `plan_days` row (`lib/plan-day-client.ts:83`), and a conflict
rebase can keep the phone's entire override map (`lib/sync/merge.ts:129`), which the server then
writes whole (`supabase/migrations/20261026090000_plan_days_eaten_slots.sql:137`). A stale phone
can so overwrite another device's edit to a second slot. A receipt that restores one slot would
leave that overwrite in place and still report the Undo complete.

If the stamped slot changed but anything else did too, the op stays applied, no receipt and no
record are written, and `apply_coach_op` answers `receipt.status = "other_change"`. The phone then
records the action as today (`startRecording`, a legacy record, `serverUndoable: false` for
`set_slot_meal`): phone-only Undo through its token, and a generic card on other devices.

A replay (`duplicate`) returns only its own existing receipt (`receipt.status = "existing"`); a
replay of an unstamped first apply creates none. A conflict, `gone`, `deleted` or error writes
none.

### 3.4 Source check on the persisted foods

The server finds the source in the caller's own coach messages and compares it with what the op
persisted, never with the stamp.

| Source | Found by | Must also hold |
|---|---|---|
| issued action (no `source`) | `tool_calls.actions[]` with this `actionId` and `kind` | — |
| composed card | `tool_calls.composed[cardIndex]` | the kind is a button the card offers (`composedButtons`) |
| food idea | `tool_calls.blocks[]` with `kind = 'food_ideas'` and this `id`, then `ideas[ideaIndex]` | the kind is a button the idea offers |

| Kind | Persisted content | Compared with the source's |
|---|---|---|
| `log_meal` | date; slot; the sorted `(food_ref_id, grams)` pairs of the stored `log_items` | date, slot (`snack` for a card's Log it), sorted `(foodRefId, grams)` items |
| `save_recipe` | the sorted `(food_ref_id, grams)` pairs of the new revision's `recipe_items` | sorted `(foodRefId, grams)` items (the name is shown, never compared) |
| `set_slot_meal` | the written slot, the date, and the sorted `(name, grams)` pairs of its components | the exact offered slot (a card's `composedButtons` slots; an issued action's `slot`), the one date (an issued action's single date), and sorted `(name, grams)` items |

Plan overrides store components (`name`, `qty`, `unit`, `role`, `macros`) and no food ref, so a
slot's food identity is the component, and the write's identity is its `mutationId`.

`source_check` is `match`, `mismatch` (found, but the persisted foods, slot or date differ) or
`none` (no message of the caller's carries it). On `mismatch` or `none` the receipt still holds the
actual write, the card shows its actual foods, and server Undo is refused (§4.5). The write itself
is never refused: it is the person's own local-first write.

### 3.5 `apply_coach_op`

```sql
apply_coach_op(p_user_id uuid, p_op jsonb, p_coach jsonb) returns jsonb
-- security definer, set search_path = public
-- returns the OpResult apply_sync_op returns, plus
--   "receipt": { "id": uuid | null,
--                "status": "written" | "existing" | "none" | "refused" | "other_change" | "legacy" | "collision" | "closed" }
```

One transaction, in this order:

1. `perform _sync_assert_caller(p_user_id)`; validate the stamp (§3.2).
2. Take the target's advisory lock with ordinary sync's key:
   `pg_advisory_xact_lock(hashtextextended(user || ':' || entity || ':' || key, 0))`.
3. Read the **before** state, locking the target row (`for update`).
4. Apply through `apply_sync_op`. It re-takes the advisory lock it already holds (transaction
   advisory locks are re-entrant) and writes the locked row.
5. Read the **after** state and run the proof (§3.3). Without proof, stop: status `none`, or
   `other_change` when a slot op changed more than its slot.
6. Look up `(user_id, action_id)` in `coach_action_undos`:
   - a `legacy` record exists: write no receipt, leave its `inverse` and `bind` untouched, status
     `legacy`. The record keeps today's path and a generic card.
   - a `receipt_v1` record exists for another `op_id`: a second op reusing the action id. Write no
     receipt, status `collision`. The op itself stays applied, like any phone write.
   - none: run the source check (§3.4), insert the receipt, and insert a **fresh** record with
     `record_mode = 'receipt_v1'`, `inverse = '{}'`, `expected_rev = null`, `bind = '{}'`, the
     source's `message_id` and `thread_id` when `source_check = 'match'`. Status `written`.

For `undoOf`, step 6 instead runs §4.4.

**Lock order.** Every transaction that touches a target takes its advisory lock before its row
lock: ordinary sync (`apply_sync_op` locks, then writes), `apply_coach_op` (steps 2 then 3), and
`perform_coach_undo` (§4.3). So two of them on one target queue on the advisory lock while
holding no row lock of it. Ordinary sync never touches `coach_action_undos`. `perform_coach_undo`
takes the record row only after its one advisory lock, so it never holds a record row while it
waits on a target that `apply_coach_op` holds.

A failure while writing the receipt or the record raises and rolls back the op. The op answers
`error` and stays in the phone's outbox. Callers: `app/api/sync/ops/route.ts` (`applyOp`) and
`lib/server/log.ts` (`applyLogEntry`). An op without a stamp calls `apply_sync_op` as today.

### 3.6 Receipt bodies

`applied` holds what the server read, never what the stamp said.

| Kind | `applied` |
|---|---|
| `log_meal` | `{ entryId, date, slot, eatenAt, rev, title, items: [{ itemId, foodRefId, name, grams }] }` |
| `save_recipe` | `{ recipeId, rev, name, revisionId, items: [{ seq, foodRefId, name, grams }] }` |
| `set_slot_meal` | `{ date, slot, rev, before: Override \| null, after: Override }` |

`name` for a food is the catalog food's or account food's stored name, read through `food_refs`
at write time (null when it has none). `Override` is the slot's `item_overrides` entry as stored,
`mutationId` included.

## 4. Undo

### 4.1 Rule

`perform_coach_undo(p_undo_id uuid, p_local boolean default false)` keeps its signature and
answers. It branches on `record_mode`, never on whether a receipt happens to exist:

- `receipt_v1`: the record must have exactly one receipt with its `action_id` and `kind`
  (otherwise `undo_receipt_inconsistent`). The inverse is built from that receipt only;
  `inverse`, `expected_rev` and `bind` are never read. `p_local = true` is refused (§4.5).
- `legacy`: today's path from `20261210090300`, with two changes: the advisory lock is taken
  before the row locks (§4.3), and `save_recipe` is refused with `undo_local_only` (§5).

### 4.2 Checks (receipt records)

| Kind | Target | Must hold now | Inverse write (through `apply_sync_op`) |
|---|---|---|---|
| `log_meal` | `log_entries.id = entryId` | live; `rev`, date, slot, `eaten_at` equal the receipt; the `(itemId, foodRefId, grams)` set equals the receipt's | delete at that `rev` |
| `save_recipe` | `recipes.id = recipeId` | live; `rev` equals; the current revision is `revisionId` and its `(seq, foodRefId, grams)` list equals the receipt's | delete at that `rev`; `_sync_tombstone` also tombstones the recipe's `user_foods` twin (`supabase/migrations/20260919090300_phase3_sync_entities.sql:110`) |
| `set_slot_meal` | `plan_days(date)` | `rev` equals the receipt's after `rev` (else `undo_conflict`); `item_overrides[slot]` state equals `after`, `mutationId` included | put `before` back into that slot only, every other field as it stands (as today's skip Undo does) |

### 4.3 Lock order

1. Read the record and its receipt without locks (the receipt is immutable).
2. Take the target's advisory lock.
3. Lock the record row (`for update`); re-check it is open and unexpired.
4. Lock the target row; run §4.2.
5. Write the inverse and stamp `undone_at`.

A legacy record uses the same order with its one target. Today's function locked the rows first
and reached the advisory lock inside `apply_sync_op`.

### 4.4 The phone's own Undo

The phone uses its token only when the server certainly did not undo the action (today's rule in
`lib/coach/undo-client.ts`). For a receipt action, its inverse op carries `{ undoOf: actionId }`.
`apply_coach_op` closes the record only when all of these hold:

- the record is `receipt_v1` and open, and its receipt's target matches the op (§3.2);
- the op changed the row (§3.3);
- the before state of this op equals the receipt's **after** (the same identity checks as §4.2);
- the after state equals the receipt's **before**: the entry or recipe is deleted (a recipe's twin
  with it), or the slot's content equals `before` in every field but `mutationId`, which a restore
  writes fresh;
- for a slot, the inverse changed nothing but that slot (the same full-row comparison as §3.3).

Otherwise the op still applies and the record stays open (status `none`). The new client never
posts `record_coach_undo` or `{ local: true }` for a receipt action.

### 4.5 Refusals

| Code | HTTP | When | Copy |
|---|---|---|---|
| `undo_not_synced` | 409 | the target row is missing | "That change has not reached the server yet. Undo it on the phone that made it." |
| `undo_conflict` | 409 | the target's revision moved, or it was deleted | "That has changed since, so Undo left it alone." |
| `undo_receipt_mismatch` | 409 | the revision matches but the identity does not: other items or ingredients, another revision id, another `mutationId` | "That no longer matches what the coach changed, so Undo left it alone." |
| `undo_receipt_inconsistent` | 422 | a `receipt_v1` record without exactly one matching receipt | "This change can only be undone on the phone that made it." |
| `undo_source_mismatch` | 422 | the receipt's `source_check` is not `match` | same as above |
| `undo_receipt_record` | 409 | `p_local = true`, or `record_coach_undo(…, p_undone = true)`, against a `receipt_v1` record | "This was recorded by the server. Undo it from the list." |
| `undo_local_only` | 422 | a phone-only kind; a legacy `save_recipe`; a legacy record today's path refuses | "This change can only be undone on the phone that made it." |

A refusal writes nothing and leaves the record open.

## 5. Legacy records

Every record that is not `receipt_v1` is legacy: all records made before the cutover, every
excluded kind, multi-date slot changes, records an old cached build posts, and any action whose
legacy record existed before its stamped op arrived (§3.5 step 6).

- **Card.** A generic card (§6.5). The server never reads a message to infer one. The parked
  `legacyComposedMeal` logic is dropped.
- **Undo.** Today's path, unchanged, except:
  - **Legacy `save_recipe` server Undo becomes phone-only.** Its check is the recipe's name
    (`20261210090300_coach_action_undos.sql:365`), so it can delete another same-name recipe.
    `perform_coach_undo` refuses it with `undo_local_only`, and `isServerUndoable`
    (`lib/coach/undo-types.ts`) returns false for it. An old phone holding the token keeps its
    local Undo. This is the accepted compatibility trade-off.
- **Closing.** `record_coach_undo(…, p_undone = true)` and `perform_coach_undo(…, true)` keep
  closing legacy records as today. Both refuse a `receipt_v1` record (§4.5), so an old build can
  never mark one undone without a verified inverse.

**Ongoing compatibility cost.** The seven-day expiry retires only the legacy records that exist at
the cutover. A cached old build keeps posting legacy records and unstamped writes for as long as
it is in use: their cards stay generic on other devices and their Undo stays on today's path
(recipes phone-only). Nothing reports a client's build, so the cost is measured as the count of
new legacy records for receipt kinds.

## 6. Data model, tenancy, read, wire

### 6.1 `coach_action_receipts` (new)

```sql
create table coach_action_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_id text not null check (char_length(action_id) between 1 and 128),
  kind text not null check (kind in ('log_meal','save_recipe','set_slot_meal')),
  op_id uuid not null,
  entity text not null, entity_id text not null,
  source jsonb check (source is null or jsonb_typeof(source) = 'object'),
  source_check text not null check (source_check in ('match','mismatch','none')),
  applied jsonb not null check (jsonb_typeof(applied) = 'object'
                                and pg_column_size(applied) <= 32768),
  created_at timestamptz not null default now(),
  unique (user_id, op_id),
  unique (user_id, action_id)          -- one receipt per action
);
```

- No foreign key to `coach_messages` or `coach_threads`: their `on delete set null` would rewrite
  a receipt. The message id lives inside `source`, checked as the caller's own at write time.
- Immutable: a `before update` trigger raises `42501 receipt_immutable`. No delete trigger, so the
  account cascade works. Rows are kept while the account exists; the daily scrub
  (`scrub_coach_action_undos`) does not touch them.
- RLS: owner-only select (`user_id = (select auth.uid())`). `revoke all` from `public`, `anon` and
  `authenticated`, then `grant select` to `authenticated`. `service_role` gets select and insert
  only. The only writer is `apply_coach_op`.

### 6.2 `coach_action_undos` (changed)

- `record_mode text not null default 'legacy' check (record_mode in ('legacy','receipt_v1'))`.
  A constant default, so the `alter` is metadata-only. Immutable: a `before update of record_mode`
  trigger raises.
- `source jsonb` and `source_check text`, nullable, set only on `receipt_v1` records.
- A `receipt_v1` record keeps `inverse = '{}'` (the column stays `NOT NULL`), `expected_rev =
  null` and `bind = '{}'`. None of them authorizes an inverse: every function refuses a
  `receipt_v1` record on the legacy path.

### 6.3 Tenancy

`apply_coach_op` asserts the caller first and writes only `auth.uid()`'s rows. It joins
`tests/tenancy/rpc-ops.json` and the RPC matrix; `coach_action_receipts` joins the owner-table
checks. A stamp naming another account's message records `source_check = 'none'` and leaks
nothing.

### 6.4 Reading receipts for the list

`listUndos` reads a page of records as today, then the receipts of its `receipt_v1` records. At
one receipt per record a 500-record page reads at most 500 receipts, but the read still goes
through `lib/server/paged-read.ts` (`chunk` by `IN_CHUNK_SIZE`, then `fetchAllRows` ordered by
`id`). Any failed page fails the request with `500 undo_store_failed`; no card is returned from a
partial read. A `receipt_v1` record with no receipt in the read gets `card.complete = false` and
`serverUndoable = false`.

### 6.5 Wire: what the Undo list returns per record

`GET /api/coach/undo` keeps its paging (`{ undos, next }`, 500 a page). Each `CoachUndoView`
gains one required field:

```ts
type CoachUndoCard =
  | { type: "receipt";
      kind: ReceiptKind;
      title: string;                 // e.g. `Saved the recipe "Eggs on toast"`
      lines: { name: string | null; grams: number | null }[];
      date: string;
      slot: string | null;
      messageId: string | null;      // set only when source_check = 'match'
      sourceCheck: "match" | "mismatch" | "none";
      complete: boolean }            // the one receipt was read
  | { type: "generic";
      kind: string;
      title: "Coach change" };       // UI shows it with createdAt and the Undo state

type CoachUndoView = /* today's fields */ & { card: CoachUndoCard };
```

A pure `lib/coach/undo-receipt-card.ts` builds the receipt card from the receipt only, with
`slotName` and `itemLine` from `lib/coach/actions/copy.ts`. Titles: Logged {slot} on {date};
Saved the recipe "{name}"; Put {title or first food} in {slot} on {date}. Lines are the `after`
foods.

`serverUndoable` for a `receipt_v1` record is true only when it is open, unexpired, `complete`,
and `source_check = 'match'`. For a legacy record it is today's rule, with `save_recipe` false.

Cross-device: any device draws each record from `card`. The phone holding the token may still
draw its local card; for a receipt record both come from the same applied foods. A server Undo
removes a logged meal from every phone through `target` and `lib/coach/undo-projection.ts`; for a
`receipt_v1` record, `target` is read from the receipt.

## 7. Deploy and rollback

Each migration is one live-safe file with a down file, tested on a throwaway Postgres (down files
included) and applied to production after a backup, as in Phase 18 W2b.
The files are dated `20261216090000` on, after every migration already applied to production
(Phase 18 W4's `20261214100000`–`20261214100200` and `20261215090000_favor_food_families`); step 2
is two files (add `NOT VALID`, then validate).

| Step | What | Live-safe because |
|---|---|---|
| 1 | `20261216090000_coach_action_receipts.sql`: table, indexes, RLS, grants, immutability trigger | new, empty table |
| 2 | `20261216090100_coach_undo_record_mode.sql`: `record_mode`, `source`, `source_check` (checks `NOT VALID`), the `record_mode` trigger; `20261216090200_coach_undo_record_mode_validate.sql`: validate, `record_mode` `NOT NULL` | metadata-only `alter`; every row reads `legacy` |
| 3 | `20261216090300_coach_undo_legacy_guards.sql`: `record_coach_undo` refuses `p_undone` on a `receipt_v1` record; `perform_coach_undo`'s legacy body refuses `p_local` on one and makes `save_recipe` phone-only | no `receipt_v1` record exists yet; the only live change is the recipe refusal, mapped as `undo_local_only` |
| 4 | `20261216090400_perform_coach_undo_receipts.sql`: the receipt-aware `perform_coach_undo` (§4), guards kept | no `receipt_v1` record exists yet, so every call takes the legacy branch |
| 5 | Deploy PR A: error codes, `isServerUndoable` for recipes, the paged receipt read, cards, and the UI lane's generic card | reads only; nothing is stamped |
| 6 | `20261216090500_apply_coach_op.sql`: `apply_coach_op` and its helpers | a new function nothing calls yet |
| 7 | Deploy PR B, last: the phone's stamp, the end of `startRecording` for receipt actions, and the routes calling `apply_coach_op` | the reader and the receipt-aware Undo have been live since steps 4 and 5 |

**Rollback.**

1. Revert PR B. Stamping stops; no new `receipt_v1` record is made.
2. Optionally apply step 6's down file. Nothing calls `apply_coach_op` any more.
3. **Keep steps 3 and 4** until this query returns 0:
   `select count(*) from coach_action_undos where record_mode = 'receipt_v1' and expires_at > now();`
   Until then the receipt-aware function stays the only one that can undo those records.
4. After that, `perform_coach_undo` may be replaced only by a body that still refuses every
   `receipt_v1` record, and `record_coach_undo` keeps its guard. Never restore the unguarded
   `20261210090300` body, and never use `inverse` or `bind` to undo a receipt record.
5. Steps 1 and 2 stay; their tables and columns are harmless once nothing writes them.

### What the parked branch (`feat/undo-followups`) becomes

| Piece | Fate |
|---|---|
| `20261211090200_coach_undo_block_source.sql` (never applied) | **Drop.** Never apply it. |
| `lib/server/coach-undo-display.ts` (cards from messages, legacy inference) | **Drop.** Cards come from receipts (§6.5); legacy records are generic (§5). |
| `CoachActionSource` union, `chat-state.ts` `block` plumbing, food_ideas tap passing its source | **Keep**, now feeding the stamp. Also fix t25r1 #1: `food_ideas.tsx` and `CoachShell.tsx` must pass `block` and `source` into `applyAction`. |
| `set_slot_meal` token shape fix (t25r1 #2) | **Moot.** The receipt reads the slot from the write. |
| Paging changes | **Drop.** `main` has PR #419. |
| `tests/coach/undo-list-local.integration.test.ts` local-stack harness | **Keep the harness**, rewrite the cases for receipts. |
| `tests/migrations/coach-undo-sql.test.ts` additions | **Keep the harness**, replace the cases with §8's. |

## 8. Acceptance tests

Unit and SQL tests run in CI. The database cases run on the local Supabase stack
(`127.0.0.1:54321`/`54322`, the `localStack()` guard) and on the throwaway-Postgres harness
(`tests/migrations/coach-undo-sql.test.ts`). Their output is committed as
`docs/audit/<date>-coach-undo-receipt-db-proof.md`, like the C5 proof. A skipped run is not a
proof. PR #419's tests stay, including the 51-page completion and the missing-`next` failure in
`tests/coach/undo-client.test.ts`.

### 8.1 One test per review BLOCK

| Finding | Test |
|---|---|
| R1-1 no-op receipt | An applied stamped create has its `change_log` row and exactly one receipt. A replay returns the same receipt; a conflict, a stamped `restore` of a live row and a stamped slot update that leaves the stamped slot unchanged write none. Wrong entity or op kind answers `refused` and writes none. |
| R1-2 deadlock | 200 rounds each, `lock_timeout = 5s`: a stamped and an ordinary op on one target started together; a stamped op against `perform_coach_undo` on the same action. No `40P01`, no timeout; every outcome is a commit or a documented refusal. |
| R1-3 early multi-part closure | The schema has no `part`; `unique (user_id, action_id)` refuses a second receipt (forged insert as `service_role`). A second stamped op with the same action id answers `collision`. A multi-date `set_slot_meal` sends no stamp and makes no receipt. An `undoOf` closes the record only after §4.4's checks; one that writes another target, or a state other than `before`, closes nothing. |
| R1-4 incompatible migration | Run each step of §7 in order on the harness. After steps 3–4, a record from today's client undoes through the legacy path as on `main` (existing `coach-undo-sql` cases pass, except the recipe case, now `undo_local_only`). A `receipt_v1` record has `inverse = '{}'` and never reaches the legacy path. Rollback steps 1–3 leave the receipt-aware function in place and receipt records undoable. |
| R1-5 partial receipt read | A 500-record page with 500 receipts lists 500 complete cards. With the receipt read forced to fail, the route answers 500 `undo_store_failed` and returns no cards. |
| R1-6 inconsistent parts | A forged second receipt is refused by the unique key. A `receipt_v1` record whose receipt has another kind (forged by `service_role` with the trigger disabled in the harness only) answers `undo_receipt_inconsistent` and writes nothing. |
| R1-7 removal note | A stamp of any list-mark kind answers `refused`. The marks' apply and phone Undo keep their note behavior (existing tests unchanged). |
| R2-1 unverified legacy closure | Against an open `receipt_v1` record, as an old client: `perform_coach_undo(id, true)` and `record_coach_undo(…, p_undone = true)` both refuse with `undo_receipt_record`; `undone_at` stays null. Against a legacy record both still close it. |
| R2-2 attachment and rollback | Create a legacy record, then send a stamped op with its action id. Zero receipts; the legacy `inverse` and `bind` are byte-equal before and after; status `legacy`; generic card. With rollback steps 1–3 applied, no function call reads `inverse` of a `receipt_v1` record (asserted by a refusal on every legacy entry point). |
| R2-3 food role | A role-confirming `add_to_eats` sends no stamp; a forged stamp answers `refused`; membership and role writes and their Undo stay on today's path. |
| R2-4 skip/restore source | Forged `skip_slot` and `restore_slot` stamps answer `refused`. Their apply and Undo paths are unchanged. |
| R3-1 slot op changes another slot | Two devices on one date. Device B edits `meal-2` and syncs. Stale device A sends a stamped one-date `set_slot_meal` for `meal-1`; its conflict rebase also replaces `meal-2`. The op applies with `receipt.status = "other_change"`: no receipt, no `receipt_v1` record. A's legacy record is phone-only (server Undo answers 422 `undo_local_only`) and lists as a generic card on B. No Undo, server or `undoOf`, writes `meal-2`. Variants: a stale `eaten_slots` or `slot_notes` change gives the same result; a clean one-date op gives `written`. |
| R3-2 slot revision | A matched slot receipt; a later write to another slot of the same date moves the `plan_days` `rev`. Server Undo answers 409 `undo_conflict` and writes nothing. |

### 8.2 End-to-end database cases

- E1 **Eggs source → beef slot.** A saved food idea holds eggs. A stamped single-date
  `set_slot_meal` names it and writes beef. The op applies; the receipt holds beef with
  `source_check = 'mismatch'`; the card shows beef lines and no `messageId`; server Undo answers
  422 `undo_source_mismatch`; the slot still holds beef.
- E2 **Two same-name recipes, different ingredients.** Recipes A and B are both named "Eggs". A
  stamped `save_recipe` writes B under an action whose source holds A's ingredients: receipt holds
  B, `mismatch`, Undo refused. Separately, a legacy `save_recipe` record naming "Eggs" answers
  `undo_local_only`. A and B are live after both.
- E3 **Changed recipe at the same revision.** The receipt holds recipe A. A's `recipe_items` are
  changed at the same `rev` by a `service_role` edit. Undo answers 409 `undo_receipt_mismatch`;
  A and its `user_foods` twin are live.
- E4 **Later slot `mutationId`.** The receipt holds `meal-3` on date D. A later edit gives
  `meal-3` another `mutationId` with the same foods. Undo answers 409 `undo_receipt_mismatch`;
  `meal-2` and `meal-3` are untouched.
- E5 **Recipe delete takes its twin.** A matched `save_recipe` receipt is undone. The recipe and
  its `user_foods` twin are tombstoned in the same transaction, with a `change_log` row for each;
  a phone `undoOf` closes the record only when both are deleted.

### 8.3 Cross-device UI case

- U1 The t25r2 arrangement: card A offers `meal-3`; card B defaults to `meal-2` and has `meal-3`
  pending. A legacy `set_slot_meal` record with `bind.slot = meal-3` made on device 1 appears on
  device 2 exactly once, as "Coach change", with no Eggs card and no card guessed from either
  message (component test on the Undo list, fed by the real `listUndos` output).

### 8.4 Other properties

- P1 Same transaction: force the receipt insert to fail; the op answers `error` and its row is
  unchanged.
- P2 Immutable: `update` and `delete` on a receipt fail for `authenticated` and `service_role`;
  `update` of `record_mode` fails.
- P3 Unstamped ops call `apply_sync_op` exactly as today (existing sync tests pass unchanged).
- T1 User B cannot select A's receipts; `apply_coach_op` with another `p_user_id` raises 42501.
- T2 A stamp naming B's message records `source_check = 'none'`; no B message id reaches A.

## 9. Follow-ups (not in this spec)

- Receipts for multi-date slot changes, with per-date closure.
- Receipts that also cover a food note or role write, for the list marks.
- Receipts for skip and restore, checked against the skip and restore transforms.
- Receipts for the remaining kinds (slot items, moves, deletes, water, weight, profile, targets,
  shopping).

## 10. Questions resolved

| Question | Decision and reason |
|---|---|
| How can a receipt share a transaction with a local-first phone write? | The stamp rides on the sync op, and `apply_coach_op` writes the receipt inside the RPC call that applies it. |
| Which actions get receipts? | Only those that are exactly one write: entry create, recipe create, one-date slot change (re-plan A). |
| Refuse a write whose source check fails? | No. It is the person's own write. The receipt records the truth and server Undo refuses it. |
| What proves an op wrote something? | Its own `change_log` row plus an advanced `rev`, and for a slot a changed slot state. |
| Attach a receipt to an existing legacy record? | Never. That record keeps today's path; its `inverse` and `bind` stay untouched. |
| How does Undo pick its path? | By the immutable `record_mode`, not by whether a receipt exists. |
| What stops an old build closing a receipt record? | Both legacy closing endpoints refuse `receipt_v1` records. |
| Keep legacy `save_recipe` server Undo? | No. Its name-only check can delete another same-name recipe. The token's phone keeps local Undo. |
| What does rollback keep? | The guards and the receipt-aware function, until no unexpired receipt record remains. |

## 11. Review history

**Round 1** (GPT-6 Sol, `undo-receipt-spec-r1.final.md`): FAIL.

| Finding | Revision 2 | Revision 3 (re-plan A) |
|---|---|---|
| BLOCK 1 a receipt could describe an op that wrote nothing | proof of change, allowed entity/op table | kept, narrowed to three op shapes (§3.2, §3.3); test R1-1 |
| BLOCK 2 row lock before advisory lock could deadlock | advisory lock first everywhere | kept with one target per transaction (§3.5, §4.3); test R1-2 |
| BLOCK 3 multi-part record closed early | per-part closure | **removed by scope**: one write per action; `undoOf` verified after → before (§4.4); test R1-3 |
| BLOCK 4 migration order exposed an incompatible Undo | receipt-aware Undo first, writer filled `inverse` | guards and receipt-aware Undo first, writer last, `inverse = '{}'`, rollback keeps the function (§7); test R1-4 |
| BLOCK 5 receipt read could be partial | paged read | kept (§6.4); test R1-5 |
| BLOCK 6 multi-part consistency | whole-set validation | **removed by scope**: one receipt per action, unique key (§6.1); test R1-6 |
| BLOCK 7 removal marks write a note | removal marks phone-only | all list marks excluded (§2); test R1-7 |
| WARN 8 old builds keep making legacy records | cost stated | kept (§5) |

**Round 2** (GPT-6 Sol, `undo-receipt-spec-r2.final.md`): FAIL. Round 1 #1, #2, #5, #6, #7 were
accepted; #3 and #4 were still open. Under the two-round cap, Sol re-planned
(`undo-receipt-replan.final.md`) and option A was decided.

| Finding | Revision 3 |
|---|---|
| BLOCK 1 `local:true` and `record_coach_undo(p_undone)` close a record without a verified inverse | both refuse every `receipt_v1` record (§4.5, §5, §7 step 3); test R2-1 |
| BLOCK 2 attaching to a legacy record made rollback unsafe | never attach; fresh `receipt_v1` records; rollback keeps the receipt-aware function (§3.5, §7); test R2-2 |
| BLOCK 3 a note-free add mark can still write a food role | all list marks excluded (§2); test R2-3 |
| BLOCK 4 skip/restore could match their source while writing another meal | skip and restore excluded (§2); test R2-4 |
| WARN 5 parts compared source verdicts, not source identity | **removed by scope**: one receipt per action |

**Round 3** (GPT-6 Sol, scoped check, `undo-receipt-spec-r3.final.md`): FAIL. All eleven earlier
BLOCKs confirmed dispositioned; the three revision-3 decisions (a collision applies without a
receipt, recipe identity includes the revision id, phone recipe Undo closes only after the twin is
deleted) confirmed sound.

| Finding | Revision 4 |
|---|---|
| BLOCK 1 a one-date slot op can change another slot through the full-row payload and conflict rebase | receipt only when the full row changed in the stamped slot alone; otherwise `other_change` and today's phone-only Undo (§3.2, §3.3, §4.4); test R3-1 |
| WARN 2 the slot Undo check omitted the target revision | `plan_days` `rev` must equal the receipt's after `rev` (§4.2); test R3-2 |
