# Recover consumed meal-plan cache — September 15, 2026

Final browser verification found a retained sync row that was not reaching Today. The synthetic account's server row and IndexedDB cache both held Coffee at 10:00, but the legacy localStorage store was absent and Today rendered 8:00. The feed cursor was already 18 and the outbox was empty, so no new event replayed that plan.

The correction recovers cached plan rows for the current authenticated owner during startup. It re-reads under the existing per-date queue and IndexedDB transaction, skips pending edits and existing normalized authority, and preserves meal logs and marks. Identity changes invalidate outstanding recovery.

## Direct browser acceptance

The same existing localhost:3104 browser storage was retained; no cache or cursor was reset. With the corrected compiled application:

- Coffee changed from 8:00 to the saved 10:00.
- The saved note, “UI QA: note and time saved together,” appeared with it.
- The legacy day now held the saved time and normalized authority marker.
- A second reload retained both the time and note.

Targeted recovery/projection tests passed (18 tests); independent review ran 37 focused tests without a new P1/P2 finding. Lint, TypeScript and the production build passed. Full-suite and release checks are recorded in the pull request.

This correction scopes the new recovery operation to its authenticated owner. It does not claim to redesign the pre-existing shared legacy/IndexedDB account-storage architecture.

The architecture explicitly keeps this release single-account until legacy storage is retired. A read-only production metadata check confirmed exactly one provisioned Auth user. Account-scoped storage remains required before adding another production user.

Final merged-base local verification: 2,343 tests passed, 264 explicitly skipped; full lint, TypeScript and production build passed. Database-backed integration gates run separately in CI.
