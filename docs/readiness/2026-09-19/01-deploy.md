# 01 — Deploy state

**Outcome:** proved  
**Observed:** 2026-09-19  
**Production:** `https://sasha-meal-companion.vercel.app`

## Result

- `origin/main` was `54db44721461124a9fb201d28155e5b19fb47c19`.
- Vercel deployment `dpl_Gnd8Bgqc8chPMcjLzJ8gemptAPfB` was `READY`, targeted production, and carried the exact same commit SHA.
- The production alias was assigned to that deployment.
- The deployment event stream contained 108 events, 100 text records, no error-like record, and two deprecation warnings:
  - `preferredRegion` is deprecated.
  - the `middleware` convention is deprecated.
- Build receipts included `Compiled successfully in 5.5s` and `Build Completed in /vercel/output [29s]`.

## D10 receipt

Command: `bash scripts/readiness/ai-first-live.sh`

```text
PASS  Vercel production READY at main 54db44721461124a9fb201d28155e5b19fb47c19
PASS  POST /api/coach unauthenticated → 401
PASS  TYPESAFE_API_KEY present on production (name only)
PASS  migration drift check clean
```

The Vercel deployment and build-event APIs were queried read-only with the project and team identifiers from the task. No deployment or production mutation was made.

## Assessment

The deployed commit is the current default branch and the build completed cleanly. The two warnings are migration debt, not failed build evidence.
