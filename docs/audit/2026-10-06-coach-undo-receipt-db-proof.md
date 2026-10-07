# Coach Undo receipts, PR A: database proof

Date: 2026-10-06. Branch `feat/coach-undo-receipt-guards`. Spec `docs/specs/coach-undo-receipt.md`
(revision 4), deploy steps 1–5. Nothing is applied to production; the owner applies the migrations.

## Migrations, in apply order

Each file in its own transaction (`psql -1 -f`), each with a down file in `supabase/migrations/down/`.

| File | Step | What |
|---|---|---|
| `20261216090000_coach_action_receipts.sql` | 1 | `coach_action_receipts`: unique `(user_id, action_id)` and `(user_id, op_id)`, kind→entity check, `BEFORE UPDATE` trigger raising `receipt_immutable`, owner-only select, `service_role` select and insert only |
| `20261216090100_coach_undo_record_mode.sql` | 2a | `record_mode` (default `legacy`), `source`, `source_check`; checks `NOT VALID`; trigger keeping all three fixed |
| `20261216090200_coach_undo_record_mode_validate.sql` | 2b | validate the checks, `record_mode` `NOT NULL` |
| `20261216090300_coach_undo_legacy_guards.sql` | 3 | `record_coach_undo(p_undone)` and `perform_coach_undo` refuse every `receipt_v1` record; legacy `save_recipe` server Undo is `undo_local_only` |
| `20261216090400_perform_coach_undo_receipts.sql` | 4 | `perform_coach_undo` branches on `record_mode`; `_coach_undo_receipt` (from the one receipt) and `_coach_undo_legacy` (advisory lock before row locks) |

## Where they ran

- A separate local Supabase stack (project `undo-receipt-a`, API `127.0.0.1:56421`, DB
  `127.0.0.1:56422`, Postgres 17.6, CLI 2.117.0) started from `main`'s migrations, then the five files
  above applied one at a time. All five down files then ran in reverse and the five files applied
  again, with no error.
- The throwaway-Postgres harness (Homebrew Postgres 16.15), which applies the files itself.

## Results (one run, 2026-10-06, after review round 1)

The receipt Undo's inverse op id is random, and the record closes only when `apply_sync_op` answers
`applied` and a re-read of the target shows the receipt's `before` state. The legacy path follows
the same rule against the state its stored inverse restores.

`tests/migrations/coach-undo-sql.test.ts` (the existing cases on steps 1–4): 31 passed. The recipe
case now expects `undo_local_only`.

`tests/migrations/coach-undo-receipt-sql.test.ts`: 11 passed.

- R1-4: after each step in order, today's records undo through the legacy path; recipe phone-only from step 3
- R2-1: both legacy closing endpoints refuse a receipt record; `undone_at` stays null
- a receipt record undoes from its receipt only, never from `inverse`
- a receipt record carries no inverse; `record_mode`, `source`, `source_check` never change
- P2: a receipt is immutable for every role; only the account cascade removes it
- R1-6: a receipt of another kind than its record is inconsistent and writes nothing
- rollback: the receipt-aware function stays while a receipt record is open; never the unguarded body
- the down files run in reverse order on a database that never held a receipt
- review r1 BLOCK 1: a pre-submitted predictable op id cannot close the record; a `duplicate`, or an
  `applied` that wrote nothing, leaves it open (`undo_conflict`); the same for legacy meal and
  water records
- review r1 WARN 3: the receipts table's down file refuses while a receipt_v1 record exists, with
  no override

`tests/coach/undo-receipt-local.integration.test.ts` (local stack, real schema and RLS): 17 passed.

- a matched logged meal is undone from its receipt
- review r1 BLOCK 1: an op pre-submitted under the old predictable Undo id cannot close the record,
  receipt or legacy; a legacy water Undo closes only after the cups are written back
- a logged meal whose items changed at the same revision: 409 `undo_receipt_mismatch`
- E1: an Eggs idea that wrote beef: 422 `undo_source_mismatch`; the card shows beef, no message
- a slot Undo puts the slot back and leaves every other slot as it stands
- R3-2: a later write to another slot of the date: 409 `undo_conflict`
- E4: a later `mutationId` at the same revision: 409 `undo_receipt_mismatch`
- E2: same-name recipes: the mismatched receipt and the legacy name record are both refused
- E3: a recipe changed at the same revision: refused; it and its twin stay
- E5: a matched recipe Undo tombstones the recipe and its twin, a `change_log` row each
- one receipt per action (23505), no receipt of another kind, receipts never change
- T1: B reads none of A's receipts and cannot undo A's receipt record
- R2-1: an old build cannot close a receipt record through either legacy endpoint
- R1-5: a 500-record page with 500 receipts lists 500 complete cards
- U1: a legacy `set_slot_meal` record bound to `meal-3` lists once, as "Coach change"

`tests/tenancy` on the same stack, files one at a time: 31 files, 1195 tests passed
(`coach_action_receipts` in the owner-table matrix, both new trigger functions declared private).

## Not covered here (PR B)

R1-1, R1-2, R1-3 (stamped ops), R1-7, R2-2 (stamped op against a legacy record), R2-3, R2-4,
R3-1, P1 and T2 need `apply_coach_op`, which this PR does not build.
