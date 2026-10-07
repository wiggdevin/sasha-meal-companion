# Combined-suite integration repair (assigned non-Foods tests)

The single combined run in `/Users/zero-suminc./Documents/Codex/2026-09-26/hey/work/foods-combined-full-test.log` reported 46 failures across 22 files. This pass handled only Settings, GoalRateField, body-profile markup, design scale, tenancy, account-fetch, Today, and the docs-lint test. It did not rerun the full suite.

| Failure | Diagnosis and repair | Focused evidence |
|---|---|---|
| Settings, GoalRateField and body-profile assertions | `GlassSelect` intentionally replaced native `<select>` markup. Assert the visible selected combobox value and exercise the rate options through the opened listbox, rather than expecting server-rendered `<option>` nodes. The two exact Settings snapshots were refreshed; a token-level diff found only the Sex, Goal and Activity controls changed from native selects to the shared combobox. | The four affected spec files and the snapshot spec passed. |
| Today swap date | The fixture used UTC `toISOString()` while Today uses the local calendar date. Near the UTC date boundary, it expected tomorrow. The fixture now derives a local calendar date, retaining the assertion that the viewed date is written. | `tests/cards/today.test.tsx` passed. |
| Design opacity scale | AddFoodSheet introduced `disabled:opacity-50`, outside the fixed scale. Changed it to the existing 40% disabled token; the guard was not relaxed. | `tests/design/scale.test.ts` passed. |
| Tenant-neutral names | AvoidImpact spelled the assistant product name in a second runtime file. It already imported `ASSISTANT_NAME`; the fallback message now uses that constant. No new allowlist exception. | `tests/tenancy/no-personal-defaults.test.ts` passed. |
| Shopping account-bound error read | Shopping read failed HTTP JSON with raw `res.json()` after `accountFetch`, missing the required post-parse account check. It now uses `accountJson` and rethrows `AccountChanged`; a regression switches accounts while parsing the error. Request body and content type are unchanged. | `tests/device/account-fetch.test.ts` and `tests/shopping/ui-client.test.ts` passed. |
| Docs feature checker timeout | The one failed case timed out at its 5-second default under full-suite contention. The unchanged focused file passed; no timeout or rule was relaxed. | `tests/ci/check-features.test.ts`: 9/9 passed. |

The first focused batch passed 9 files / 102 tests. The Settings snapshot run passed 1 file / 6 tests and updated 2 snapshots. The docs checker passed 1 file / 9 tests. Scoped ESLint, `tsc --noEmit`, and `git diff --check` exited 0. No browser, database, full-suite, commit, or production action in this pass. Other combined-suite failures remain with their owning lanes.
