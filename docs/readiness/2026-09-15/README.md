# Production readiness loop — 2026-09-15

**Verdict: production login and real synthetic Coach exchanges verified; remaining readiness limits are listed below.** Production is online. The later September 15 verification closed the login and post-tool AI-response blockers. It also shipped the requested Today UI simplification in PR #202. This is not a claim that physical-device or operational recovery gates have all passed.

## Scope and method

Applied [The full product evaluation loop](https://signals.forwardfuture.com/loop-library/loops/full-product-evaluation-loop/) from the live loop-library catalog. The finite [118-feature inventory](inventory.md) separates observed interactions, automated evidence, retired behavior, deferred Phase 8 work, and missing acceptance proof. No nutrition constants or production schema were changed.

Production reads used the existing deployment and database. Authenticated interactive checks used a separate localhost:3101 app, fresh disposable Supabase stack, synthetic account and catalog fixtures. The user's existing port 3000 development process and original local database were preserved. Local dev sign-in is not evidence of production password sign-in. The local imported catalog was also exercised by integration fixtures; it is not an exact production data clone.

## Changes and release

- #166: updated compatible dependencies and repaired the Google SDK pin; independently reviewed and merged.
- #167: upgraded scanner WASM after old/new six-format decode comparison; independently reviewed and merged.
- #168: closed the Node 26 type major under the existing runtime deferral ruling. Node 22 remains pinned.
- #196: prevented failed first coach turns from creating empty conversations; merged.
- #197: Gemini 3.8 capture now uses supported LOW thinking. MINIMAL returned 400 in a synthetic provider probe; LOW succeeded; merged.
- #198: integration CI now starts a disposable Supabase database, validates local destinations, masks credentials, and fails instead of silently skipping unavailable database checks. Fixed stale assertions and unsafe fixture cleanup; merged.
- #199: reviewed coach corrections provide actual profile/ramp targets, allow 15-second attempts within 30-second call / 75-second turn limits, and enforce the existing 1,200-token output cap. Merged after Quality, Build, Integration and Vercel passed.
- #200: reviewed normalized-entry note sync, complete item preservation, and authoritative cache recovery after duplicate request replays. Merged after Quality, Build, Integration and Vercel passed.

Main branch protection was enabled with explicit owner approval: up-to-date Quality, Build and Integration checks, administrators included, no force pushes or deletion. No review-approval count was added.

Removed 98 fully merged stale workflow branch pointers using git branch -d. [Receipt](branch-cleanup.json). Unmerged/squash-history branches and active worktrees were preserved.

The initial readiness fixes were merged and deployed through `9848195` (#200); [production receipt](code-release.json) confirms Vercel success, public assets200 and private endpoints401. Final code candidate [CI](https://github.com/wiggdevin/sasha-meal-companion/actions/runs/34985377165) passed 2,255 quality tests and 1,624 integration tests, plus build and Vercel preview. These suites overlap.

The subsequent Today simplification merged in [#202](https://github.com/wiggdevin/sasha-meal-companion/pull/202) as `def8bab`: compact nutrition, swipeable days, meal editing/notes/time dragging, and FAB access to Coach. Quality, Build, Integration and Vercel passed; the authenticated production UI was checked. See [UI implementation and acceptance](../../plans/2026-09-15-today-ui-simplification.md).

Additional [food-entry observations](remaining-ui.md) cover preset persistence, manual sugar rejection, two-food logging and an off-plan gluten warning.

## Production recovery

The app initially returned 402 DEPLOYMENT_DISABLED despite a Ready deployment. Vercel showed an account suspension. The owner approved the displayed 20-dollar immediate Pro reactivation charge and 20-dollar monthly renewal; checkout was submitted once and Vercel showed Welcome to Pro. The production sign-in page then returned 200. No card details or password were entered during billing reactivation. Authorized application password login was verified later.

## Verification evidence

| Check | Result and practical limit |
|---|---|
| Starting-main local suite | 2,234 passed, 263 skipped; lint and TypeScript passed |
| Coach release checks | [Run 34984653416](https://github.com/wiggdevin/sasha-meal-companion/actions/runs/34984653416): 2,246 quality tests and 1,624 integration tests passed; build and Vercel passed. The two suites overlap and must not be added together |
| New integration gate, real GitHub runner | [Run 34983041813](https://github.com/wiggdevin/sasha-meal-companion/actions/runs/34983041813): 1,618 passed, 10 deliberately skipped across 212 passed test files. Updated-main run 34983908992 also passed. Skips include legacy rollback and external relevance gates; no blanket acceptance claim |
| CI workflow analysis | actionlint passed; zizmor reported six existing medium findings, no introduced findings |
| Production builds | Actual GitHub and Vercel builds passed. The initial local worker-port EPERM was resolved through authorized execution; later UI, Coach and backup production builds passed |
| Scanner runtime | Six generated barcode formats decoded the same text in old/new WASM; camera speed and physical-device behavior untested |
| Production schema | 39/39 migration ledger entries; 50/50 public tables have RLS enabled. Policy correctness assessed separately by integration tests |
| Anonymous production routes | Private surfaces reject missing auth; [36-route matrix](anonymous-route-matrix.json). Disabled health feature routes return 503; public assets 200 |
| Local mobile UI | Today, Week, Body, Foods, Coach, Settings opened at 390 px with no horizontal overflow; [screenshot](today-mobile-verified.png) inspected |
| Meal/water state | Coffee tick and ring changes, cup add/remove and reload persistence observed. Meal 2 tick while browser offline survived reconnection/reload; installed-app offline startup untested |
| Foods | Avoid/restore and food note survived reload; reference lists rendered |
| Schedule | 15-minute shift persisted; Tuesday training override persisted; Wednesday rituals and December full-day rendering observed |
| Calories | 1,950-to-2,000 training change retained 115 g protein; full clamp/portion acceptance remains automated or untested |
| Catalog logging | 125 g catalog serving appeared, changed totals and survived reload; nutrient coverage rendered |
| Note sync | Saved synthetic note reached local DB revision 2 with 125 g item unchanged; [receipt](note-sync-local.json). Concurrent replay preservation additionally covered by regression |
| Recipes | Created version 1, favorited, edited to version 2 and reloaded. Previously logged recipe-version immutability was not directly verified in this UI sequence; W085 (2026-10-17) covers it in `tests/recipes/consumed-history-local-db.test.ts` (logged version untouched by a catalog edit, one history entry for two tabs logging the same slot, same-request race), with the R6 dairy and three-food rejections in `tests/recipes/eligibility.test.ts`. The database cases run in CI's integration job against a local stack, not on cloud threads |
| Export/sync | Authenticated local meals CSV 200; Sync now reported all sent |
| Restore drill | Separate disposable database restored 39 migrations and all 84 dumped table counts, 324,341 rows, zero count mismatches. [Details](backup-restore.md) |

## Remaining blockers and limitations

1. **AI response blocker closed.** Two real synthetic Coach exchanges succeeded after the target/output-limit corrections. The first returned HTTP 200 in 4.24 seconds after `get_targets` and `search_foods`; authenticated readback matched both persisted messages. The second succeeded through the actual browser UI. Gemini 3.6 MINIMAL is the Coach model; Gemini 3.8 LOW serves capture. See [follow-up evidence](coach-follow-up.md). These checks used a local application and synthetic account, not production health data.
2. **Production login blocker closed.** Password sign-in through the real production page succeeded, and the authenticated session survived reload. The user explicitly authorized agent credential entry; the shared login skill was updated. No credential values appear in these reports.
3. **Duplicate-detection foundation is incomplete; its UI is deferred.** Logging creates duplicate groups/members directly without a feed event. Existing sync RPC can publish group metadata but omits duplicate_group_members. No shipped component consumes these groups; ordinary log-entry sync remains separate. A complete correction requires a reviewed production schema migration when that feature is implemented. No misleading partial fix was shipped. Fresh migrations create 47 public tables versus 50 in production: the empty legacy foods/days/settings tables are not reproduced by the migration set. This also limits claims about restoring the legacy release path.
4. **Operational recovery repaired and exercised.** The exact repaired SQL scripts restore table counts, ACLs, owners and RLS policies. A synthetic media object backup/restore matched bytes. Fresh production SQL and media backups succeeded. The release wires nightly Mac SQL/media backup and a separate authenticated Vercel JSON cron. The installed timer was started through launchd and completed with exit code 0, producing fresh SQL and both media objects; the freshness check passed. See [scheduler receipt](backup-scheduler.json). See [recovery runbook](../../operations/backup-recovery.md) and [SQL receipt](sql-recovery-follow-up.json). Hosted branch recovery and full application acceptance against a restored production copy remain untested.
5. **Device and remaining interaction gates are open.** Installed iPhone/offline/camera/voice/share/calendar/device-ingest flows were not exercised. Per-slot keyboard time editing, touch dragging and reload persistence now pass; physical calendar delivery remains untested. Other inventory rows retain precise evidence limits; historical Loop 010 findings are not silently declared resolved.

Automatic approval review initially required explicit permission for the Gemini diagnostic destination and payload. The user subsequently granted that permission, and the synthetic tests above completed within the approved $0.10 cap.

## Acceptance follow-up

Finish the physical-device journeys before a blanket device-readiness verdict. Duplicate-detection UI and its remaining backend contract belong to the deferred feature scope. The task delivers reviewed fixes and deployment evidence, not an unsupported claim that every feature passed.
