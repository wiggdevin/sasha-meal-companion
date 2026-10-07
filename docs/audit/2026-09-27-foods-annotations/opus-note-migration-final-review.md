**Verdict: no hard blockers.** I found nothing that fails as written, leaks privileges, or loses data on the paths you described. One item is a conditional blocker. It depends on a path this delta doesn't show.

## Conditional blocker: the authority note can overwrite a newer note written by another path

When a `food_note_authority` row exists, `set_food_membership` writes `authority.note` over every same-name `user_foods` row. In the eats/avoid branch, `kept_note` runs whenever `v_note_authoritative` is true. It does not bump `rev` and does not write to `change_log`.

This matters if anything else can write `user_foods.note` without going through `save_food_note`. Examples: the add-food form with a note field, a generic `user_foods` sync push, or deleting and re-adding a food under the same name. In that case the next Eats/Avoid toggle silently puts the old authoritative note back. The server row then differs from the client, and no change-log row tells the client.

Fix it one of these ways:
- **(a)** Confirm that `save_food_note` is the only path that writes notes.
- **(b)** Make every other path that writes a note also upsert `food_note_authority` under the same advisory lock.
- **(c)** Under authority, skip `kept_note` completely. `save_food_note` has already copied the note to `user_foods`, so the membership RPC doesn't need to rewrite it. Keep the authority fence only for the `food_membership_revisions` note and the `user_food_prefs` note.

(c) is the smallest change.

## Non-blocking (verified or low risk)

- **Lock and CAS:** Correct. The name is read before locking, then locked, then re-read with `FOR UPDATE` and compared against the locked name. Both RPCs use the same lock key. The CAS lets an idempotent retry through when the note already equals `v_note`, and undo works through `p_expected_note`. One assumption: `food_name_norm` must be idempotent, because `set_food_membership` normalizes `p_name_norm` again. If it isn't, the two lock keys differ.
- **`for … in update … returning` loops:** Valid PL/pgSQL. The returning portal runs to completion before the `change_log` inserts.
- **Deadlocks:** `next_change_seq` probably locks a per-user counter. `save_food_note` takes it while it already holds locks on `user_foods` rows. If an existing sync path takes the counter first and then `user_foods` rows, the two can deadlock. The result is a retryable 40P01 error, not data loss. Check that the lock order matches the existing convention.
- **`note_conflict` uses errcode `40001`:** A generic client retry loop that retries on serialization failures will repeat the same stale CAS until it gives up. Make sure the client treats this as a terminal conflict, or use a custom SQLSTATE.
- **Table grants:** Supabase's default privileges give `anon` and `authenticated` all privileges on the new table, including TRUNCATE. RLS with no policies blocks row access, and PostgREST doesn't expose TRUNCATE. For hardening, add `revoke all on food_note_authority from anon, authenticated;`.
- **Down migration:** Sound. The `access exclusive` lock is taken before the emptiness check, a non-owner runner fails when `row_security = off` is set, and the objects are dropped in the right order. A membership call already blocked on the lock will error after the commit (relation dropped). That is safe to retry. If the runner already wraps the file in a transaction, the explicit `begin` only produces a warning.
- **Membership pull:** `save_food_note` changes `food_membership_revisions.note` without changing `rev`. That follows the rule from the prior review against creating revisions. It means any client that pulls membership rows by `rev` won't see the note change there. That's fine as long as clients read notes from `user_foods` or `user_food_prefs`, which are in `change_log`.

Root disposition: requested option(c), skip user_foods note rewrite in membership when explicit authority exists, plus revoke direct table grants. Final local behavior proof will rerun exact final SQL.
