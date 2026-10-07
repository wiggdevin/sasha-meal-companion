The RPC runs as written: I found no PostgreSQL syntax or semantics errors. It has two data-loss blockers, and several points depend on code you did not include. The down migration is fine: dropping the function removes no data, and the leftover `food_membership_revisions` rows are harmless.

## Blockers

**1. The `rev = 0` placeholder can silently drop the next Eats/Avoid.**
When no membership row exists yet, the RPC inserts one with `rev = 0`. `set_food_membership` accepts `p_rev >= 0` but applies a write only when `membership.rev < excluded.rev`. So if a client sends `p_rev = 0` as its first status write, `0 < 0` is false, the write is rejected, and the RPC still returns success.
- Fix: do not insert. Update the revisions row only when it already exists. `user_foods.note` is the stored note, so nothing is lost:
  ```sql
  update food_membership_revisions set note = p_note, updated_at = now()
   where user_id = p_user and name_norm = v_name;
  ```
- Or require `p_rev >= 1` in `set_food_membership`, and confirm no client sends 0.

**2. A delayed note edit can overwrite a newer one.**
The RPC has no revision or base-version check, so the last write to arrive wins. Suppose device A edits a note offline and its edit is queued. Device B then saves a newer note. When A's edit replays, it overwrites B's note, and nothing flags it.
- Fix: add `p_base_rev bigint` (the `user_foods.rev` the client last saw). If the current `rev` differs, raise a conflict (for example errcode `40001` with `note_conflict`) and let the client re-pull. Also accept a client `p_op_id uuid` and use it in `change_log` instead of `gen_random_uuid()`. Then retries are idempotent and the client can recognise its own echo, if your pull does that.

**3. Old notes can come back through queued status changes.**
The comment says a queued status change "with p_note NULL" preserves the note. That holds only if clients never re-send the note they had cached. If a queued `set_food_membership` carries its old note, `coalesce(excluded.note, …)` restores the note the user just cleared or edited.
- Fix: make sure the client queue never sends a note with status changes (send NULL). Add a test that clears a note and then replays a queued status change.

## Verify against code not shown

- **Double logging.** If `user_foods` or `user_food_prefs` already have `change_log` triggers, this RPC writes every change twice, with different seq and op_id values. Log in the same way the other writers do.
- **Missed rows on pull.** If `next_change_seq` uses a Postgres sequence rather than a per-user counter row locked until commit, rows can commit in a different order than their seq numbers. A pull that reads `seq > cursor` then skips some of them. Copy whatever the existing writers do.
- **Deadlocks.** This RPC locks the revisions row, then `user_foods` rows, then the seq counter, then prefs rows, then the seq counter again. `set_food_membership` locks the revisions row, then `user_foods`, then prefs, so those two are compatible. Any other writer that takes the seq counter before row locks can deadlock with this RPC.
- **`user_foods.updated_at`.** If that column exists and sync or conflict handling reads it, bump it here too.

## Smaller fixes

- **Normalize empty notes:** `p_note := nullif(btrim(p_note), '');`. Otherwise `''` becomes a real note that the `coalesce` calls keep, so "clear" can behave in two ways.
- **Limit note length:** for example, raise `22001` when `length(p_note) > 2000`. A `security definer` function currently accepts text of any size.
- **Search path:** set `search_path = public, pg_temp`, or use `''` with schema-qualified names. The existing functions use `public` only, so this is hardening rather than a regression.
- **Advisory lock:** it serializes only calls to this RPC, and the revisions row lock already does that. `set_food_membership` never takes it. Remove it, or make both RPCs take the same key.
- **Catalog-only foods:** `food_not_found` rejects a food that has only catalog refs, including one marked Eats or Avoid. For those foods, the note lives on `user_food_prefs`, and this RPC cannot edit it. The catalog branch of the prefs update runs only when a user food with the same name also exists. If that is the intended scope, say so in the comment. If not, check "user food row **or** any pref in the name family".
- **Cost:** `food_name_norm(...) = v_name` has no index, so every call scans all of the user's foods, prefs and catalog revisions. That is acceptable at current sizes. If the tables grow, add an expression index on `(user_id, food_name_norm(name))`.
