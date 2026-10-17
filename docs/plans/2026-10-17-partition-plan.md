# O(users) work and the partition plan (W072, scale step 10)

Status: plan. The global catalog clock ships in migration `20270105110100_recipe_catalog_global_clock`.
No partition cut-over runs in this item. Sizes come from W041; fill the `TBD (W041)` cells from its
production measurement before any cut-over is scheduled.

## 1. What changed: one catalog revision row

Before, a shared catalog write ran `update recipe_plan_state set rev = rev + 1 where user_id is not null`.
That wrote and locked one row per account, in three places:

- `recipe_plan_bump_global_state`: statement triggers on `recipe_catalog` and `catalog_food_revisions`.
- `recipe_plan_bump_food_ref_state`: the catalog branch, row trigger on `food_refs`.
- `recipe_plan_bump_allergen_evidence`: the global (null-user) branch, row trigger on
  `food_allergen_evidence`.

Now each one moves `recipe_catalog_clock.rev`, the single row `id = 1`, at most once per transaction
(`last_xact`, the same rule `evidence_clock` uses). A preview's freshness is
`recipe_plan_state.rev (this account) + recipe_catalog_clock.rev`. Both numbers only grow, so the sum
changes exactly when either one does. `lib/server/recipe-plan.ts` `stateRevision` reads the sum, and
`recipe_store_preview` and `recipe_accept_preview` compare the same sum under their locks.
`recipe_plan_previews.catalog_rev` records the catalog part.

`recipe_log_consumed`, `recipe_undo_consumed` and `shopping_patch_purchase_window` lock the account's
state row but compare no state rev; they compare the selection's `plan_revision`. They are unchanged,
and a catalog write no longer makes them wait.

`tests/migrations/recipe-catalog-global-clock-db.test.ts` proves it: six accounts and one catalog
write leave every `recipe_plan_state` row version (`xmin`) unchanged and move the clock by one.

### Lock order

| Step | Row | Scope |
|---|---|---|
| 1 | `evidence_clock` | global |
| 2 | `account_rules_clock` | per account |
| 3 | `recipe_catalog_clock` | global (W072) |
| 4 | `recipe_plan_state` | per account |

The catalog clock sits third for two reasons:

- Every catalog trigger already takes `evidence_clock` first (W034). A first catalog ref minted by
  `get_or_create_food_ref` also takes the caller's rules row before it inserts. Both come before the
  catalog clock.
- The same mint's membership backfill then writes `user_food_prefs`, which moves that account's
  `recipe_plan_state`. That comes after.

So the previews take the catalog clock `FOR SHARE` before their `recipe_plan_state` row. Taking it
after would deadlock against that mint. `tests/migrations/lock-order-db.test.ts` runs the pair and
checks the order in each function's source.

## 2. Triggers on shared tables

Shared means no `user_id` column: the catalog, the recipe catalog and `food_refs`.
`food_allergen_evidence` and `food_facets` are included because their global rows are shared. Each
trigger below is O(1) per row or per statement: it reads or writes a fixed number of rows found by
primary key, or none.

| Table | Trigger (function) | Level | Work per firing | O(1)? |
|---|---|---|---|---|
| `catalog_foods`, `catalog_food_revisions`, `catalog_food_nutrients`, `catalog_portions`, `catalog_ingredients`, `food_refs`, `food_allergen_evidence`, `food_facets` | `evidence_clock_*` (`evidence_clock_bump`) | statement | `exists` on the transition table (stops at the first row), then at most one update of `evidence_clock` id 1 per transaction | yes |
| `catalog_food_revisions`, `recipe_catalog` | `recipe_state_catalog_evidence`, `recipe_state_catalog` (`recipe_plan_bump_global_state`) | statement | lock `evidence_clock`, at most one update of `recipe_catalog_clock` id 1 per transaction | yes (was O(accounts)) |
| `food_refs` | `recipe_state_food_refs` (`recipe_plan_bump_food_ref_state`) | row | lock `evidence_clock`; catalog ref: catalog clock bump; user ref: one `user_foods` pk read and one owner state upsert | yes (catalog branch was O(accounts)) |
| `food_refs` | `owner_fixed` (`_food_ref_fixed`) | row | compares two columns | yes |
| `food_allergen_evidence` | `recipe_state_allergen_evidence` (`recipe_plan_bump_allergen_evidence`) | row | lock `evidence_clock`; global row: catalog clock bump; account row: at most two owner state upserts | yes (global branch was O(accounts)) |
| `food_allergen_evidence` | `food_allergen_evidence_monotonic` (`_p13_monotonic_allergen_evidence`) | row | compares old and new, one rank lookup | yes |
| `food_allergen_evidence` | `food_allergen_evidence_hold_delete` (`_p18_guard_allergen_hold_delete`) | row | at most one `auth.users` pk read | yes |
| `food_allergen_evidence` | `food_allergen_evidence_no_truncate` | statement | raises | yes |
| `recipe_catalog` | `recipe_catalog_publish_guard` | row | on publish, two `exists` reads by revision id and one seal insert | yes |
| `recipe_catalog_items`, `recipe_catalog_steps` | `*_sealed` (`recipe_catalog_content_guard`) | row | one joined pk lock on the recipe root, one seal `exists` | yes |
| `recipe_catalog_items`, `recipe_catalog_revisions`, `recipe_catalog_seals`, `recipe_catalog_steps` | `*_immutable` (`recipe_catalog_immutable`) | row | raises | yes |
| `recipe_catalog_revisions` | `recipe_catalog_search_doc` | row | builds a tsvector from the row's own text | yes |

