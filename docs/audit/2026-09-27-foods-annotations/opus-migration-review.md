# Review: A08 `custom_rules` migration

**Verdict: it does not pass yet. There is 1 blocker in DOWN. UP is correct and fails closed, with 1 recommended fix.**

## Blocker: DOWN can still drop real data

1. **Race between the check and the drop.** The `DO` block reads the table without locking it. Another writer can commit rules after the check passes and before `ALTER TABLE` gets its lock. The drop then deletes those rules with no error.
2. **Rows hidden by RLS.** If the table has `FORCE ROW LEVEL SECURITY` and the migration role lacks `BYPASSRLS`, the `EXISTS` check sees only rows the policies allow. It can then report "no rules" when rules exist.

Fix (it must run in the same transaction as the drops):

```sql
lock table public.constraint_profiles in access exclusive mode;
set local row_security = off;  -- errors instead of silently filtering rows
do $$ begin
  if exists (select 1 from public.constraint_profiles where custom_rules <> '[]'::jsonb) then
    raise exception 'custom_food_rules rollback refused: account rules remain';
  end if;
end $$;
-- then the three drops as written
```

If the migration runner does not wrap each file in a transaction, add `begin;` and `commit;` yourself.

A smaller point: the `if exists` clauses are misleading. If the column is already gone, the `DO` block fails first with "column does not exist", so a second DOWN run errors anyway. That is harmless, but either drop the `if exists` clauses or guard the `DO` block with a lookup in `information_schema`.

## Recommended fix: whitespace padding

`btrim()` removes only ASCII spaces. `'ab'` followed by 50,000 spaces has a trimmed length of 2, so it passes. Each of the 30 items can therefore store padding of any size, and inner newlines and control characters also pass.

If the API trims before it saves, the database is looser than the API here. Add both conditions:
- `entry.value->>'text' = pg_catalog.btrim(entry.value->>'text')`
- a character-class check that rejects control characters, if the API rejects them.

## What I checked and found correct

- **Malformed top-level JSON.** An object, scalar, or JSON `null` gives `jsonb_typeof ≠ 'array'`, so the function returns false. `CASE` runs `jsonb_array_length` only after the array test passes, so a scalar cannot crash it. The `ELSE` subquery is not folded early during planning.
- **Malformed items.** In practice the item checks run left to right and stop at the first false. So `jsonb - text` runs only on objects, and scalar items do not crash. PostgreSQL does not formally guarantee this order. If it ever changed, a scalar item would raise "cannot delete from scalar", which still rejects the row. No bypass is possible.
- **Key set.** Removing `id`, `kind` and `text` must leave `'{}'`, so extra keys are rejected. The type checks catch missing keys. Duplicate keys collapse in `jsonb`. `jsonb` does not allow `\u0000`.
- **Three-valued logic.**
  - Inside an item, `coalesce(..., false)` turns an unknown result into "invalid". This fails closed.
  - At the top level, a SQL `NULL` input falls through every `CASE` branch and returns `true`. That matches how a `CHECK` treats `NULL`. `NOT NULL` already blocks it, so it only matters if someone later drops `NOT NULL` or reuses the function as a standalone validator. For that, add `when rules is null then false`.
- **UUID regex.** The ARE `$` matches only at the true end of the string, so a trailing newline cannot bypass it. The regex is looser than Zod v4 `z.uuid()`, which checks version and variant bits. The database stays at least as loose as the API, so the API cannot send a valid UUID that the database rejects.
- **`search_path = ''`.** `pg_catalog` is always searched, even when the path is empty, so the unqualified operators and `'{}'::jsonb` resolve correctly. The `SET` clause stops the function from being inlined. That costs a little speed and is safe.
- **`IMMUTABLE`.** This is accurate: every function called is immutable and nothing reads a table.
- **Adding the column on PG 11+.** The constant default is stored in the catalog, so the table is not rewritten. `ADD CONSTRAINT` scans the table once under `ACCESS EXCLUSIVE`, and every existing row holds `'[]'`, so it passes. On a large table, use `NOT VALID` and a separate `VALIDATE CONSTRAINT`.
- **Compatibility.** Existing inserts get the default. RLS and grants on the table are unchanged. Views that expand `select *` are not affected.

## Limits (not blockers)

- **Implicit grant.** `CREATE FUNCTION` grants `EXECUTE` to `PUBLIC`. On Supabase, the default privileges also expose the function as `/rpc/custom_food_rules_valid` to `anon` and `authenticated`. That is a new grant in effect. It is harmless: the function is pure and bounded. **Do not revoke it**, because the `CHECK` runs with the inserting user's rights, and a revoke would break their writes.
- **Duplicate item IDs are allowed.** If the API or UI keys items by `id`, add a uniqueness check: compare the count of distinct `id` values with the array length.
- **Length is counted differently.** PostgreSQL `length()` counts code points. Zod counts UTF-16 code units. Text with one emoji (2 UTF-16 units) passes Zod `min(2)` and fails the database check, so the API returns a constraint error instead of a clean 400. Use the same length rule in both places, or use `[...s].length` in Zod.
- **"Revision-checked" was not verified.** I could not see the table. If a trigger bumps the revision based on a list of columns, add `custom_rules` to that list. Regenerate the TypeScript types.
