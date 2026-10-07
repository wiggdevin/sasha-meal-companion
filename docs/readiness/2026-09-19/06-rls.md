# 06 — Cross-user RLS

**Outcome:** proved  
**Branch:** existing shared `tidy-2026-09-19` (`f350c68b-c7a4-4bce-bdb2-583b278014f3`)

The branch already existed and was not created, reset, made non-persistent, or destroyed.

## First pass

The RLS suite stopped before exercising policies because this pre-existing branch lacked the repository's branch-only test helpers `test_reset_user` and `test_view_options`: 25 failed, 43 skipped. This was a harness/setup failure, not counted as an RLS pass.

## Bounded branch-only setup repair

Applied the idempotent `supabase/seed/test_helpers.sql` to the existing readiness branch and reloaded the branch PostgREST schema cache. This adds test-only helpers and production-equivalent `service_role` grants; it does not alter production.

## Re-audit

Command:

```text
pnpm exec vitest run tests/rls tests/search/cross-user.test.ts --no-file-parallelism
```

Result:

```text
Test Files  4 passed (4)
Tests       68 passed (68)
Duration    24.50s
```

The cross-user read/write suite passed after the bounded test-harness repair. The shared branch remains in place for the driver.