A bulk catalog import is still O(rows imported), as any import is. It is no longer O(rows × accounts),
and the clocks move once per transaction, not once per row.

Child tables reached through a parent (`log_items`, `recipe_items`, `recipe_revisions`,
`favorites_meal_items`, `duplicate_group_members`) are account data, not shared. Their `same_owner` and
`owner_fixed` guards read one parent row by primary key.

## 3. Partition plan for the big tables

Partition each table only when its trigger below fires. Until then, the indexes and the bounded purge
jobs are enough. Each cut-over is its own reviewed migration plus a Mac-session runbook: backup first,
rehearse on a branch copy of production, apply one file at a time.

| Table | Rows today | Size today | Growth / month | Trigger to partition |
|---|---|---|---|---|
| `ai_calls` | TBD (W041) | TBD (W041) | TBD (W041) | 5 GB, or 5M rows, or the circuit read (`lib/ai/circuit.ts`) p95 over 50 ms |
| `change_log` | TBD (W041) | TBD (W041) | TBD (W041) | 5 GB, or 5M rows, or a first sync over 15 pages (W048) |
| `client_timings` | TBD (W041) | TBD (W041) | TBD (W041) | 5 GB, or 5M rows |

### `ai_calls`: range by `created_at`, monthly

- Why monthly: every hot read is recent. That covers the circuit read (`provider, model_id, status,
  created_at` over minutes), the spend sweep (holds by `spend_reservation_id`) and the daily caps.
  Retention drops whole months with `detach partition` and `drop` instead of a delete.
- Key: the primary key becomes `(id, created_at)`, because a partitioned table's unique keys must
  include the partition column. `ai_spend_reservations` finds its row by `spend_reservation_id`; keep a
  non-unique index on it in each partition.
- Cut-over:
  1. Create `ai_calls_p` partitioned by range (`created_at`), with monthly partitions from the oldest
     kept month to two months ahead, plus a default partition.
  2. In one transaction: lock `ai_calls`, copy it into its partitions (batched beforehand for the cold
     months), rename `ai_calls` to `ai_calls_old` and `ai_calls_p` to `ai_calls`, and move the grants,
     RLS policies and the `call-ledger.ts` writer's column defaults.
  3. Keep `ai_calls_old` for one backup cycle, then drop it.
- A monthly cron (or the retention purge job) creates partitions ahead and detaches expired ones.

### `change_log`: hash by `user_id`, then compact

- Why hash: every read is per account (`user_id, seq > cursor`, `user_id, entity, entity_key`). The
  table cannot be dropped by age until W048's snapshots exist. Pruning stays per entity, behind a
  snapshot, never a time-based TTL.
- Key: `(user_id, seq)` already holds the partition column. `change_log_op_id` (global unique on
  `op_id`) cannot stay global on a partitioned table. Replay no longer needs it, because
  `sync_op_receipts` (W048 step 1, `20270105110000`) holds the op id. Before the cut-over, move the
  two content readers (`write_target_revision`'s request id replay and `care_log_grew`) onto
  snapshots, then drop the global index.
- Cut-over: 16 hash partitions. Use the same copy, swap and drop-old steps as `ai_calls`. The
  `change_log_op_receipt` trigger is recreated on the partitioned parent, and `next_change_seq` is
  unchanged.

### `client_timings`: range by `created_at`, weekly

- Why weekly: rows are write-once measurements read only by `pnpm timings` over recent days.
  Retention is a whole-partition drop.
- Key: `(id, created_at)`. Nothing references it.
- Cut-over: the same steps. The insert-only grant for `authenticated` moves to the parent. The route
  answers 202 whatever the insert does, so a failed insert during the swap costs measurements only.

### Not in this item

No cut-over, no new cron and no production read run here. W041 supplies the sizes. Each cut-over gets
its own W item once a trigger above fires.
