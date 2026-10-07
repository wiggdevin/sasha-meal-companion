# Login and Coach follow-up — September 15, 2026

## Verified

- Production password login at sasha-meal-companion.vercel.app succeeded with the user's authorized Vault credential; the session survived reload.
- Today UI PR #202 merged as def8bab and Vercel reported success for that exact commit. The authenticated production page rendered the new week strip and compact progress card.
- Real Gemini Coach request against the isolated synthetic account returned HTTP 200 in 4,237 ms. It called get_targets and search_foods, then generated a final reply. Authenticated readback matched the two persisted messages.
- A second request through the real browser composer succeeded. Its synthetic prompt requested saved calorie targets; the visible reply reported 1,950 training calories and 1,650 rest calories.
- No production health data was sent to the provider by these checks. The two exchanges cost $0.00584475 total, within the approved $0.10 cap.

## Model and source

Coach uses Gemini 3.6 Flash with MINIMAL thinking. Capture separately uses Gemini 3.8 Flash with LOW thinking. The tested Coach implementation was c7f2a59; its AI/Coach code is unchanged in the deployed def8bab UI release.

## Reload regression

Browser evidence found that a completed conversation existed on the server but disappeared from view after reload: CoachScreen always passed a null thread ID. The follow-up change resumes the authenticated user's latest chat. Browser verification on the corrected implementation passed: the latest two messages loaded, the composer enabled after loading, Today → double-click FAB reopened the same exchange, and another reload retained it. Screenshot: `ui/coach-resumed.png`. This correction required no additional provider calls.

## Scope

These results close the previous login and real post-tool-response blockers. The original readiness report retains separate database-sync, backup and physical-device limitations.

## Release checks

- Full local suite: 2,324 passed, 263 explicitly skipped.
- After route-helper extraction and offline reset correction: 51 targeted tests passed, four integration skips. Independent reviewer reran 44 focused tests with no remaining P1/P2 findings.
- Full lint, standard TypeScript check and production build passed. The build also verified the bundled Google SDK runtime pin.
- Next route modules exposed test helpers as named exports, which strict generated development route validators rejected. Helpers now live in library modules; their behavior is unchanged.

Compiled runtime follow-up: saved replies restored with final route helpers; disconnect disabled the composer and reconnect enabled it. A stale offline notice found during that sequence was corrected; 20 targeted tests passed, including retaining genuine errors while clearing the offline notice.
