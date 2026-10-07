# Wave 4 rulings — 2026-09-12

Devin delegated the open decisions of `docs/plans/2026-09-11-phase-5-7/README.md` ("Decisions Devin owes") plus three
landing questions to two advisers: Grok 4.6 (SuperGrok subscription, tool-free, one reply on a 55 KB evidence packet)
and the driver (Claude Fable 5.1). Each ruled blind; the driver reconciled. Evidence: repo state per item (file:line)
and fetched policy text for Nous Portal, Gemini API, Oura and Health Auto Export, all dated 2026-09-12. The packet,
both drafts and Grok's raw reply are in the goal-run state, not in this repo.

Legend: **RULING** is final. **DO** is done in this wave. **OWNER** is a step only Devin can take (a purchase, a
physical item, an account he owns). Every README item that carried an assumed value is now a final ruling.

| # | Item | Grok | Driver | Ruling |
|---|---|---|---|---|
| 1 | Nous retention / coach provider | reject Nous, 503 stays | same | **agree** |
| 2 | Oura app, ring, PKCE | no registration tonight, PKCE closed | same | **agree** (driver's extra empty-pull warning dropped as scope) |
| 3 | HAE vs Shortcut | HAE, parse `units` | same | **agree** |
| 4 | Approver | Sasha-only | same | **agree** |
| 5 | Qualified-day thresholds | confirm, pin test | same | **agree** |
| 6 | Units, Body tab, Coach tab | confirm as shipped | same | **agree** |
| 7 | Second pending proposal | partial unique index + one-transaction RPC | reorder to reject-then-insert | **Grok** (DB-enforced invariant) |
| 8 | Streaming | no | same | **agree** |
| 9 | Deflection false positives | corpus is the log; no live canary tonight | same | **agree** |
| 10 | §4.3 claims 1a/1b | restate 1b to 21.4 %, 1a on matched control | fix 1b in the estimator first, restate as fallback | **Grok** (a second smoother tonight risks claims 2/3; recorded as follow-up) |
| 11 | PR #41 phone gates | land now, gates to the handoff | same, run two gates tonight | **Grok** (all four gates to the handoff) |
| 12 | PR #18 and dependabot | close all six | close #18, #5, #6; land #2-#4 after CI | **Driver** (CI-action bumps are SHA-pinned and CI-validated) |
| 13 | catalog_synonyms / catalog_barcode_lookups RLS | enable, advisor ERROR wins | same | **agree** |

## 1. Nous retention record and the coach provider
**RULING.** Nous is rejected for gut and condition notes. `NOUS_RETENTION_CONFIRMED` stays `false`. A coach turn that
carries conditions or notes calls no model (`503 nous_unconfirmed`). Non-health coach turns stay on Gemini. The unpaid
Gemini project is an accepted limit for Phases 3-4 capture until Devin enables billing.
**WHY.** Nous Portal privacy (2026-06-11) and terms §9.2, §12.3: retain and train by default, six-month retention after
termination, Privacy Mode is prospective only and unaudited, no health clause. Gemini unpaid terms (2026-04-28): "do not
submit sensitive, confidential, or personal information". Gemini paid: no training use, named DPA, 55-day abuse window.
`architecture.md` §6 forbids real user data through an unpaid project; PR #40 proved the key is free tier.
**DO.** `docs/ai-data-handling.md` gets the dated Nous verdict and its "do not leave Gemini" line is corrected to match
the 503 gate; a test pins that a profile with conditions or notes never reaches an adapter call; README line 1 closed.
`architecture.md` §6 (the paragraph that states the Gemini project is paid and that a Phase 0 check fails the build on
an unpaid key) is amended to record the accepted limit and the current state of that check. In production the AI
capture flags (`CAPTURE_METHODS` / `NEXT_PUBLIC_CAPTURE_METHODS`) and the coach flags stay unset until billing is on:
"accepted limit" means the app ships with AI capture and coach off, not that user data goes through the unpaid key.
**OWNER.** Enable Cloud Billing on the Gemini project (no key change), confirm with `scripts/ai-canary.ts`, then a
follow-up commit may route health-context turns to paid Gemini (never Nous). Optional: request Gemini ZDR.

## 2. Oura
**RULING.** The confidential authorization-code flow with `state` is final. PKCE is closed: Oura documents only
client-secret and implicit flows, so it is not added. No app is registered in this wave.
**WHY.** `cloud.ouraring.com/docs/authentication` (no `code_challenge`); Oura support article 4415266939155: Gen3 and
later need an active Membership or partner apps get no data; access tokens 30 days, refresh tokens single-use.
Registration needs an Oura account made in the consumer app, which the agents do not hold.
**DO.** `architecture.md` §5.2 records the verdict; `.env.example` redirect is `/api/health/oura/callback` (landed in
PR #45); a test asserts the authorize URL carries no `code_challenge`; the start route fails closed without env.
**OWNER.** Confirm the ring is Gen3 or later with an active Membership. Sign in at cloud.ouraring.com with that account,
register the app (redirect exactly `https://<production host>/api/health/oura/callback`, scopes `daily personal`), set
`OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_REDIRECT_URI`, `HEALTH_TOKEN_KEY`, `HEALTH_TZ` on Vercel, then
`HEALTH_INGEST_ENABLED`, then Settings -> Connect Oura once.

## 3. Health Auto Export vs hand-built Shortcut
**RULING.** Health Auto Export is the ingest path and receives the manual gate; the Shortcut stays a documented fallback.
**WHY.** W4-2 already chose it; both paths are bound by Apple's locked-device rule (help.healthyapps.dev), HAE has
schedules, logs and retries. HAE emits a per-value `units` field and does not document its default weight unit.
**DO.** `docs/health-auto-export.md` marks §A as the gated path; the ingest normaliser is proven to accept weight in
`lb` and `kg` and store kilograms (fixture test).
**OWNER.** Install Health Auto Export (Basic suffices for an unlocked run; Premium adds background sync), point the REST
automation at production `/api/health/ingest` with the minted bearer, metrics Steps, Active Energy, Weight & Body Mass,
Sleep Analysis, daily 06:30, phone unlocked or charging.

## 4. Approver
**RULING.** Sasha-only approval is final; `decided_by` is her `auth.uid()`; a Devin grant model is a later phase.
**WHY.** RLS plus `_sync_assert_caller` inside `approve_target_proposal` enforce it twice; the RPC takes `p_user_id`
explicitly, so a grant table can come later without a rewrite.
**DO.** Spec open question 1 and README item 4 closed; the cross-user proposal test stays as the guard.

## 5. Qualified-day thresholds
**RULING.** `energyCoverage >= 0.95`, `kcal >= 1000`, `kcal_min = 1650` are contract values.
**WHY.** They are the spec's reasoned proposal, the backtest ran on them, and claims 2, 3a, 3b pass at them. Moving them
to paint an artefact claim green would be a tuned constant (contracts §7).
**DO.** A pin test asserts the two exported constants and the SQL default; spec open questions 3 and 5 closed.

## 6. Weight unit, Body tab, Coach tab
**RULING.** Pounds on screen, kilograms stored; no fifth Body tab (Settings row plus Today chip); the Coach tab renders
on `NEXT_PUBLIC_COACH_ENABLED` (a build-time client flag) and the coach route answers on `COACH_ENABLED` (server); the
code guards each side alone, so "flip both together" is an operations rule for Vercel, not a code guard. Production
flag order stays Phase 5 -> 6 -> 7.
**WHY.** Shipped in PR #45 exactly so (`lib/health/units.ts`, `components/BodyDashboard.tsx`, `components/TabBar.tsx`),
guarded by `tests/tabbar/flags-off.test.tsx`.
**DO.** README item 6 closed; `.env.example` notes the two coach flags flip together. No flag is set on Vercel in this
wave.
**OWNER.** After ingest delivers days: `ESTIMATOR_ENABLED`, then both coach flags, never coach first.

## 7. Second pending proposal
**RULING.** The newer Sunday proposal replaces the older pending one, enforced in the database: a partial unique index
on `target_proposals (user_id) where status = 'pending'` and one security-definer RPC that rejects other pending rows
and inserts the new one in a single transaction. The weekly job calls that RPC.
**WHY.** The two-statement insert-then-update could leave two pending rows after a crash; the index makes that
impossible and the RPC makes the happy path atomic. This is Phase 6 code; `lib/sync/**` and
`lib/server/privileged.ts` stay owned by Phase 0.
**DO.** Migration, RPC, route change and tests on `feat/p6-estimator` (PR #42); spec open question 6 closed.

## 8. Streaming coach replies
**RULING.** No streaming; one JSON turn; the policy pass scores the whole answer.
**WHY.** Merged in PR #43 as `Response.json(await runTurn(...))`; streaming would split policy over partial tokens.
**DO.** README item 8 closed.

## 9. Deflection false positives
**RULING.** `lib/coach/fixtures/injection-corpus.ts` is the only review log. A miss found on the phone becomes a
corpus row with its expected outcome in the same PR; the stub suite in CI must stay green; each live canary run commits
`docs/coach-canary-YYYY-MM-DD.md`. No live canary runs in this wave (unpaid Gemini, Devin's key).
**DO.** Process written to `docs/coach-deflection.md`, linked from the Phase 7 spec.
**OWNER.** After the coach flags are on: first phone session, paste any bad deflection into the corpus, optionally run
`pnpm exec tsx scripts/coach-injection-canary.ts`.

## 10. Lane Q §4.3 claims 1a and 1b
**RULING.** Claim 1a keeps its <= 5 % bound, measured on a matched-seed control (same LCG seed, artefact only), which
reads 3.3 % against 5.4 % unmatched. Claim 1b is restated from <= 5 % to <= 21.4 %, the measured figure, because with
alpha = 2/21 the EMA gain at a 28-day period is about 0.41 and `trend[t] - trend[t-14]` is antiphase at that period, so
5 % is unreachable without a second smoother or a tighter prior clamp. Both are contract changes recorded in
`architecture.md` §4.3; the tests assert exactly these bounds and are not skipped. A second smoother that cancels the
28-day cycle is recorded as a follow-up contract change (lane-Q open question 3), not done in this wave, because it
puts passing claims 2, 3a and 3b at risk on a ship night.
**WHY.** Contracts §7: measured gates are never lowered by a tuned constant; a restated bound must carry the measured
figure and the reason. `docs/estimator-backtest-2026-09-12.md` records both misses and the matched control.
**DO.** On `feat/p6-estimator`: §4.3 text, backtest tests (`CYCLE_MAX_PCT = 0.214`, matched-control 1a), script and doc
refreshed byte for byte. `MIN_ENERGY_COVERAGE`, `MIN_QUALIFIED_KCAL`, alpha and the prior clamp are untouched.

## 11. Wave 3 PR #41
**RULING.** PR #41 lands now. The four phone gates (three scans under 5 s, three-item text meal, airplane mode vs
search, MCP `method` and `confidence`) move to the mobile test handoff as owner steps; they are the test, so they cannot
block the merge that enables it. The unpaid Gemini project is an accepted limit for Phase 3-4 capture; no billing change.
**WHY.** With every flag unset, landing changes no screen (contracts §6). Two gates need a phone and camera. The AI
capture flags stay unset in production until the Gemini billing owner step (ruling 1).
**DO.** Landed as `b0ffc81`; Supabase branch `p3-4-integration` is destroyed in the tidy stage of this wave; the
handoff file lists the four gates.

## 12. PR #18 and dependabot #2-#6
**RULING.** PR #18 is closed as superseded, branch kept: the release B cut-over never ran and phases 1-7 shipped on
release A's model, so a future cut-over is a fresh PR after a backfill that matches the current schema. `lib/sync.ts`
and `lib/server/privileged.ts` stay owned by Phase 0. Dependabot #2, #3, #4 (GitHub Actions bumps, SHA-pinned,
CI green) land; #5 (TypeScript 6) and #6 (`@types/node` 26) are closed as deferred majors, to be reopened after the
mobile test round. Note for Devin: `ci.yml` pins `pnpm/action-setup` with a `v4.4.0` comment while dependabot reports
5.0.0; the comment is stale, the SHA is what runs.
**WHY.** #18 is CONFLICTING and untouched since 2026-09-11; a major TypeScript bump on ship night is avoidable risk;
action bumps are validated by the CI run that merges them.

## 13. catalog_synonyms and catalog_barcode_lookups RLS
**RULING.** The production security advisor's `rls_disabled_in_public` finding (ERROR) supersedes the "no RLS" clause
written for these two tables. Both get the `catalog_grants.sql` shape: row level security on and forced, one
`<table>_read` select policy for `authenticated` using `(true)`, and no other change to their grants — `authenticated`
keeps select-only, `service_role` keeps all. The tables' writers (`catalog_write_provider_revision`'s barcode-lookup
recording, `scripts/load-synonyms.ts`) are already service_role paths, so forcing RLS does not touch them.
**WHY.** `docs/plans/2026-09-11-phase-3-4/00-contracts.md` §2 line 53 and §7 lines 280-281 both specify "no RLS" for
these tables, matching the header comment of `20260921090000_catalog_synonyms.sql` ("carries no RLS policy") and
`lane-K-barcode.md` line 1274's test assertion. That was a deliberate call at the time (both tables are shared,
read-only reference data with no user rows, the same shape as `catalog_nutrients`), but the readiness sweep's advisor
treats `rls_disabled_in_public` as an ERROR regardless of whether a table holds user data, and the readiness contract
requires zero ERROR-level findings on production. A contract change is recorded here, not by editing the old contract
file or the old migration's header — both stay as the historical record of the original call.
**DO.** `supabase/migrations/20261008090000_catalog_rls_lint.sql` (+ down file) enables RLS on both tables.
`tests/barcode/schema.test.ts` and `tests/catalog/grants.test.ts` are updated to assert RLS on, not off, for
`catalog_barcode_lookups` and `catalog_synonyms` respectively.

