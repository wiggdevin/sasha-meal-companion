# Today UI simplification

## Requested behavior

Devin requested a first UI simplification pass on September 15, 2026: consolidate Week into Today, open Coach by double-tapping the quick-actions button, compact nutrition, edit meals by tapping their cards, combine notes with meal editing, and reschedule meals by holding and dragging.

## Design

Keep DESIGN.md's NeuForm materials, system typography and macro colors. The existing week cells move beneath the Today heading; native horizontal scrolling pages through weeks, with keyboard navigation and a native date picker. A smaller calorie gauge sits beside vertically stacked protein, carbohydrate and fat gauges.

One FAB pointer tap waits 350 ms for a possible second tap, then opens quick actions. A second tap opens Coach. Keyboard activation opens the menu immediately, which also includes Coach as a discoverable fallback. Existing /week and /coach links remain valid; their bottom tabs are removed.

Meal cards open their editor on a tap. Tick and Swap remain independent controls. The editor saves portions, note and time together. A 450 ms hold enables dragging; each 12 px adjusts the clock by 15 minutes. The card follows the finger, shows its preview time and saves on release. Ordinary vertical scrolling cancels the pending hold. Escape, cancelled touch and lost focus cancel dragging. The time input provides a precise keyboard alternative.

## Persistence

Times belong to one selected date, using existing plan_days.item_overrides JSON. No database migration is required. Time-only overrides follow the live plan; a component snapshot keeps older clients readable. All writes include the complete plan row, and related edits are serialized per date. Normalized plan data is projected into Today's existing local store while preserving pending edits and unrelated meal logs.

## Acceptance and evidence

- Production password login succeeded and remained signed in after reload.
- Initial full local suite: 2,306 passed, 263 skipped (database tests run in CI).
- Lint and TypeScript checks passed; subsequent changes receive targeted checks.
- Browser QA uses localhost:3102 with a disposable Supabase database and a synthetic account.
- Single FAB tap, double-click Coach, direct card editing and note save verified in browser.
- Final gesture, responsive, review and CI results recorded in the PR.

A successful login does not establish that a complete production AI exchange works. That remains a separate readiness check.

### Browser acceptance results

All interaction checks used EGO Chromium with native mouse/touch/keyboard input against synthetic data:

- Single click opens quick actions; double-click and native double-tap navigate to Coach.
- Single meal-card tap opens the editor. Notes persist; keyboard time changes persist.
- Native 450 ms hold and 48 px drag previews 09:00, moves the card 48 px, saves on release, and survives reload with its note.
- A normal 85 px finger pan scrolls without editing or changing time.
- Native horizontal swipe advances the week; selecting September 22 updates the date query and survives reload.
- 320 px viewport has no horizontal page overflow; all seven date buttons measure at least 44 px wide. Nutrition labels fit after a responsive gauge-size correction.
- Separate storage origins, localhost:3102 (development) and localhost:3103 (compiled build), show the same persisted synthetic coffee time and note after the second client pulls sync.
- Production password login and session persistence after reload succeeded. No production account records were changed by these UI tests.

Screenshots: [320 px Today](../readiness/2026-09-15/ui/today-320.png), [390 px Today](../readiness/2026-09-15/ui/today-390.png). Screenshots show synthetic QA data, not Sasha's production records.
