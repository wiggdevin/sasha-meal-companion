**Verdict: no blockers. Safe to run locally after taking the backup.**

**Destructive and account effects:** none found.
- The script has no `UPDATE`, `DELETE` or `TRUNCATE` statements.
- It never deactivates an existing version or revision.
- It does not touch `auth` or other user-owned tables. The only rows it adds outside the catalog are 29 `food_refs` rows with `kind='catalog'`.
- It runs in one transaction with `ON_ERROR_STOP`. Any failure closes the session without a commit, so Postgres rolls everything back.

**Identity mapping:** correct.
- Foods map by `(source, source_id)`, and revisions map by the local active revision.
- The script raises an error on any content mismatch, on partial prior state, or on an inactive revision already in the active version.
- It checks that existing portions and ingredients match in both directions with `except all`.
- If the database state is unexpected (duplicate active versions or revisions, or duplicate refs), the final `<> 29` / `<> 111` checks fail and the transaction rolls back. No bad data gets written.

**Idempotency:** a second run does nothing and passes. Two conditions apply:
- `food_refs ... on conflict do nothing` names no conflict target. It only prevents duplicates if a unique constraint covers `(kind, catalog_food_id)`. Without one, a second run adds 29 more refs, `_verify` sees 58, and the run rolls back. So it stays safe, but a rerun will fail. Check that the constraint exists.
- The preflight does not check the `food_refs` ID sequence. If that sequence trails the table, the insert fails and rolls back. Again safe, just a failed run.

**Optional hardening (not blockers):**
1. `select id into active_version` does not use `STRICT`. Add an explicit check that exactly one active `fdc_sr_legacy` version exists. Today the final counts catch this case indirectly.
2. The "reuse existing active SR Legacy version" path would attach this 29-food subset to a real full release, and that release's `row_counts` would then be wrong. The snapshot shows no SR Legacy version today, so this path cannot run now. For a pilot, consider raising an error instead of reusing.
3. The snapshot totals (5/37/39/8/36 before, 6/66/68/119/65 after) are only in comments. Assert them inside the transaction so drift fails the run instead of relying on someone reading the receipt.
4. The embedded JSON must not contain your dollar-quote tag. Confirm this when you paste it in.