## Landing mechanics (recorded per the house rule)
This repository has no ruleset, no branch protection and no merge queue (`gh api .../rulesets` is empty). `zs-land`
squash-merges one PR and syncs main each time, so PRs land one after another by tooling, not by choice. Order this
wave: #41, #45, #2-#4, then #42 after rulings 5, 7 and 10 are applied, then a Q wiring PR that completes the
integration stage (`registerExpenditureTools`, estimator mounts, `estimate` and `weekly-proposal` crons,
`ESTIMATOR_ENABLED` / `NEXT_PUBLIC_ESTIMATOR_UI`), which PR #45 deferred while Q was a draft. If Devin wants parallel
landing later, the fix is a ruleset with a merge queue on `main`.

## Owner steps, collected
1. Gemini: enable Cloud Billing on the project; confirm with `scripts/ai-canary.ts`; then flip Phase 4 capture flags and
   the coach flags.
2. Oura: confirm Gen3+ ring and Membership; register the app; set the five `OURA_*` / `HEALTH_*` variables; flip
   `HEALTH_INGEST_ENABLED`.
3. Health Auto Export: install, configure the REST automation with a minted token.
4. Phone gates from PR #41 (four items) in the mobile test handoff.
5. Flag order in production: Phase 5, then `ESTIMATOR_ENABLED`, then both coach flags.
6. Reopen dependabot #5 and #6 after the mobile test round.
7. Supabase branch `p1-catalog` (Phase 1 leftover, persistent, about $0.013/h): delete or keep.
