# Priority spec list, 2026-10-10

This list holds 160 work items (W001 to W160) from the 2026-10-10 audit. Each item has a goal, done checks, files, risks, dependencies and sources. There are 22 P0, 44 P1, 62 P2 and 32 P3 items across 23 lanes. 24 items are owner-only steps. 26 owner decisions block some items. Work runs in five waves. A wave is the item's dependency depth, raised to a floor by priority. Wave 1 holds 16 items, all P0.

Related files: [dependency graph](2026-10-10-work-graph/dependency-graph.html), [roadmap](2026-10-10-work-graph/roadmap.html), [work-graph.json](2026-10-10-work-graph/work-graph.json), audit evidence in `docs/audit/2026-10-10/`, architecture notes in `docs/architecture/2026-10-10/`.

## Counts

### By priority

| Priority | Items |
|---|---|
| P0 | 22 |
| P1 | 44 |
| P2 | 62 |
| P3 | 32 |
| Total | 160 |

### By lane

| Lane | Items | P0 | P1 | P2 | P3 |
|---|---|---|---|---|---|
| capture-catalog | 6 | 2 | 1 | 2 | 1 |
| coach-ai | 18 | 1 | 4 | 7 | 6 |
| docs-tests | 14 | 0 | 2 | 6 | 6 |
| food-policy | 6 | 3 | 0 | 3 | 0 |
| food-world | 10 | 0 | 1 | 4 | 5 |
| health | 3 | 1 | 1 | 0 | 1 |
| logging | 2 | 0 | 0 | 2 | 0 |
| nutrition-engine | 5 | 3 | 0 | 2 | 0 |
| onboarding | 3 | 1 | 0 | 1 | 1 |
| owner | 24 | 3 | 7 | 12 | 2 |
| recipes-shopping | 3 | 0 | 1 | 2 | 0 |
| scale | 5 | 0 | 5 | 0 | 0 |
| security | 12 | 2 | 7 | 3 | 0 |
| server-api | 3 | 1 | 1 | 1 | 0 |
| server-dates | 2 | 0 | 2 | 0 | 0 |
| server-db | 7 | 0 | 3 | 3 | 1 |
| server-ops | 5 | 2 | 2 | 0 | 1 |
| sync | 5 | 1 | 3 | 1 | 0 |
| targets-safety | 5 | 2 | 1 | 2 | 0 |
| ui-foods | 4 | 0 | 0 | 3 | 1 |
| ui-pwa | 1 | 0 | 0 | 1 | 0 |
| ui-settings | 2 | 0 | 0 | 2 | 0 |
| ui-today | 12 | 0 | 3 | 5 | 4 |

## Owner decisions

| ID | Question | Blocks | Recommendation |
|---|---|---|---|
| OD01 | AI spend: raise the global daily cap from $50 to $150-200 and split it into an interactive share and a background cap? | W043, B101 | Yes: global $150, 70% reserved for interactive turns, background jobs capped at $30/day; revisit after a month of spend alerts. |
| OD02 | Error tracker and uptime monitor: approve a vendor (new spend) or use Vercel built-ins only? | W042 | Use Sentry free tier plus Vercel monitoring; uptime via a free checker on /api/health. No paid tier until 1,000 users. |
| OD03 | Hosted backup: buy Supabase PITR or run a scheduled pg_dump off the laptop? | W046 | Scheduled pg_dump from GitHub Actions to private storage now (no new vendor); buy PITR when the paid tier is next upgraded. |
| OD04 | Coach Undo receipts PR B: restart with a server-minted write identity, or drop the receipts lane? Also: keep or retire coach target, weight and planned-meal writes? | W086, W129, B032 | Restart PR B scoped to the three v1 kinds with server-minted identity; keep coach target writes but route them through the Phase 12 checked writer. |
| OD05 | Voice-to-voice coach (Phase 14): build, retire the spec, or defer to a native app? | B023, W031 | Formally retire the Phase 14 spec in the voice-retirement branch; revisit only with a native app. |
| OD06 | Coach streaming and json-render/A2UI: build streaming now? | W091, B074 | Measure first; build streaming only if first-text p95 stays above 6 s after the measurement item. |
| OD07 | AI-capture auto-resolve: keep the unreachable 0.95/0.30 gate, or move to a per-method measured gate? Plus Phase 4 open questions (iOS audio canary, caps, photo-grams default). | W125, B048, B064, B042 | Keep auto-resolve off until the capture eval reaches 85% top-1; then a per-method gate. Photo items default to the model grams. |
| OD08 | Catalog search contract: dish-vs-ingredient penalty and generic typo fold; Phase 1 category normalization and FNDDS sizing questions. | B005, B006 | Add a dish-marker penalty for 1-2 word queries and a 0.6 typo fold, both behind the R1 relevance gate; close the Phase 1 questions as recorded. |
| OD09 | Phase 3 questions: OFF negative-cache window, recipe cooked-weight capture, FDC Branded vault key. | B019 | Keep 7 days, defer cooked weight to the recipe-yield work, name the vault key in docs. |
| OD10 | Recipe search honest "no match", recipe catalog growth, over-target day flag and water-dial snap. | B022, B257, B277 | Show honest no-match using the catalog food words; flag over-target days; snap the dial; grow to 48 recipes after the pilot widens. |
| OD11 | Clinical sign-off: who reviews condition-pack wording and the rebalance panel copy before CONDITION_PACKS_ENABLED and REBALANCE_PANEL_USER_IDS? | B049, B176, B237, W092, W112 | Ask Sasha's nutritionist to review both in one session; keep both flags off until the signed record is in docs/decisions. |
| OD12 | TypeSafe health text: email privacy@typesafe.ai about terms vs ZDR DPA, set JEV_HEALTH_ATTESTED, and decide the data-use notice. | B045, B109, B046 | Send the email; keep JEV_HEALTH_ATTESTED unset and the local gate fail-closed until a DPA is signed; add the notice only if a vendor trains on data. |
| OD13 | Open-world priors and learning scope: UK Biobank like term, cross-user taste learning T3, shopping-focus and pantry-photo gates, W15 go. | B185, B205, B186, B187, B183, W097 | Keep the like term absent, no T3, shopping focus and pantry photo pilot-only until open-world release; run W15 once onb3 is live. |
| OD14 | Tracked micronutrient set, fiber band display, coverage semantics and exercise logging ownership. | B123 | Confirm the twelve codes, gram-weighted coverage, and drop exercise logging from the export until it has an owner. |
| OD15 | Legacy foods/days/settings tables exist in production but in no migration: drop, or add a baseline migration? | B150 | Back up, then drop the three empty tables in production so a rebuilt environment matches. |
| OD16 | Duplicate-meal card: finish or drop? | W095, B083, B273 | Finish it; the schema change goes through the normal migration review. |
| OD17 | Cards v4 Board/Overview rulings: tip paging location and the 49% grey ring track. | W115, B082 | Move paging into the full tip view; lighten the ring track to the hairline token. |
| OD18 | Creatine/supplement tick (F-115). | B090, B284 | Defer until a second account asks for supplements. |
| OD19 | Sprout sulking and the hidden Edit button. | B268, W145 | Sprout sulks only when poked, never on food or water shortfall; keep Edit in the long-press tray. |
| OD20 | Health: keep sleep stages or totals only; weight display unit. | B263 | Totals only; unit is already in user_settings. |
| OD21 | Who may change goal_rate_bp_week (Phase 6 OQ4) and the adaptive TDEE R3/R9 revisit timing. | B243, B244 | Close OQ4 as superseded by onboarding pace chips; revisit R3/R9 after 30 days of the day-complete control. |
| OD22 | Four v2-onboarded accounts with 29 unchosen starter foods; the Oct 4 meal changes in Devin's data. | B253, B094 | Leave the starter foods; Devin confirms whether the Oct 4 changes were his own. |
| OD23 | Native iOS wrapper / HealthKit direct (Apple Developer account cost). | B260, W144 | Defer; the Shortcut path serves the PWA. |
| OD24 | Review coach fast-path thresholds after 100 eligible production turns. | B072 | Hold thresholds; review when telemetry shows 100 eligible turns. |
| OD25 | Close the Phase 10/11 onboarding specs as superseded and retire the onb2 backup branches. | B246, B167, W150, W132 | Yes: mark both specs superseded by onb3 and delete the backup branches after a diff. |
| OD26 | compose_meal four-food-term cap and regional priors scope. | W156, B224, B220, W155 | Keep the four-term cap; defer regional priors. |

## Waves

A wave is the item's dependency depth, raised to a floor by priority: P0 from wave 1, P1 from 2, P2 from 3, P3 from 4.

### Wave 1 (16 items)

- W001 Rotate leaked secrets and record receipts (P0, owner)
- W002 Confirm repo stays private; find why it went public (P0, owner)
- W003 Reconcile production migration ledger; record apply receipts (P0, server-ops)
- W004 Energy rule: no unmeasured nutrient as 0; measured energy on account foods (P0, nutrition-engine)
- W007 Target safety on every server write path (P0, targets-safety)
- W009 Legacy onboarding and Edit profile: crash, safety round, weigh-in (P0, onboarding)
- W010 Health ingest: one transaction; correction upsert fixes (P0, health)
- W011 Sync merge conflicts that lose or duplicate edits (P0, sync)
- W012 Exports: page past 1,000 rows; validate cursors; add provenance (P0, server-api)
- W013 Capture and log sheet portion maths (P0, capture-catalog)
- W014 Food rules parity on coach writes, imports, barcode, starters (P0, food-policy)
- W016 Nightly backup: complete, consistent, time-bounded (P0, server-ops)
- W019 Media storage: uploads, sweep, path traversal, EXIF (P0, security)
- W020 Coach shopping-apply: one account per apply (P0, coach-ai)
- W021 Verify Floor Day Avoid check and low-FODMAP unknowns (verify) (P0, food-policy)
- W022 Allergen evidence fixes (verify) (P0, food-policy)

### Wave 2 (31 items)

- W005 Owner: re-import Foundation and run the energy backfill on production (P0, owner)
- W006 Weekly proposal and TDEE intake correctness (P0, nutrition-engine)
- W008 Remove first-client 1650 kcal floor from coach floors (P0, targets-safety)
- W015 Bundled food data and portion bands (P0, nutrition-engine)
- W017 Capture and log flow fixes (P0, capture-catalog)
- W018 Lock down server-owned tables from direct PostgREST writes (P0, security)
- W023 Renumber parked migrations that collide on 20261229090000 (P1, server-ops)
- W024 Shopping planner preview crashes (P1, recipes-shopping)
- W025 Oura data correctness and redirect (P1, health)
- W026 Sync outbox ordering and liveness (P1, sync)
- W028 Coach fast-path and action correctness (P1, coach-ai)
- W029 Food membership and Favor consistency (P1, food-world)
- W030 Today meal cards: dates, Quick meals, swap and tick state (P1, ui-today)
- W034 Database lock order (P1, server-db)
- W035 Coach turn budget and limits (P1, coach-ai)
- W037 MCP route hardening (P1, security)
- W038 Scale: unbounded reads on hot paths (P1, server-api)
- W039 Test guards that cannot fail (P1, docs-tests)
- W040 Confirm DB-backed suites run in CI (P1, docs-tests)
- W050 Team-scoped Vercel token (P1, owner)
- W051 Auth production config (P1, owner)
- W052 Server-side limits for OTP and password sign-in (P1, security)
- W053 App-hardening branch (P1, security)
- W055 x-smc-account on every route (verify) (P1, security)
- W056 Unscoped legacy device storage (verify) (P1, security)
- W059 Barcode foods in name search (P1, capture-catalog)
- W061 Owner: physical-device acceptance (P1, owner)
- W062 Owner: re-test onb3 and flip the onboarding flag (P1, owner)
- W064 Owner: delete the production smoke-test account (P1, owner)
- W065 Measure coach and capture speed (verify) (P1, coach-ai)
- W066 Owner: resolve the Gemini project 403 (P1, owner)

### Wave 3 (67 items)

- W027 Log mirror reconcile races (verify) (P1, sync)
- W031 Finish voice retirement and account-zone precedence branch (P1, server-dates)
- W033 Phone dates and slot clocks, and .ics export (P1, ui-today)
- W036 Plan-sheet imports (P1, coach-ai)
- W041 Scale step 1: measure (P1, scale)
- W042 Scale step 2: alerts (P1, scale)
- W043 Scale step 3: AI budget policy (P1, scale)
- W045 Scale step 5: safety quick fixes (P1, scale)
- W054 Supabase advisor backlog (P1, security)
- W057 Self-serve account deletion (P1, security)
- W058 Honest-nutrition UI cleanup (t1h) (verify) (P1, ui-today)
- W060 Phase 12 checked-writer cutover (P1, targets-safety)
- W063 Owner: production data-repair script runs (P1, owner)
- W067 Care points ledger: server-side balance sum, full-week accolade on any sync, no raise on zone-day mismatch (P2, ui-today)
- W069 API input validation: shared calendar-date, UUID and limit parsers; catalog search trim and detail checks (P2, server-api)
- W074 goal_rate_bp_week preset CHECK on target_profiles; recheck confirm-your-rate invitation need (P2, targets-safety)
- W075 Extend test_reset_user for about 19 newer user-owned tables (P2, docs-tests)
- W076 Endpoint security matrix test: identity, body limit, rate limit, idempotency per route (P2, docs-tests)
- W077 Identify and fix the flaky test trio (F7) and close ruling follow-ups (P2, docs-tests)
- W078 CI and test secret hygiene: fix six zizmor warnings, add a zizmor step, move DB URL out of argv (P2, security)
- W079 Full script-src CSP plus Lighthouse mobile and bundle-size CI gates (P2, security)
- W080 HEALTH_TOKEN_KEY rotation / re-seal script (P2, security)
- W081 Env-name drift: HEALTH_INGEST_TOKEN, production-only env names, dark rollout flags and their state (P2, docs-tests)
- W082 Owner: health production rollout (P2, owner)
- W083 Owner: widen CAPTURE_METHODS one method per deploy (P2, owner)
- W085 Recipe pilot acceptance gaps (P2, recipes-shopping)
- W086 Coach Undo receipts PR B: apply_coach_op writer (P2, coach-ai)
- W087 Coach live quality and privacy pass (verify) (P2, coach-ai)
- W088 Transactional coach thread and message saves (P2, coach-ai)
- W089 Raise Jev MAX_LOGICAL_CALLS for plan-sheet chips and update the one-call test and W10 spec text (P2, coach-ai)
- W090 ExportCard: narrow the "Everything you have logged" claim; check closed-gate health context in coach (verify) (P2, ui-settings)
- W091 Stream coach replies (first visible text 3 s or less) (P2, coach-ai)
- W093 Owner: Phase 19b R0 drift study and first-client consent (P2, owner)
- W094 TDEE step F test-suite audit (verify) (P2, nutrition-engine)
- W095 Duplicate-meal detection end to end (P2, logging)
- W096 Replay already-consumed plan_days feed rows (P2, sync)
- W097 W15 onboarding ablation: arm assignment, shell hook, report job (P2, onboarding)
- W098 W13 UI: Favored copy, star toggle, Settings world switch, invitation screen (P2, ui-foods)
- W099 Reason chips on generated meals, swap rows and coach composed cards (P2, ui-foods)
- W100 Shopping "Use my list" toggle, end date and Undo (W11) (P2, recipes-shopping)
- W101 "Not verified / Evidence under review" copy for held allergens; cuisines/country/taste screen completeness (verify) (P2, ui-foods)
- W102 Pass food_world into suggestion input so shortage copy knows open vs closed world (D13) (P2, food-world)
- W103 Taste chips: first-time account 409 and stale TasteChipsCard (P2, food-world)
- W104 Recover 36 Not-verified Eats foods: diet-label ingredient parser (P2, food-policy)
- W105 Wire contains_ingredient template facet in profile hard rules; tree-nut allergen key and policy coverage (P2, food-policy)
- W106 Dietary profile map: remaining facets and rubrics with calibration, plus third Sol review round (P2, food-policy)
- W107 Real-phone planDay benchmark and snapshot telemetry (P2, food-world)
- W108 Feed pref-2 ranking inputs and run the replay report (P2, food-world)
- W109 Owner: label universe plate sheet 1.1.0 and review CUISINE_STAPLES (P2, owner)
- W110 Owner: universe and cuisine-tier human review, rename decisions, annotate-universe production run (P2, owner)
- W111 Owner: run star-to-favored --production and record it (P2, owner)
- W113 Owner: occasion-facet calibration holdout review, then facets-occasion-eval --live --freeze (P2, owner)
- W114 Owner: FNDDS inputs production import (P2, owner)
- W115 Meal Cards v4 redesign passes 2-4, critiques, Sol review and wiring (P2, ui-today)
- W116 Island views #470 leftovers (verify) (P2, ui-today)
- W117 Widget-save failure notice (P2, ui-today)
- W118 Service-worker waiting-worker race (P2, ui-pwa)
- W119 Idle-loop CPU profiling for pond and water scenes (P2, ui-today)
- W120 Small UI fixes: scan-unavailable notice, sex picker "unspecified", Coach change card on token-less devices (verify) (P2, ui-settings)
- W121 Authenticated-browser verification re-baseline (P2, docs-tests)
- W122 Owner: production-readiness steps (P2, owner)
- W123 Save, re-use, swap (T5): Log again, "You logged this before", Recent meals swap row (P2, logging)
- W124 Label scan T3: dedupe repeat scans, 10-label eval, latency targets, scanned food star (P2, capture-catalog)
- W125 Plate photo T2: candidate-aware grounding, per-method gate, thumbnail, EXIF time, editable name, Save-as-recipe (P2, capture-catalog)
- W126 Phase 11: re-audit shipped conversation triggers and RPCs against round-13 spec (verify) (P2, coach-ai)
- W127 Docs reconciliation (P2, docs-tests)
- W128 Owner: delete persistent Supabase branch p1-catalog (P2, owner)

### Wave 4 (45 items)

- W032 Account-day dates on the server (P1, server-dates)
- W044 Scale step 4: indexes and retention (P1, server-db)
- W046 Scale step 6: hosted backup (P1, server-ops)
- W047 Scale step 7: cut fan-out (P1, sync)
- W048 Scale step 8: replay receipts, change_log compaction (P1, server-db)
- W049 Sign-up load test and job-sweep soak (P1, scale)
- W068 AI call layer: abort before retry, caller aborts not counted toward circuit, status-only provider errors, spend seed (P2, coach-ai)
- W071 Scale step 9: single-round-trip RPCs (apply_sync_ops batch with stamping, consolidated log commit, queued per-account jobs) (P2, server-db)
- W072 Scale step 10: remove O(users) work (global catalog-ref revision, compute-tier triggers, partition big tables before Tier C) (P2, server-db)
- W073 Phase 12 Later: floor check at proposal approval, one transaction for profile+target, weigh-in retarget RPC, below-minimum warning (P2, targets-safety)
- W084 Owner: recipe/shopping pilot production deployment and wider enablement (P2, owner)
- W092 Phase 19b day rebalance (P2, nutrition-engine)
- W112 Owner: release open world (P2, owner)
- W129 Coach Undo receipts for remaining action kinds and parked feat/undo-followups cleanup (P3, coach-ai)
- W130 Owner: label 432 pairing holdout pairs, then jev-labels and calibrate with W8 replay-lift record (P3, owner)
- W131 Architecture refresh for phases 9-19 in docs/architecture.md (fill or remove empty 2026-10-10 directory) (P3, docs-tests)
- W132 Repo hygiene: delete landed and backup wip branches (week-entry-scan, onb2-*, proto/wet-island, fix/well-open-glare) after diffing (P3, docs-tests)
- W133 Reopen dependency majors as separate PRs: TypeScript 6, motion 14, npm minor group; keep Node 22 types (P3, docs-tests)
- W134 Redesign down migrations so they preserve data (P3, server-db)
- W135 W14 Taste T2: taste_models migration, trainer, leakage-free replay and report (data-gated: 60 days of W6 signals) (P3, food-world)
- W136 Jev short-list veto: adjudicate 60 vetoes for the live gate (stays shadow until then) (P3, food-world)
- W137 Open-world date change uses stale v3 set for ~300 ms before rules-version recheck (P3, food-world)
- W138 Meal-planning follow-ups t20 (O4 gaps) and t22 (O3 gate prerequisites); facet warming in coach grounding and log commit (verify) (P3, food-world)
- W139 Capture and UI minors: CaptureSheet lane-L items, Undo behind standing error, 12-meal text cap, swapped alternative verdict lookup, N+1 lookups (verify) (P3, capture-catalog)
- W140 Coach small items: tool-schema .positive() and NOUS_* names, chart-claim verifier rule, abort transcribe on page hide, weekday-series per-date titles (verify) (P3, coach-ai)
- W141 Slot editing Phase C (build from any items, verify) and Phase D "Make this my usual" (P3, ui-today)
- W142 Jev day_completeness nudge before "Day fully logged" (P3, coach-ai)
- W143 Deferred coach ideas: Phase 12 Later capabilities, account memory, Jev swap/bridge, gut-log correlation, multi-day plans, recall_conversations (verify) (P3, coach-ai)
- W144 Deferred integrations: native shell, Garmin, Health Connect, Withings, web push and out-of-app notifications, ChatGPT connector (P3, health)
- W145 Sprout and companions: stored state (streaks, growth), shop wearables and per-companion art (P3, ui-today)
- W146 Quarterly catalog refresh job (F-107) and build-time unpaid Gemini-key gate (F-120) (P3, server-ops)
- W147 Act on the weekly model-freshness issue (lane-bench PR if a pin should change) (P3, coach-ai)
- W148 Truly remove an "Other foods" row (new stored state) (P3, ui-foods)
- W149 Split tests/search/recall.test.ts under the 400-line soft limit (P3, docs-tests)
- W150 Onboarding Phase 10 Later gaps: offline turns, draft expiry, thread delete, Add-from-onboarding; G10-G12 clinician numbers and rounding (verify against onb3) (P3, onboarding)
- W151 Phase 9 per-user day templates: keep as spec-only Later (no build) (P3, docs-tests)
- W152 FluidVoice UI recovery acceptance ledger at 320/390/430/1024 (verify) (P3, docs-tests)
- W153 Four selectable background themes (P3, ui-today)
- W154 Owner housekeeping: confirm Vercel billing card, rename provisional ZS Vault entry, supply board videos and nutritionist tips (P3, owner)
- W155 Regional priors (state-level NHANES, Canada CCHS) and photoToIdeas byte-size telemetry (P3, food-world)
- W156 compose_meal on the lib/meals engine: pinned foods, incomplete named draft result (P3, coach-ai)
- W157 Day-strip seven 44 px targets below 360 px (verify) (P3, ui-today)
- W158 Restaurant and chain-menu nutrition source (Nutritionix vs alternatives) (P3, research)
- W159 Food recall alerts from Daily Food Recalls (P3, research)
- W160 Household-unit densities from ExactCup (P3, research)

### Wave 5 (1 items)

- W070 Telemetry and event tables: revoke direct INSERT, rate-checked writers, client_timings checks NOT VALID then VALIDATE (P2, server-db)

## Index

| ID | Title | Priority | Lane | Size | Owner-only |
|---|---|---|---|---|---|
| W001 | Rotate leaked secrets and record receipts | P0 | owner | S | yes |
| W002 | Confirm repo stays private; find why it went public | P0 | owner | S | yes |
| W003 | Reconcile production migration ledger; record apply receipts | P0 | server-ops | M | no |
| W004 | Energy rule: no unmeasured nutrient as 0; measured energy on account foods | P0 | nutrition-engine | M | no |
| W005 | Owner: re-import Foundation and run the energy backfill on production | P0 | owner | S | yes |
| W006 | Weekly proposal and TDEE intake correctness | P0 | nutrition-engine | M | no |
| W007 | Target safety on every server write path | P0 | targets-safety | M | no |
| W008 | Remove first-client 1650 kcal floor from coach floors | P0 | targets-safety | S | no |
| W009 | Legacy onboarding and Edit profile: crash, safety round, weigh-in | P0 | onboarding | M | no |
| W010 | Health ingest: one transaction; correction upsert fixes | P0 | health | M | no |
| W011 | Sync merge conflicts that lose or duplicate edits | P0 | sync | L | no |
| W012 | Exports: page past 1,000 rows; validate cursors; add provenance | P0 | server-api | M | no |
| W013 | Capture and log sheet portion maths | P0 | capture-catalog | S | no |
| W014 | Food rules parity on coach writes, imports, barcode, starters | P0 | food-policy | M | no |
| W015 | Bundled food data and portion bands | P0 | nutrition-engine | S | no |
| W016 | Nightly backup: complete, consistent, time-bounded | P0 | server-ops | M | no |
| W017 | Capture and log flow fixes | P0 | capture-catalog | M | no |
| W018 | Lock down server-owned tables from direct PostgREST writes | P0 | security | M | no |
| W019 | Media storage: uploads, sweep, path traversal, EXIF | P0 | security | M | no |
| W020 | Coach shopping-apply: one account per apply | P0 | coach-ai | S | no |
| W021 | Verify Floor Day Avoid check and low-FODMAP unknowns (verify) | P0 | food-policy | S | no |
| W022 | Allergen evidence fixes (verify) | P0 | food-policy | M | no |
| W023 | Renumber parked migrations that collide on 20261229090000 | P1 | server-ops | S | no |
| W024 | Shopping planner preview crashes | P1 | recipes-shopping | M | no |
| W025 | Oura data correctness and redirect | P1 | health | M | no |
| W026 | Sync outbox ordering and liveness | P1 | sync | M | no |
| W027 | Log mirror reconcile races (verify) | P1 | sync | S | no |
| W028 | Coach fast-path and action correctness | P1 | coach-ai | M | no |
| W029 | Food membership and Favor consistency | P1 | food-world | M | no |
| W030 | Today meal cards: dates, Quick meals, swap and tick state | P1 | ui-today | M | no |
| W031 | Finish voice retirement and account-zone precedence branch | P1 | server-dates | M | no |
| W032 | Account-day dates on the server | P1 | server-dates | S | no |
| W033 | Phone dates and slot clocks, and .ics export | P1 | ui-today | M | no |
| W034 | Database lock order | P1 | server-db | S | no |
| W035 | Coach turn budget and limits | P1 | coach-ai | M | no |
| W036 | Plan-sheet imports | P1 | coach-ai | S | no |
| W037 | MCP route hardening | P1 | security | S | no |
| W038 | Scale: unbounded reads on hot paths | P1 | server-api | S | no |
| W039 | Test guards that cannot fail | P1 | docs-tests | S | no |
| W040 | Confirm DB-backed suites run in CI | P1 | docs-tests | S | no |
| W041 | Scale step 1: measure | P1 | scale | S | no |
| W042 | Scale step 2: alerts | P1 | scale | S | no |
| W043 | Scale step 3: AI budget policy | P1 | scale | S | no |
| W044 | Scale step 4: indexes and retention | P1 | server-db | S | no |
| W045 | Scale step 5: safety quick fixes | P1 | scale | S | no |
| W046 | Scale step 6: hosted backup | P1 | server-ops | M | no |
| W047 | Scale step 7: cut fan-out | P1 | sync | M | no |
| W048 | Scale step 8: replay receipts, change_log compaction | P1 | server-db | L | no |
| W049 | Sign-up load test and job-sweep soak | P1 | scale | S | no |
| W050 | Team-scoped Vercel token | P1 | owner | S | yes |
| W051 | Auth production config | P1 | owner | S | yes |
| W052 | Server-side limits for OTP and password sign-in | P1 | security | S | no |
| W053 | App-hardening branch | P1 | security | M | no |
| W054 | Supabase advisor backlog | P1 | security | M | no |
| W055 | x-smc-account on every route (verify) | P1 | security | S | no |
| W056 | Unscoped legacy device storage (verify) | P1 | security | S | no |
| W057 | Self-serve account deletion | P1 | security | M | no |
| W058 | Honest-nutrition UI cleanup (t1h) (verify) | P1 | ui-today | M | no |
| W059 | Barcode foods in name search | P1 | capture-catalog | S | no |
| W060 | Phase 12 checked-writer cutover | P1 | targets-safety | M | no |
| W061 | Owner: physical-device acceptance | P1 | owner | M | yes |
| W062 | Owner: re-test onb3 and flip the onboarding flag | P1 | owner | S | yes |
| W063 | Owner: production data-repair script runs | P1 | owner | S | yes |
| W064 | Owner: delete the production smoke-test account | P1 | owner | S | yes |
| W065 | Measure coach and capture speed (verify) | P1 | coach-ai | S | no |
| W066 | Owner: resolve the Gemini project 403 | P1 | owner | S | yes |
| W067 | Care points ledger: server-side balance sum, full-week accolade on any sync, no raise on zone-day mismatch | P2 | ui-today | S | no |
| W068 | AI call layer: abort before retry, caller aborts not counted toward circuit, status-only provider errors, spend seed | P2 | coach-ai | S | no |
| W069 | API input validation: shared calendar-date, UUID and limit parsers; catalog search trim and detail checks | P2 | server-api | S | no |
| W070 | Telemetry and event tables: revoke direct INSERT, rate-checked writers, client_timings checks NOT VALID then VALIDATE | P2 | server-db | S | no |
| W071 | Scale step 9: single-round-trip RPCs (apply_sync_ops batch with stamping, consolidated log commit, queued per-account jobs) | P2 | server-db | M | no |
| W072 | Scale step 10: remove O(users) work (global catalog-ref revision, compute-tier triggers, partition big tables before Tier C) | P2 | server-db | M | no |
| W073 | Phase 12 Later: floor check at proposal approval, one transaction for profile+target, weigh-in retarget RPC, below-minimum warning | P2 | targets-safety | M | no |
| W074 | goal_rate_bp_week preset CHECK on target_profiles; recheck confirm-your-rate invitation need | P2 | targets-safety | S | no |
| W075 | Extend test_reset_user for about 19 newer user-owned tables | P2 | docs-tests | S | no |
| W076 | Endpoint security matrix test: identity, body limit, rate limit, idempotency per route | P2 | docs-tests | M | no |
| W077 | Identify and fix the flaky test trio (F7) and close ruling follow-ups | P2 | docs-tests | S | no |
| W078 | CI and test secret hygiene: fix six zizmor warnings, add a zizmor step, move DB URL out of argv | P2 | security | S | no |
| W079 | Full script-src CSP plus Lighthouse mobile and bundle-size CI gates | P2 | security | M | no |
| W080 | HEALTH_TOKEN_KEY rotation / re-seal script | P2 | security | S | no |
| W081 | Env-name drift: HEALTH_INGEST_TOKEN, production-only env names, dark rollout flags and their state | P2 | docs-tests | S | no |
| W082 | Owner: health production rollout | P2 | owner | M | yes |
| W083 | Owner: widen CAPTURE_METHODS one method per deploy | P2 | owner | S | yes |
| W084 | Owner: recipe/shopping pilot production deployment and wider enablement | P2 | owner | S | yes |
| W085 | Recipe pilot acceptance gaps | P2 | recipes-shopping | M | no |
| W086 | Coach Undo receipts PR B: apply_coach_op writer | P2 | coach-ai | L | no |
| W087 | Coach live quality and privacy pass (verify) | P2 | coach-ai | M | no |
| W088 | Transactional coach thread and message saves | P2 | coach-ai | S | no |
| W089 | Raise Jev MAX_LOGICAL_CALLS for plan-sheet chips and update the one-call test and W10 spec text | P2 | coach-ai | S | no |
| W090 | ExportCard: narrow the "Everything you have logged" claim; check closed-gate health context in coach (verify) | P2 | ui-settings | S | no |
| W091 | Stream coach replies (first visible text 3 s or less) | P2 | coach-ai | L | no |
| W092 | Phase 19b day rebalance | P2 | nutrition-engine | L | no |
| W093 | Owner: Phase 19b R0 drift study and first-client consent | P2 | owner | M | yes |
| W094 | TDEE step F test-suite audit (verify) | P2 | nutrition-engine | M | no |
| W095 | Duplicate-meal detection end to end | P2 | logging | M | no |
| W096 | Replay already-consumed plan_days feed rows | P2 | sync | S | no |
| W097 | W15 onboarding ablation: arm assignment, shell hook, report job | P2 | onboarding | M | no |
| W098 | W13 UI: Favored copy, star toggle, Settings world switch, invitation screen | P2 | ui-foods | M | no |
| W099 | Reason chips on generated meals, swap rows and coach composed cards | P2 | ui-foods | S | no |
| W100 | Shopping "Use my list" toggle, end date and Undo (W11) | P2 | recipes-shopping | S | no |
| W101 | "Not verified / Evidence under review" copy for held allergens; cuisines/country/taste screen completeness (verify) | P2 | ui-foods | S | no |
| W102 | Pass food_world into suggestion input so shortage copy knows open vs closed world (D13) | P2 | food-world | S | no |
| W103 | Taste chips: first-time account 409 and stale TasteChipsCard | P2 | food-world | S | no |
| W104 | Recover 36 Not-verified Eats foods: diet-label ingredient parser | P2 | food-policy | M | no |
| W105 | Wire contains_ingredient template facet in profile hard rules; tree-nut allergen key and policy coverage | P2 | food-policy | M | no |
| W106 | Dietary profile map: remaining facets and rubrics with calibration, plus third Sol review round | P2 | food-policy | L | no |
| W107 | Real-phone planDay benchmark and snapshot telemetry | P2 | food-world | S | no |
| W108 | Feed pref-2 ranking inputs and run the replay report | P2 | food-world | L | no |
| W109 | Owner: label universe plate sheet 1.1.0 and review CUISINE_STAPLES | P2 | owner | M | yes |
| W110 | Owner: universe and cuisine-tier human review, rename decisions, annotate-universe production run | P2 | owner | M | yes |
| W111 | Owner: run star-to-favored --production and record it | P2 | owner | S | yes |
| W112 | Owner: release open world | P2 | owner | S | yes |
| W113 | Owner: occasion-facet calibration holdout review, then facets-occasion-eval --live --freeze | P2 | owner | S | yes |
| W114 | Owner: FNDDS inputs production import | P2 | owner | S | yes |
| W115 | Meal Cards v4 redesign passes 2-4, critiques, Sol review and wiring | P2 | ui-today | L | no |
| W116 | Island views #470 leftovers (verify) | P2 | ui-today | S | no |
| W117 | Widget-save failure notice | P2 | ui-today | S | no |
| W118 | Service-worker waiting-worker race | P2 | ui-pwa | S | no |
| W119 | Idle-loop CPU profiling for pond and water scenes | P2 | ui-today | S | no |
| W120 | Small UI fixes: scan-unavailable notice, sex picker "unspecified", Coach change card on token-less devices (verify) | P2 | ui-settings | S | no |
| W121 | Authenticated-browser verification re-baseline | P2 | docs-tests | M | no |
| W122 | Owner: production-readiness steps | P2 | owner | S | yes |
| W123 | Save, re-use, swap (T5): Log again, "You logged this before", Recent meals swap row | P2 | logging | M | no |
| W124 | Label scan T3: dedupe repeat scans, 10-label eval, latency targets, scanned food star | P2 | capture-catalog | M | no |
| W125 | Plate photo T2: candidate-aware grounding, per-method gate, thumbnail, EXIF time, editable name, Save-as-recipe | P2 | capture-catalog | L | no |
| W126 | Phase 11: re-audit shipped conversation triggers and RPCs against round-13 spec (verify) | P2 | coach-ai | S | no |
| W127 | Docs reconciliation | P2 | docs-tests | S | no |
| W128 | Owner: delete persistent Supabase branch p1-catalog | P2 | owner | S | yes |
| W129 | Coach Undo receipts for remaining action kinds and parked feat/undo-followups cleanup | P3 | coach-ai | M | no |
| W130 | Owner: label 432 pairing holdout pairs, then jev-labels and calibrate with W8 replay-lift record | P3 | owner | M | yes |
| W131 | Architecture refresh for phases 9-19 in docs/architecture.md (fill or remove empty 2026-10-10 directory) | P3 | docs-tests | M | no |
| W132 | Repo hygiene: delete landed and backup wip branches (week-entry-scan, onb2-*, proto/wet-island, fix/well-open-glare) after diffing | P3 | docs-tests | S | no |
| W133 | Reopen dependency majors as separate PRs: TypeScript 6, motion 14, npm minor group; keep Node 22 types | P3 | docs-tests | M | no |
| W134 | Redesign down migrations so they preserve data | P3 | server-db | M | no |
| W135 | W14 Taste T2: taste_models migration, trainer, leakage-free replay and report (data-gated: 60 days of W6 signals) | P3 | food-world | L | no |
| W136 | Jev short-list veto: adjudicate 60 vetoes for the live gate (stays shadow until then) | P3 | food-world | M | no |
| W137 | Open-world date change uses stale v3 set for ~300 ms before rules-version recheck | P3 | food-world | S | no |
| W138 | Meal-planning follow-ups t20 (O4 gaps) and t22 (O3 gate prerequisites); facet warming in coach grounding and log commit (verify) | P3 | food-world | M | no |
| W139 | Capture and UI minors: CaptureSheet lane-L items, Undo behind standing error, 12-meal text cap, swapped alternative verdict lookup, N+1 lookups (verify) | P3 | capture-catalog | S | no |
| W140 | Coach small items: tool-schema .positive() and NOUS_* names, chart-claim verifier rule, abort transcribe on page hide, weekday-series per-date titles (verify) | P3 | coach-ai | S | no |
| W141 | Slot editing Phase C (build from any items, verify) and Phase D "Make this my usual" | P3 | ui-today | M | no |
| W142 | Jev day_completeness nudge before "Day fully logged" | P3 | coach-ai | S | no |
| W143 | Deferred coach ideas: Phase 12 Later capabilities, account memory, Jev swap/bridge, gut-log correlation, multi-day plans, recall_conversations (verify) | P3 | coach-ai | XL | no |
| W144 | Deferred integrations: native shell, Garmin, Health Connect, Withings, web push and out-of-app notifications, ChatGPT connector | P3 | health | XL | no |
| W145 | Sprout and companions: stored state (streaks, growth), shop wearables and per-companion art | P3 | ui-today | L | no |
| W146 | Quarterly catalog refresh job (F-107) and build-time unpaid Gemini-key gate (F-120) | P3 | server-ops | S | no |
| W147 | Act on the weekly model-freshness issue (lane-bench PR if a pin should change) | P3 | coach-ai | S | no |
| W148 | Truly remove an "Other foods" row (new stored state) | P3 | ui-foods | S | no |
| W149 | Split tests/search/recall.test.ts under the 400-line soft limit | P3 | docs-tests | S | no |
| W150 | Onboarding Phase 10 Later gaps: offline turns, draft expiry, thread delete, Add-from-onboarding; G10-G12 clinician numbers and rounding (verify against onb3) | P3 | onboarding | M | no |
| W151 | Phase 9 per-user day templates: keep as spec-only Later (no build) | P3 | docs-tests | S | no |
| W152 | FluidVoice UI recovery acceptance ledger at 320/390/430/1024 (verify) | P3 | docs-tests | S | no |
| W153 | Four selectable background themes | P3 | ui-today | M | no |
| W154 | Owner housekeeping: confirm Vercel billing card, rename provisional ZS Vault entry, supply board videos and nutritionist tips | P3 | owner | S | yes |
| W155 | Regional priors (state-level NHANES, Canada CCHS) and photoToIdeas byte-size telemetry | P3 | food-world | L | no |
| W156 | compose_meal on the lib/meals engine: pinned foods, incomplete named draft result | P3 | coach-ai | M | no |
| W157 | Day-strip seven 44 px targets below 360 px (verify) | P3 | ui-today | S | no |
| W158 | Restaurant and chain-menu nutrition source (Nutritionix vs alternatives) | P3 | research | S | yes |
| W159 | Food recall alerts from Daily Food Recalls (free API) | P3 | research | S | no |
| W160 | Household-unit densities from ExactCup (free API) | P3 | research | S | no |

## P0 specs

### W001 Rotate leaked secrets and record receipts
- Priority P0 / lane owner / size S / owner-only: yes
- Goal: Rotate the Supabase access token, the other projects' DB URLs and `SASHA_SYNC_TOKEN`. Record a receipt for each.
- Done when:
  - Each old secret is revoked and returns 401 or a connection refusal.
  - New values sit in ZS Vault and `~/.config/zs-api-keys.env` only. None is in git, chat or logs.
  - A receipt lists secret name, date and check, with no secret value.
- Files: none in the repo. Receipt goes under `docs/audit/` (new file).
- Risks and guards: Rotating `SASHA_SYNC_TOKEN` breaks the sync caller until it gets the new value. Rotate the Supabase token before the DB passwords. Never paste a value into a receipt.
- Depends on: none
- Sources: B095, B277

### W002 Confirm repo stays private; find why it went public
- Priority P0 / lane owner / size S / owner-only: yes
- Goal: Prove the repo is private now. Find which action or setting made it public on 2026-10-10.
- Done when:
  - `gh repo view --json visibility` reports PRIVATE, recorded with a date.
  - The cause is named from the audit log (actor, event, time).
  - A guard exists: an org rule or a scheduled check that alerts on a visibility change.
- Files: none in the repo. Note goes in `docs/audit/` (new file).
- Risks and guards: History holds client medical data. If the repo was indexed while public, treat the history as exposed and tell Devin. Do not rewrite history without his call.
- Depends on: none
- Sources: B117

### W003 Reconcile production migration ledger; record apply receipts
- Priority P0 / lane server-ops / size M / owner-only: no
- Goal: Compare the production ledger with `supabase/migrations`. Apply what is missing, in order, and record a receipt for each.
- Done when:
  - A read-only drift check lists every repo migration absent from production (PR A undo receipts `20261216090000`..`090400`, `20261126090000`, `20261217*` to `20261229090000`).
  - Backup taken, dry-run listed, each file applied in order, verified, receipt written.
  - `20261229090000_client_timings_plan_chips` is applied. Plan-chip timing rows then insert.
- Files: `supabase/migrations/20261126090000_coach_conversations.sql`, `supabase/migrations/20261228090000_target_writes_service_role_only.sql`, `supabase/migrations/20261229090000_client_timings_plan_chips.sql`, `docs/audit/` receipts (new).
- Risks and guards: `20261228090000` goes AFTER its code deploy (AGENTS.md). Two parked wip migrations reuse timestamp `20261229090000`. Renumber them before they land. Tell Devin if a file cannot apply cleanly.
- Depends on: none
- Sources: B162, B126, B130, B087, B136

### W004 Energy rule: no unmeasured nutrient as 0; measured energy on account foods
- Priority P0 / lane nutrition-engine / size M / owner-only: no
- Goal: Write only measured nutrient codes when a catalog food becomes an account food. Carry measured energy per unit. Apply the one energy rule in recipe sums and the SQL twin. Fix the Foundation importer mapping.
- Done when:
  - `components/add-food/catalog-food.ts` stores no code the catalog did not measure. A test shows calc-only energy is kept and absent nutrients stay absent.
  - `lib/log/picked-commit.ts` logs an account food with reported, else calculated, energy, not 4/4/9. A test covers an alcohol food.
  - `lib/recipes/nutrients.ts` and its SQL twin agree with `lib/nutrients/energy.ts` on a shared fixture.
  - `scripts/import-fdc.py` maps Foundation energy 2047/2048 and sugars 1063. A backfill script for custom rows stored as 0 energy exists (dry run by default).
- Files: `components/add-food/catalog-food.ts`, `lib/log/picked-commit.ts`, `lib/recipes/nutrients.ts`, `lib/nutrients/energy.ts`, `lib/server/day-energy.ts`, `scripts/import-fdc.py`.
- Risks and guards: AGENTS.md one energy rule (unknown is `null`, never 0). A SQL change needs a migration, applied to production BEFORE the code merges. Production import and backfill are W005.
- Depends on: none
- Sources: F01 (A154, A156, A008, A019, A022)

### W005 Owner: re-import Foundation and run the energy backfill on production
- Priority P0 / lane owner / size S / owner-only: yes
- Goal: Repair stored rows after the W004 code is live.
- Done when:
  - Foundation re-import ran per `docs/catalog/import.md` (branch first, sizing sign-off).
  - Backfill report shows 0 custom rows with energy stored as 0 where a calc value exists.
  - Receipt recorded with row counts before and after.
  - Then remove the W004 stopgap in `lib/store.ts` `measuredKcalPerGram` (a stored `energy_kcal: 0` beside macros that carry energy is read as macro energy). It is a known deviation from the one energy rule: a real reported 0 with non-zero macros logs about 4 kcal instead of 0. Its test in `tests/log/account-food-energy.test.ts` flips with it.
- Files: `scripts/import-fdc.py`, `docs/catalog/import.md`, the W004 backfill script, `lib/store.ts`.
- Risks and guards: Production writes need a backup first. Run the backfill on a branch before production. Run it twice to show 0 further writes.
- Depends on: W004
- Sources: F01

### W006 Weekly proposal and TDEE intake correctness
- Priority P0 / lane nutrition-engine / size M / owner-only: no
- Goal: Let a proposal lower training-day carbs, count ticked meals and eaten recipes in intake, and date revisions by the account day.
- Done when:
  - `lib/proposal.ts` moves training-day carbs down to `carb_g_min`. A test shows a downward move on a training-heavy account.
  - `lib/server/expenditure.ts` counts ticked plan meals and eaten recipes, or marks the day intake-unknown. A test covers both.
  - `approve_target_proposal` dates the revision and reads the active revision by the account day. Held versus starting status is fixed in `lib/expenditure.ts` (P04).
  - `day_marks_started_on` records when marking began, not the earliest back-dated mark (P20).
- Files: `lib/proposal.ts`, `lib/expenditure.ts`, `lib/server/expenditure.ts`, `supabase/migrations/20261023090500_approve_proposal_via_revision.sql`, `supabase/migrations/20261209090100_plan_days_day_complete.sql`.
- Risks and guards: Migrations go to production BEFORE the code merges. Engine stays advisory (`exp-3.1.0`, rulings R1-R10). Keep the 75 kcal/day move rule. Run all `tests/expenditure` and `tests/proposals`.
- Depends on: W004
- Sources: F02 (A157, A155, P04, A075, A098, P20)

### W007 Target safety on every server write path
- Priority P0 / lane targets-safety / size M / owner-only: no
- Goal: Make pace holds, kidney protein and the adult floor apply on proposals, adaptive revisions and MCP writes.
- Done when:
  - Approving a pending proposal under a pace hold clamps or refuses it. Applying a hold rejects pending proposals. Test in `tests/proposals`.
  - Kidney disease switches adaptive and proposal revisions to 0.8 g/kg. A new under-18 signal supersedes paced revisions.
  - MCP `set_constraints` runs the same hold recompute as the REST route.
  - Pinned days respect the revision's own floors. `goalRateBpWeek` is validated on authored writes. The first `constraint_profiles` write is conditional.
- Files: `lib/server/proposals.ts`, `lib/server/target-recompute.ts`, `lib/mcp/coach-tools.ts`, `lib/profile/derive.ts`, `lib/server/targets.ts`, `lib/server/constraints.ts`.
- Risks and guards: Writers stay service-role (`lib/server/target-writes.ts`, canary `tests/tenancy/admin-targets.test.ts`). Holds supersede later revisions on their own dates. A migration for the conditional write goes to production first.
- Depends on: none
- Sources: F03 (A129 — refuted by Sol, see docs/audit/2026-10-10/README.md; do not act on it — A003, A094, A103, A002, A004, A119)

### W008 Remove first-client 1650 kcal floor from coach floors
- Priority P0 / lane targets-safety / size S / owner-only: no
- Goal: Coach suggestions use the account's own minimum. Give `account_minimum` a writer or drop the label.
- Done when:
  - `lib/coach/floors.ts` has no `KCAL_MIN_FLOOR = 1650`. `tests/coach/floors.test.ts` passes with an account minimum from the revision.
  - `KCAL_MIN_SOURCES` in `lib/types.ts` has a writer for `account_minimum`, or the value is removed with a migration for the check.
  - A grep for `1650` in `lib/` finds no coach floor.
- Files: `lib/coach/floors.ts`, `lib/types.ts`, `supabase/migrations/20261029090000_rate_goals.sql`.
- Risks and guards: AGENTS.md: no first-client number is a default. Floors must not drop below the adult floor in `lib/server/targets.ts`. Confirm `violatesFloors` has no caller before the edit.
- Depends on: W007
- Sources: B028, B245, B241

### W009 Legacy onboarding and Edit profile: crash, safety round, weigh-in
- Priority P0 / lane onboarding / size M / owner-only: no
- Goal: Stop the legacy form from crashing, run the safety round, and log a weigh-in only when weight changed.
- Done when:
  - An under-18 birth year shows a friendly stop in `OnboardingFlow.tsx`. No page crash. Test in `tests/onboarding`.
  - The legacy form asks the safety round, or defaults to 0 pace. Previews read stored holds.
  - Age uses the full birth date (`lib/profile/rate-eligibility.ts`), so a 17-year-old fails the adult check.
  - Edit profile logs no weigh-in when weight is unchanged. Only brand-new accounts open the food world by default.
- Files: `components/Onboarding/OnboardingFlow.tsx`, `components/Onboarding/OnboardingSteps.tsx`, `lib/profile/onboarding-client.ts`, `lib/profile/rate-eligibility.ts`.
- Risks and guards: The server age rule uses the STORED birth year (`422 adult_only`). Keep `tests/onboarding/open-food-world.test.ts` green. The food world default stays one conditional write on `food_world_set_at`.
- Depends on: none
- Sources: F13 (A093, A087, A088, A092, A089, A091)

### W010 Health ingest: one transaction; correction upsert fixes
- Priority P0 / lane health / size M / owner-only: no
- Goal: A failed apply must not lose the payload. A retry must re-apply.
- Done when:
  - Dedupe event and samples are written in one RPC transaction, or a failed event is marked failed. A test fails the apply and shows the retry applies.
  - Rejected indexes refer to the original samples (A012).
  - The correction upsert updates `start_time` and `tz` (A095). The estimator lets a scale reading beat a manual one (A050).
- Files: `lib/server/health-ingest.ts`, `supabase/migrations/20261013090200_fix_health_dedupe_key.sql` (add a new fix migration, do not edit), `lib/server/health-daily.ts`, `tests/health`.
- Risks and guards: The new migration goes to production BEFORE the code merges. Keep ingest idempotent on the dedupe key.
- Depends on: none
- Sources: F04 (A009, A081, A012, A095, A050)

### W011 Sync merge conflicts that lose or duplicate edits
- Priority P0 / lane sync / size L / owner-only: no
- Goal: Concurrent edits on two devices keep both users' data.
- Done when:
  - A create on a tombstoned favorite rebases as a restore (A078). Test in `tests/sync`.
  - Queued ops per entity coalesce or rebase. No op aims at a speculative rev (A165). Older op results and pulled echoes keep optimistic state while ops are queued (A138, A164).
  - `plan_days` merges field-wise, with a per-slot merge of `item_overrides` (A141, B091). A pull skip never drops another device's change (A168).
  - Note joins are idempotent (A077, A139). A two-device test for logged-extra notes exists (B014).
- Files: `lib/sync/merge.ts`, `lib/sync/outbox.ts`, `lib/sync/client.ts`, `lib/sync/plan-days.ts`, `lib/sync/log-entry-ops.ts`, `lib/log-note-client.ts`.
- Risks and guards: Split into 3 PRs (favorites and notes, outbox rebase, plan_days). A `plan_days` RPC change needs a migration applied first. P07 (pull cost) is optional. Run all `tests/sync` suites.
- Depends on: none
- Sources: F05 (A078, A141, A165, A138, A164, A168, A077, A139, P07), B091, B014

### W012 Exports: page past 1,000 rows; validate cursors; add provenance
- Priority P0 / lane server-api / size M / owner-only: no
- Goal: Exports return every row or say they were cut short.
- Done when:
  - Meals, recipes, water and `target_profiles` read through `fetchAllRows` or date-chunks, with a real next cursor. A test with 1,001 rows returns all.
  - The day-type override `.in()` list is chunked. Cursors are validated before any PostgREST filter (A126, A133).
  - Water uses each date's own revision (A052). Export adds `body_fat_source` and `body_fat_measured_on` (B259).
- Files: `lib/server/export.ts`, `lib/server/export-water.ts`, `lib/server/export-body.ts`, `app/api/export/route.ts`, `lib/server/paged-read.ts`.
- Risks and guards: Keep the `user-table-export-v1` bytes stable. Reads use explicit `user_id` (tenancy tests in `tests/tenancy`).
- Depends on: none
- Sources: F06 (A085, A112, A113, A086, A071, A114, A052, A126, A133), B259

### W013 Capture and log sheet portion maths
- Priority P0 / lane capture-catalog / size S / owner-only: no
- Goal: Stop invented grams. Log the grams the box shows.
- Done when:
  - `gramsFor` reads the amount in a matched portion label (A006). Test: a "2 cups" label.
  - No 100 g per "whole" or "piece". The model's grams stay, or the item is refused (A007, A044). Tests in `tests/capture`.
  - The log sheet count stepper moves grams without portions (A015). Comma decimals and partial input log the shown grams (A016).
- Files: `lib/capture/quantity.ts`, `lib/server/capture.ts`, `components/LogFoodSheet.tsx`.
- Risks and guards: Logging marks, it never refuses (ruling 2026-09-14). Unknown mass stays `grams: null` (`lib/log/mass.ts`).
- Depends on: none
- Sources: F07 (A006, A007, A044, A015, A016)

### W014 Food rules parity on coach writes, imports, barcode, starters
- Priority P0 / lane food-policy / size M / owner-only: no
- Goal: Every plan write and import runs the full policy pass.
- Done when:
  - `set_slot_meal`, `add_slot_item`, `set_slot_item` run `evaluatePolicy` with diet flags, profile hard rules and the human-food check (A023, A128). Test per action.
  - Menu photo and document-plan grounding do the same. With flags, they fail to a "check it" state (A130, A134).
  - Offline barcode verdicts carry the rules epoch (A031). OFF `en:crustaceans` counts as crustacean evidence (A026). Wheat and gluten are one concern for starters (A041).
- Files: `lib/coach/policy.ts`, `lib/coach/actions/ground-kit.ts`, `lib/server/plan-menu.ts`, `lib/plan/document-ground.ts`, `lib/barcode/client.ts`, `lib/policy/allergens.ts`, `lib/foods/starter.ts`.
- Risks and guards: Jev stays off the allergy, diet and profile paths (`tests/policy/facet-escalation-removal.test.ts`, `tests/policy/diet-rule-jev-removal.test.ts`). The golden files in `tests/coach/action-golden/` must not change.
- Depends on: none
- Sources: F08 (A023, A128, A130, A134, A031, A026, A041)

### W015 Bundled food data and portion bands
- Priority P0 / lane nutrition-engine / size S / owner-only: no
- Goal: Correct portion bands and SR rows.
- Done when:
  - Oil-packed fish keeps a protein-sized band. Test: tuna plate protein above 12 g (A013).
  - The cheese rule bands by curated family, not substring (A017). Mac and cheese gets no cheese part.
  - The default portion is a sensible serving, not the shortest label (A020). Ramen bowl and Overnight oats map to correct SR rows through `scripts/build-food-db.py` (A021).
- Files: `lib/coach/portion-bands.ts`, `lib/food-db.ts`, `lib/food-db.json` (generated), `scripts/build-food-db.py`.
- Risks and guards: Never hand-edit `food-db.json`. Run the `tests/meals` suites and golden files in `tests/meals/__golden__`. Planned meals will shift, so review the diff.
- Depends on: W004
- Sources: F09 (A013, A017, A020, A021)

### W016 Nightly backup: complete, consistent, time-bounded
- Priority P0 / lane server-ops / size M / owner-only: no
- Goal: Back up every user-owned table, page by key, and finish in budget.
- Done when:
  - The table list derives from the schema. A test fails when a new user table is missing (dietary-profile rules, allergen checks, shopping and recipe-plan tables included).
  - Paging is by keyset. The job has a time budget and resumable passes like `lib/server/job-sweep.ts`.
  - A restore-to-branch run (`scripts/restore-to-branch.sh`) recovers the added tables.
- Files: `app/api/jobs/backup/route.ts`, `lib/server/job-sweep.ts`, `scripts/restore-to-branch.sh`, `vercel.json`.
- Risks and guards: Streaming JSON stays bounded in memory. The job checks the cron secret first. A cursor table needs a migration, applied first.
- Depends on: none
- Sources: F10 (A083, A122, A123)

### W017 Capture and log flow fixes
- Priority P0 / lane capture-catalog / size M / owner-only: no
- Goal: Make label save work and let blocked items save with a mark.
- Done when:
  - "Save as my food" sends the `label_food` body and placeholder ref. A test no longer gets 422 (A030).
  - The capture sheet saves blocked items with a mark (A034). Queued commits get policy marks after drain (A033).
  - Label food rows are created after validation (A036). Scan qty and unit match grams (A035). A duplicate 409 shows the right draft (A032).
- Files: `lib/capture-client.ts`, `components/CaptureSheet.tsx`, `lib/log/queue-commit.ts`, `components/ScanConfirmSheet.tsx`, `lib/server/log.ts`, `lib/server/log-label-food.ts`.
- Risks and guards: Ruling 2026-09-14 (logging marks, never refuses). Dedupe of repeat label scans (B003) stays out of scope.
- Depends on: W013
- Sources: F11 (A030, A034, A032, A033, A035, A036)

### W018 Lock down server-owned tables from direct PostgREST writes
- Priority P0 / lane security / size M / owner-only: no
- Goal: Remove authenticated write grants on tables the server owns.
- Done when:
  - `authenticated` cannot insert, update or delete `target_profiles`, `change_log`, `change_seq`, `health_sources`. `user_settings` insert and delete are restricted. `day_marks_started_on` is server-written (A120).
  - `coach_messages` inserts are limited to `role='user'`. The `coach_threads` guard returns early for a foreign `user_id` (A146).
  - A grants test per table, like `tests/tenancy/target-writes-grants.test.ts`.
  - Remaining `user_settings` and `health_samples` write paths close (B100).
- Files: `supabase/migrations/20260911000500_rls.sql` (read only; add a new migration), `supabase/migrations/20261228090000_target_writes_service_role_only.sql`, `supabase/migrations/20261126090000_coach_conversations.sql`, `supabase/migrations/20261210090300_coach_action_undos.sql`.
- Risks and guards: Apply AFTER the code that writes through the service role is live, never before. Confirm every app writer first with the tenancy canaries. Backup first.
- Depends on: W003
- Sources: F19 (A068, A097, A147, A148, A120, P17, P16, A146), B100

### W019 Media storage: uploads, sweep, path traversal, EXIF
- Priority P0 / lane security / size M / owner-only: no
- Goal: Close cross-account media access and strip location data.
- Done when:
  - The bucket policy drops authenticated insert and update. `media_objects.path` is limited to the owner's prefix. The sweep skips foreign paths (A055, P08).
  - `fetchOwnedObject`, `pantry/photo` and `coach/transcribe` reject `..` and non-matching paths. Tests use a traversal key (A115, A099, A136).
  - The signed-URL expiry claim is corrected (P10). Document and plan photos lose EXIF/GPS before the model call (A135, B116).
- Files: `lib/server/media.ts`, `app/api/pantry/photo/route.ts`, `lib/server/coach-transcribe.ts`, `lib/server/plan-document.ts`, `supabase/migrations/20260920090100_phase4_media_bucket.sql` (read only; add a new migration), `tests/media`.
- Risks and guards: The policy change goes AFTER uploads move to server-signed URLs. Model payloads stay on the builders in `lib/ai/payloads.ts`. The photo privacy notice stays.
- Depends on: none
- Sources: F20 (A055, P08, A115, A099, A136, P10, A135), B116

### W020 Coach shopping-apply: one account per apply
- Priority P0 / lane coach-ai / size S / owner-only: no
- Goal: Capture the account once and reject on a mid-apply switch.
- Done when:
  - `applyAddToShoppingList` resolves the account handle once. A test switches accounts mid-apply and sees a rejection with no write.
  - A partial add is reported to the user.
- Files: `lib/coach/apply-shopping.ts`, `tests/coach`.
- Risks and guards: Do not change the action golden files. A partial add has no Undo today, so state this in the card copy.
- Depends on: none
- Sources: B061

### W021 Verify Floor Day Avoid check and low-FODMAP unknowns (verify)
- Priority P0 / lane food-policy / size S / owner-only: no
- Goal: Prove that Floor Day slot meals honour Avoid and that uncategorised low-FODMAP foods read unknown. Fix the Plan sheet title regression if it exists.
- Done when:
  - A test puts an Avoid food in a floor-day slot-keyed meal. It is blocked or marked.
  - A test shows low-FODMAP on an uncategorised food reads `unknown`.
  - Each item is recorded as fixed, or closed with its test as proof.
- Files: `lib/rotation.ts`, `lib/meals.ts`, `lib/foods/rule-marks.ts`, `components/PlanSheet.tsx`.
- Risks and guards: Do not touch generated plates. Saved lines get `ruleMark`, per the saved-content rule.
- Depends on: none
- Sources: B105, B221

### W022 Allergen evidence fixes (verify)
- Priority P0 / lane food-policy / size M / owner-only: no
- Goal: Check and fix allergen mappings: assessed evidence before `allowed` on barcode and catalog paths, tahini, coconut, and rice/tuna gluten rows.
- Done when:
  - Barcode and catalog tests show a food with no assessed allergen evidence is never `allowed`.
  - Tahini no longer maps to dairy. Coconut milk is not a tree-nut false positive. Tests in `tests/policy`.
  - Rice and tuna gluten rows from the Jev warm are reviewed with `scripts/allergen-jev-holds.ts --review`.
- Files: `lib/policy/allergens.ts`, `lib/catalog/category-map.ts`, `scripts/allergen-jev-holds.ts`, `tests/policy/allergen-evidence-read-safety.test.ts`.
- Risks and guards: Jev never decides allergy (`tests/policy/facet-escalation-removal.test.ts`). A `policy_categories` fix needs a re-run of `scripts/annotate-policy-categories.ts --commit` on production. Backup first.
- Depends on: none
- Sources: B193, B197, B277


## P1 specs

### W023 Renumber parked migrations that collide on 20261229090000
Priority P1 / lane server-ops / size S / owner-only no
- Goal: Give the two parked migrations (delete_account, voice_ears cleanup) unique timestamps after 20261229090000 (`client_timings_plan_chips`, already on main).
- Done when:
  - `ls supabase/migrations | cut -c1-14 | sort | uniq -d` prints nothing on both wip branches rebased on main.
  - Each renamed file sorts after the highest applied migration and keeps its body unchanged.
  - Branch tests that name the old filename pass.
- Files: `supabase/migrations/20261229090000_client_timings_plan_chips.sql`; the delete_account and voice_ears files on `wip/2026-10-08-account-deletion` and `wip/2026-10-08-voice-retire-account-zone` (wip branch).
- Risks and guards: Check the production ledger first; never rename an applied file. Rename both branches in one pass so they do not collide again.
- Depends on: W003.
- Sources: B135, B164.

### W024 Shopping planner preview crashes
Priority P1 / lane recipes-shopping / size M / owner-only no
- Goal: Make the shopping preview survive null-ref pantry photos, old prepared batches and withdrawn recipes. Fix the stock, package and 0 g edge cases.
- Done when:
  - A pantry photo row (null food ref, null FoodDB id) no longer throws in `identityKey`; a test covers it.
  - Batch reuse reads the batch's first row; a preview across the 2-day window passes.
  - A withdrawn accepted recipe blocks only its own slot; the preview answers 200, not 410.
  - `accept` SQL gives NULL stock when need is unknown; `Math.ceil` float case (A018) has a test; 0 g pantry rows are "not on hand".
- Files: `lib/shopping/planner.ts`, `lib/shopping/aggregate.ts`, `lib/server/recipe-plan.ts`, `supabase/migrations/20261128090000_recipe_plan_accept.sql` (fix ships as a new migration).
- Risks and guards: Shopping is pilot-gated. Keep "Keeps your chosen …" replan rule and `ruleMark` behaviour. Apply the new SQL migration before the code merges. Run all `tests/shopping` and `tests/migrations/*recipe*` suites.
- Depends on: none.
- Sources: F12 (A048, A046, A047, A049, A018, P03).

### W025 Oura data correctness and redirect
Priority P1 / lane health / size M / owner-only no
- Goal: Count steps and energy once per day, bucket Oura data by the account day, refresh the token on 401, and close the open redirect.
- Done when:
  - `lib/health/daily.ts` picks one source per day for `step_count` and `active_energy`; a test with Oura plus Apple data shows no sum.
  - Sleep, HR, HRV and readiness use the account zone (`lib/server/account-day.ts`); a US-zone bedtime test lands on the right day.
  - A 401 triggers a refresh with an atomic rotated-token write; the write result is checked.
  - `oura-return` accepts only allowlisted targets; a test rejects `https://evil.example`.
- Files: `lib/health/daily.ts`, `lib/oura/map.ts`, `lib/server/oura.ts`, `lib/health/oura-return.ts`.
- Risks and guards: Land before Oura is enabled. Existing samples keep their UTC buckets; decide on a re-bucket script or document the cut-over. No token in logs.
- Depends on: W010.
- Sources: F14 (A010, A014, A011, A117, P12, A053), B264.

### W026 Sync outbox ordering and liveness
Priority P1 / lane sync / size M / owner-only no
- Goal: Stop deletes running before backed-off creates, stop batch-wide 4xx from parking good ops, and make conflict rebase atomic. Add the conflict `at` timestamp.
- Done when:
  - Per-entity order test: create (backed off) then delete never resurrects the row.
  - A whole-batch 4xx or 401 charges no single op.
  - Rebase runs in one IndexedDB transaction; a crash test leaves one op.
  - Parked ops release after a fix; settings recovery has a moving watermark; a pull-side projection failure does not block push.
  - `apply_sync_op` conflict JSON carries `at`; `serverTimestampOf` reads it.
- Files: `lib/sync/outbox.ts`, `lib/sync/client.ts`, `lib/sync/idb.ts`, `app/api/sync/ops/route.ts`, new migration for `at`.
- Risks and guards: Apply the migration before the code. Sync tests plus `tests/sync/*-db.test.ts` all run. Keep idempotent replay and the `rev` CAS rules.
- Depends on: W011.
- Sources: F15 (A079, A076, A074, A137, P09, A080, A082), B234.

### W027 Log mirror reconcile races (verify)
Priority P1 / lane sync / size S / owner-only no
- Goal: Confirm or fix the forget-versus-settle race that can send a delete with `base_rev` null.
- Done when:
  - A test reproduces concurrent `forgetLoggedEntry` and settle; the result is documented as fixed or still open.
  - `reconcileMirror` checks revision order before it puts a row.
  - No delete is queued as a create after an in-flight commit.
- Files: `lib/log/live-commits.ts`, `lib/log-commit-settle.ts`, `lib/log/reconcile.ts`, `lib/log-commit-client.ts`.
- Risks and guards: Do not change logging-marks-never-refuses behaviour. Work after the outbox fix so the two do not conflict.
- Depends on: W026.
- Sources: B015.

### W028 Coach fast-path and action correctness
Priority P1 / lane coach-ai / size M / owner-only no
- Goal: Make fast-path actions use the stated date and the full quantity. Keep slot edits on the line's own food, keep list removals separate, and keep titles on Undo.
- Done when:
  - Water, weight and schedule fast paths honour a stated date; tests added.
  - "1 1/2 cups" and similar compound amounts parse whole; compound food phrases split into separate marks.
  - `set_slot_item` keeps the line's food and macros (A158); zero placeholders no longer set `trainingWeekdays` (A160).
  - `remove_from_eats` and `remove_from_avoid` leave the other list alone; `delete_entry` Undo restores the title; dropped out-of-scope actions are shown.
- Files: `lib/coach/actions/log-water.ts`, `lib/coach/intent.ts`, `lib/server/coach-turn/intent.ts`, `lib/coach/apply-slot.ts`, `lib/coach/apply-prefs.ts`, `lib/coach/apply-entries.ts`, `lib/coach/actions/schemas.ts`.
- Risks and guards: `tests/coach/action-golden/` pins schema, prompt and card copy; regenerate only for a real change. Keep fast-path thresholds (0.95 / 0.90). Server Undo stays receipt-based.
- Depends on: none.
- Sources: F16 (A024, A027, A029, A158, A160, A025, A028, A037, P18).

### W029 Food membership and Favor consistency
Priority P1 / lane food-world / size M / owner-only no
- Goal: Make membership state agree across devices. Let the server assign revisions and let re-Favor reach refs minted later.
- Done when:
  - The phone cache refreshes after a server Favor or another device's mark; a repeat tap works.
  - Revisions come from the server, not `Date.now()`; a two-tab tie test passes.
  - A role save sends a field delta and cannot revert an Avoid.
  - Re-Favor writes prefs for refs minted after the first Favor; cured meats no longer infer as fat.
- Files: `lib/foods/prefs-client.ts`, `lib/foods/role.ts`, `supabase/migrations/20261215090000_favor_food_families.sql` (fix as a new migration), `lib/server/taste-favor.ts`.
- Risks and guards: Keep the wire name `eats`. Guards: `tests/sync/food-membership-ops-db.test.ts`, `tests/migrations/favor-families-db.test.ts`. Apply the migration before the code. Avoid always beats Favor.
- Depends on: none.
- Sources: F17 (A039, A140, P15, A038, A042), B009.

### W030 Today meal cards: dates, Quick meals, swap and tick state
Priority P1 / lane ui-today / size M / owner-only no
- Goal: Stop stale drafts crossing dates. Resolve the dead Quick meals control, and fix tick, swap and rotation edge cases.
- Done when:
  - Meal cards key by date; a date-switch test shows the draft and preview reset.
  - Quick meals either changes the day or the control and its Swap gate are removed.
  - A ticked snapshot with a log reads as eaten; swap excludes the current meal; "not eaten" clears the frozen meal.
  - `plate.ts` date variety uses a non-negative modulo (dates before 2026) and Today's snapshot refetch is coalesced.
- Files: `app/page.tsx`, `lib/resolve.ts`, `lib/today/swap-alternatives.ts`, `lib/plan-day-client.ts`, `lib/meals/plate.ts`.
- Risks and guards: `pref-0` rankings must stay byte-identical (`tests/meals/ranking-boundary.test.ts`, `pref2-baseline.test.ts`). A modulo fix changes old-date ranks; update goldens knowingly. Show the result in the browser pane.
- Depends on: none.
- Sources: F18 (A069, A061, A064, A065, A066, A062, P06).

### W031 Finish voice retirement and account-zone precedence branch
Priority P1 / lane server-dates / size M / owner-only no
- Goal: Finish and land `wip/2026-10-08-voice-retire-account-zone`.
- Done when:
  - `phase-14-voice-agent.md` says RETIRED, not DRAFT.
  - The voice_ears cleanup migration has a new timestamp (W023) and a second-model review.
  - The two `it.todo` at `tests/coach/apply-profile.test.ts:661-662` are real tests.
  - Account-zone precedence is tested and used by the date fixes in W032.
- Files: `tests/coach/apply-profile.test.ts`, `lib/server/account-day.ts`, `supabase/migrations/20261117090000_*` (voice_ears origin), `docs/specs/phase-14-voice-agent.md`.
- Risks and guards: The `voice_ears` drop is destructive; back up and confirm no reader first. Apply the cleanup migration after the code.
- Depends on: W023.
- Sources: B058, B134.

### W032 Account-day dates on the server
Priority P1 / lane server-dates / size S / owner-only no
- Goal: Use the viewed date and the account zone, never UTC or `HEALTH_TZ`, for cached targets and server jobs.
- Done when:
  - `day-context` picks the cached target by the viewed date; an east-of-UTC test passes.
  - A failed zone read fails loudly (logged, no lock on the wrong day) instead of falling back to UTC.
  - Coach recall, suggestion rotation, taste-history manual lines and the capture cap use the stored zone.
- Files: `lib/server/day-context.ts`, `lib/server/account-day.ts`, `lib/server/coach-ports.ts`, `lib/coach/suggest-pool.ts`, `lib/server/taste-history.ts`, `lib/server/capture.ts`, `lib/coach/history-recall.ts`.
- Risks and guards: Keep the t24b order (phone day, stored zone, request zone, UTC last). Never use `HEALTH_TZ` as a personal default. Job locks key by date; check no double run at the cut-over.
- Depends on: W031.
- Sources: F21 (A167, A118, P14, A109, A110, A072, A143).

### W033 Phone dates and slot clocks, and .ics export
Priority P1 / lane ui-today / size M / owner-only no
- Goal: Date revisions and cache stamps by the phone's local day. Read meal count and clocks from the viewed date's revision.
- Done when:
  - `TargetModeSheet` and the estimator cache stamp use the local day; a UTC-evening test passes.
  - `lib/plan.ts` reads meal count and clocks from `targetRevisionOn(date)`.
  - The week page refreshes "today" at midnight (`lib/targets/day-roll.ts` pattern).
  - `.ics` uses the app's clamped slot resolution; end never precedes start.
  - BMR age uses the full birth date; spring-forward retiming is the same in all zones.
- Files: `components/TargetModeSheet.tsx`, `lib/estimator-client.ts`, `lib/plan.ts`, `app/week/page.tsx`, `lib/ics.ts`, `lib/profile/energy.ts`, `lib/coach/apply-shared.ts`.
- Risks and guards: Target numbers stay server-authoritative (`lib/targets/revision.ts`). Run the full `tests/targets` and `tests/plan` suites.
- Depends on: W030.
- Sources: F22 (A054, A051, A063, A070, A142, A005, A166, A090, A100).

### W034 Database lock order
Priority P1 / lane server-db / size S / owner-only no
- Goal: Set one lock order (evidence_clock, then account_rules_clock, then recipe_plan_state) in every function that takes these locks.
- Done when:
  - `recipe_plan_bump_*`, `favor_food_families`, `set_food_membership`, `get_or_create_food_ref` and the barcode upsert follow the order.
  - A two-session Postgres test runs the old deadlock pairs and passes.
  - The order is written in a SQL comment and in AGENTS.md.
- Files: `supabase/migrations/20261202090000_scope_recipe_food_ref_clock.sql`, `20261128090000_recipe_plan_accept.sql`, `20261215090000_favor_food_families.sql`, `lib/server/barcode.ts`, `lib/server/membership-revisions.ts`.
- Risks and guards: New migration only; never edit applied files. Take a backup and apply one file at a time (live-safe). Keep `tests/migrations/favor-families-db.test.ts` and `food-world-clocks-db.test.ts` green.
- Depends on: none.
- Sources: F23 (A162, A163, A096).

### W035 Coach turn budget and limits
Priority P1 / lane coach-ai / size M / owner-only no
- Goal: Count turns, not model steps, and include OpenRouter turns. Make the budget atomic and fail closed, with a per-user limiter.
- Done when:
  - 10/hour and 60/day count one per turn; `coach-openrouter` turns are included (test).
  - The budget check and reserve are one atomic step and fail closed.
  - `POST /api/coach` and `/api/coach/transcribe` call `enforceRateLimit`; `tests/server/ratelimit-call-sites.test.ts` passes.
  - A seq conflict retries; a loser no longer gets a false 503.
  - The weekly review skips accounts with no logged days.
- Files: `lib/server/coach.ts`, `lib/server/coach-threads.ts`, `lib/coach/weekly-review.ts`, `app/api/coach/route.ts`, `app/api/coach/transcribe/route.ts`, `lib/server/ratelimit.ts`.
- Risks and guards: Do not raise the daily cap here (W043). Fail-closed returns 503 `rate_limit_unavailable`. Check an existing thread in production is not blocked after the count change.
- Depends on: none.
- Sources: F24 (A159, A116, A152, A151, P19, A153), SCALE-5.

### W036 Plan-sheet imports
Priority P1 / lane coach-ai / size S / owner-only no
- Goal: Stop turning unreadable document amounts into one portion. Parse fractions and can sizes. Fit the ideas body cap.
- Done when:
  - An unreadable or over-long amount is refused with a typed reason; a test covers it.
  - "½", "1 ½" and "1 (15 oz) can X" parse correctly with a unit test each.
  - The "Not this" list is capped or compressed under 2 KB; a 100-item refill returns 200.
  - A bad redirect `Location` gives an `HttpError`, not a 500.
- Files: `lib/plan/document-clean.ts`, `lib/plan/recipe-jsonld.ts`, `app/api/plan/ideas/route.ts`, `lib/server/recipe-url.ts`.
- Risks and guards: Keep the public-address-only resolver. A refused amount must still let the user pick a portion by hand. Run `tests/plan` and `tests/server/plan-ideas.test.ts`.
- Depends on: W028.
- Sources: F25 (A040, A043, A144, A127, A045).

### W037 MCP route hardening
Priority P1 / lane security / size S / owner-only no
- Goal: Close scope and body gaps in the MCP route.
- Done when:
  - `list_coach_messages` returns the newest N, newest last (test).
  - A batch call needs the read scope for each read tool (test).
  - Body is parsed and size-checked after auth; non-object batch elements answer 400, not 500.
  - The IP limiter runs before the token-hash key; `get_body_data` rejects dates like 2026-02-31.
- Files: `app/api/mcp/route.ts`, `lib/mcp/coach-tools.ts`, `lib/mcp/health-tools.ts`.
- Risks and guards: Existing personal-access tokens must keep working. Check `tests/server/ratelimit-call-sites.test.ts`.
- Depends on: W019.
- Sources: F28 (A101, A111, A059, A102, A131, A150, A104).

### W038 Scale: unbounded reads on hot paths
Priority P1 / lane server-api / size S / owner-only no
- Goal: Page or filter every hot read that breaks past 1,000 rows.
- Done when:
  - `foodsFor` skips soft-deleted `user_foods` and batches its `.in()` lists.
  - The eligible Eats `.in()` read is paged with `fetchAllRows`/`fetchAllChunked`; a 1,500-food test returns all.
  - The recipe catalog cap applies to current published revisions only.
  - Chat search ranks per thread before the global limit.
- Files: `lib/server/day-context.ts`, `lib/server/paged-read.ts`, `app/api/foods/eligible/route.ts`, `lib/server/coach-threads.ts`, `lib/server/recipe-candidates.ts`.
- Risks and guards: A failed page rejects the whole read; never return a partial set. A truncated read may drop a suggestion but must never mark a food allowed.
- Depends on: W012.
- Sources: F29 (A067, P02, P05, A124), B222, SCALE-5.

### W039 Test guards that cannot fail
Priority P1 / lane docs-tests / size S / owner-only no
- Goal: Make three safety tests able to go red.
- Done when:
  - The kosher meat-with-dairy test fails with the rule switched off.
  - The open-world safety test uses an independent admission oracle, not the production evidence builder.
  - The NHANES scan covers data file types (csv, xpt, parquet, json, db).
  - Each fix records a mutation run (guard red, then green) in the PR.
- Files: `tests/meals/open-world-layout.test.ts`, `tests/meals/open-world-safety.test.ts`, `tests/foods/nhanes-no-microdata.test.ts`.
- Risks and guards: Do not weaken any assertion. The 500-profile safety test must keep zero non-allowed admissions.
- Depends on: none.
- Sources: F32 (A060, A058, A057).

### W040 Confirm DB-backed suites run in CI
Priority P1 / lane docs-tests / size S / owner-only no
- Goal: Prove the ~22 `skipIf` suites run in CI, and count skips per run.
- Done when:
  - A CI run log lists skipped tests; the count is written in `docs/`.
  - Suites needing Postgres binaries (coach-undo SQL) run, not skip, in CI.
  - CI fails if the skip count rises above a recorded ceiling.
- Files: `.github/workflows/ci.yml`, `scripts/ci-local-supabase.py`, `tests/migrations/coach-undo-sql.test.ts`, `tests/rls/`.
- Risks and guards: CI minutes cost money; use one existing run, not extra pushes. Do not raise the ceiling without a reason.
- Depends on: none.
- Sources: B169.

### W041 Scale step 1: measure
Priority P1 / lane scale / size S / owner-only no
- Goal: Get real numbers for sizes, queries, tier and sync cost before any scale change.
- Done when:
  - Row counts, table sizes, `pg_column_size(change_log.current)` and `pg_stat_statements` top 20 are recorded.
  - Supabase tier, pool size and JWT mode are written down.
  - A 200-op `/api/sync/ops` batch benchmark and a branch backup run give p50/p95.
  - Hosted `ai_spend_reserve` latency is measured (local p95 was 0.18-0.3 s).
- Files: `scripts/timings.ts`, `app/api/sync/ops/route.ts`, `app/api/jobs/backup/route.ts`, `lib/ai/spend.ts`, `docs/operations/` (new report).
- Risks and guards: Read-only on production; run benchmarks on a branch. Needs the Vercel token (W050) for logs and env.
- Depends on: W050.
- Sources: SCALE-1, B142.

### W042 Scale step 2: alerts
Priority P1 / lane scale / size S / owner-only no
- Goal: Make cron, backup and spend failures visible.
- Done when:
  - An error tracker and an uptime check on `/api/health` are live.
  - Alerts fire for a stale `job_cursors` pass, a stale `backup_runs` row (36 h) and spend over 60% of cap.
  - Lookup grounding cost (over 5,000 queries a month) has a watch.
  - One test alert per rule proves delivery.
- Files: `app/api/health/route.ts`, `app/api/jobs/backup/route.ts`, `lib/server/job-sweep.ts`, `lib/ai/spend.ts`, `vercel.json`.
- Risks and guards: Alert payloads carry no user data. A new vendor costs money; ask Devin before adding one.
- Depends on: W050.
- Sources: SCALE-2, B047, B172.

### W043 Scale step 3: AI budget policy
Priority P1 / lane scale / size S / owner-only no
- Goal: Stop background jobs from starving interactive coach turns.
- Done when:
  - Global cap is raised on purpose (owner-approved value, from $50).
  - An interactive share is reserved; background jobs (weekly review, facet-warm) have their own cap.
  - A test shows background spend at its cap does not refuse a coach turn.
  - `AI_DAILY_SPEND_CAP_USD` and `AI_GLOBAL_DAILY_SPEND_CAP_USD` changes are in the env docs.
- Files: `lib/ai/spend.ts`, `lib/ai/call.ts`, `lib/ai/call-ledger.ts`, `supabase/migrations/20261218090100_ai_spend_reservations.sql` (change ships as new migration).
- Risks and guards: Raising a cap is new spend; get Devin's number first. Apply the migration before the code. Keep fail-closed.
- Depends on: W035.
- Sources: SCALE-3, B101.

### W044 Scale step 4: indexes and retention
Priority P1 / lane server-db / size S / owner-only no
- Goal: Add the missing indexes and purge unbounded tables.
- Done when:
  - Indexes exist on `ai_calls (provider, model_id, status, created_at)` and `log_items (food_ref_id)`, built `CONCURRENTLY`.
  - Purge jobs run for `client_timings`, `ai_calls`, `job_runs` and `recipe_plan_previews`, in bounded passes.
  - Row counts before and after are recorded.
- Files: `lib/ai/circuit.ts`, `app/api/jobs/signal-purge/route.ts` (pattern), `vercel.json`, new migrations.
- Risks and guards: `CREATE INDEX CONCURRENTLY` cannot run in a transaction; ship it as its own file. Do not prune `ai_calls` rows that open spend holds still name. Cron routes check the secret before the limiter.
- Depends on: W041.
- Sources: SCALE-4.

### W045 Scale step 5: safety quick fixes
Priority P1 / lane scale / size S / owner-only no
- Goal: Add cheap guards before user count grows.
- Done when:
  - `maxDuration` is set on `app/api/sync/ops/route.ts`.
  - `sync_changes` pages have a byte cap (target 2 MB) with a test.
  - `loadAccountPrior` is memoized.
- Files: `app/api/sync/ops/route.ts`, `app/api/sync/changes/route.ts`, `lib/foods/universe/artifacts.ts`, `lib/sync/client.ts`.
- Risks and guards: A byte cap must not break `PAGE_LIMIT` cursor logic. Region pin stays `sfo1` (`tests/speed/region-pins.test.ts`).
- Depends on: W038, W035.
- Sources: SCALE-5.

### W046 Scale step 6: hosted backup
Priority P1 / lane server-ops / size M / owner-only no
- Goal: Move the full backup off the Mac and prove hosted restore.
- Done when:
  - PITR or a scheduled hosted `pg_dump` runs; a staleness alert fires after 36 h.
  - A restore drill on a fresh hosted branch, plus a Storage drill, are recorded with role checks.
  - The JSON backup has a tested importer, or the runbook says "export-only".
- Files: `docs/operations/backup-recovery.md`, `scripts/backup.sh`, `scripts/restore-to-branch.sh`, `app/api/jobs/backup/route.ts`.
- Risks and guards: PITR may cost money; ask Devin. Restore on a branch only, never over production. Back up before any prod change.
- Depends on: W016, W041.
- Sources: SCALE-6, B139, B157, B153.

### W047 Scale step 7: cut fan-out
Priority P1 / lane sync / size M / owner-only no
- Goal: Cut redundant requests per device per sync pass.
- Done when:
  - `SYNCED_EVENT` fires only when data changed; request count per pass is measured before and after.
  - One warm call replaces the extra pings.
  - Cheap GETs use the allowed `fail_open` limiter or thinner keys (listed in `SINGLE_READ_GETS`).
  - The eligible cache keys on the rules token, evidence token and diet flags.
- Files: `lib/sync/account-sync.ts`, `lib/warm-client.ts`, `app/api/warm/route.ts`, `lib/foods/eligible-client.ts`, `lib/server/ratelimit.ts`.
- Risks and guards: A stale eligible cache must never admit a food under older rules (`tests/foods/rules-freshness.test.ts`). The `SINGLE_READ_GETS` list is reviewed per route.
- Depends on: W041, W026.
- Sources: SCALE-7.

### W048 Scale step 8: replay receipts, change_log compaction
Priority P1 / lane server-db / size L / owner-only no
- Goal: Bound `change_log` growth without breaking sync.
- Done when:
  - A replay-receipts table lets op replay stop depending on old `change_log` rows.
  - Per-entity snapshots exist; a stale cursor receives a snapshot.
  - Pruning runs only behind snapshots; a new-phone sync from zero is tested.
  - Triggers (5 GB, 5M rows, first sync over 15 pages) are documented.
- Files: `supabase/migrations/20260911000600_rpc.sql` (origin of `apply_sync_op`), `app/api/sync/changes/route.ts`, `lib/sync/client.ts`, new migrations.
- Risks and guards: No plain TTL. Do not rewrite the protocol. Back up first; apply one file at a time; dry-run on a branch copy of production data.
- Depends on: W041, W026.
- Sources: SCALE-8.

### W049 Sign-up load test and job-sweep soak
Priority P1 / lane scale / size S / owner-only no
- Goal: Measure concurrent sign-up and 1,000-account job sweeps on an isolated stack.
- Done when:
  - A sign-up run records p50/p95 and error rate at machine load under 20.
  - A seeded 1,000-account soak completes a `job-sweep` pass; pass time and retry depth are recorded.
  - The auth email limit is named as the ceiling.
- Files: `scripts/test-stack.sh`, `lib/server/job-sweep.ts`, `lib/server/job-cursor.ts`, `tests/jobs/job-sweep.test.ts`.
- Risks and guards: Never run against production. Delete the seeded accounts after.
- Depends on: W041.
- Sources: B099, B141, B163, B280.

### W050 Team-scoped Vercel token
Priority P1 / lane owner / size S / owner-only YES
- Goal: Give the Vercel MCP a token that works for the team that holds the project.
- Done when:
  - The vault holds the new token; the Vercel MCP connects (today: HTTP 401).
  - An agent can list production env names and read a deploy log.
- Files: none in the repo; ZS Vault entry.
- Risks and guards: Owner creates the token. Never print it in chat or logs. Scope to the project team only.
- Depends on: none.
- Sources: B118.

### W051 Auth production config
Priority P1 / lane owner / size S / owner-only YES
- Goal: Remove the built-in mail limit and fix Spam-foldered sign-up mail.
- Done when:
  - Custom SMTP is set and the hourly limit goes from 150 to 900.
  - Sign-up is on (`disable_signup=false`) and the Confirm template uses `{{ .Token }}`.
  - DMARC `p=none` with `rua` exists for zerosumsolutions.com.
  - One test sign-up lands in the Inbox.
- Files: none (Supabase and DNS settings); `docs/decisions/2026-09-25-self-serve-signup.md` for the receipt.
- Risks and guards: A new mail vendor costs money; Devin picks it. The Cloudflare account owner is unknown; recovery may be needed.
- Depends on: none.
- Sources: B101, B102, B278.

### W052 Server-side limits for OTP and password sign-in
Priority P1 / lane security / size S / owner-only no
- Goal: Add IP-keyed server limits for sign-in, and review the Supabase auth limits.
- Done when:
  - OTP and password sign-in calls pass through an IP-keyed limiter (`requestIp`); 11th call in the window gets 429.
  - Supabase dashboard auth limits are reviewed and recorded.
  - The `/signup` endpoint abuse path is addressed or documented.
- Files: `app/sign-in/page.tsx`, `lib/server/ratelimit.ts`, `lib/server/request-ip.ts`, `middleware.ts`.
- Risks and guards: Fail closed with 503 on a limiter fault. Do not lock out the owner's own IP. Static keys only for cron routes.
- Depends on: none.
- Sources: B103.

### W053 App-hardening branch
Priority P1 / lane security / size M / owner-only no
- Goal: Land security headers, error pages and `/api/client-errors` after fixing the review BLOCK.
- Done when:
  - Crash reports pass an allowlist of error codes and route patterns; free text is dropped (test).
  - The 4 KB cap is checked before the body is read.
  - `next.config.ts` has the headers block; `app/error.tsx` and `app/global-error.tsx` exist.
  - The partial shopping add has Undo, or the item is logged as open.
  - Second-model review shows no open BLOCK.
- Files: `next.config.ts`; `app/error.tsx`, `app/global-error.tsx`, `app/api/client-errors/route.ts` (all wip branch, not on main).
- Risks and guards: Rate-limit the new route. Read `node_modules/next/dist/docs/` before touching Next config. Check the CSP against fonts and the PWA. Full script-src CSP stays deferred.
- Depends on: none.
- Sources: B096.

### W054 Supabase advisor backlog
Priority P1 / lane security / size M / owner-only no
- Goal: Triage 15 security warnings and 37 performance infos, and fix the real ones.
- Done when:
  - A fresh advisor run is saved; each finding is fixed, or has a written reason to accept.
  - `search_path` is fixed on `_sync_assert_key`, `catalog_search_doc`, `compute_item_snapshot`.
  - Every `SECURITY DEFINER` RPC callable by `authenticated` is listed; each is revoked or justified.
  - Missing FK indexes are added (`20261218090200` covers some).
- Files: `supabase/migrations/20261218090200_user_id_fk_indexes.sql`, `supabase/migrations/20261228090000_target_writes_service_role_only.sql`, new migrations, `tests/tenancy/`.
- Risks and guards: A revoke can break a phone call; run `tests/tenancy` and `tests/rls`. Apply the server-code change before a revoke. Moving extensions can break functions; do it on a branch first.
- Depends on: W018.
- Sources: B113, B147, B152.

### W055 x-smc-account on every route (verify)
Priority P1 / lane security / size S / owner-only no
- Goal: Prove every account-scoped route checks the account header. Add recovery for held ownerless ops.
- Done when:
  - A test lists all `app/api` routes and fails if one lacks the check or an allowlist reason.
  - A wrong-account header returns an error, not the other account's data.
  - A tool or script lists and recovers held ownerless ops.
- Files: `lib/server/auth.ts`, `app/api/`, `middleware.ts`, `tests/tenancy/`.
- Risks and guards: Old phones may not send the header; check behaviour before it is required. Recovery is owner-run, with a read-only default.
- Depends on: none.
- Sources: B106.

### W056 Unscoped legacy device storage (verify)
Priority P1 / lane security / size S / owner-only no
- Goal: Find any localStorage or IndexedDB key not scoped by account.
- Done when:
  - A grep and a runtime test list every key; each is scoped or removed.
  - A two-account sign-in on one browser shows no data from the first account.
  - The result is written in `docs/readiness/`.
- Files: `lib/store.ts`, `lib/sync/idb.ts`, `lib/foods/prefs-client.ts`, `docs/readiness/2026-09-15/plan-cache-follow-up.md`.
- Risks and guards: Do not delete a key that holds unsynced ops. Wrap storage in try/catch (private windows).
- Depends on: none.
- Sources: B159.

### W057 Self-serve account deletion
Priority P1 / lane security / size M / owner-only no
- Goal: Finish and land deletion behind `ACCOUNT_DELETION_ENABLED` (default off).
- Done when:
  - Settings flow, `/api/account/delete` and `delete_account()` are reviewed by the other model family.
  - A DB test shows deletion removes every user-owned table row and Storage object; the table list comes from the schema (see F10).
  - The ExportCard copy fix ships with it.
  - The migration is applied to production before the flag turns on.
- Files: `app/api/account/delete/route.ts` and the Settings flow (wip branch), `supabase/migrations/` (renumbered file), `app/api/export`.
- Risks and guards: Destructive and permanent; owner turns the flag on. Re-auth required; rate-limit the route. Back up before the first live delete.
- Depends on: W023.
- Sources: B098, B252, B044.

### W058 Honest-nutrition UI cleanup (t1h) (verify)
Priority P1 / lane ui-today / size M / owner-only no
- Goal: Show correct nutrition and rule marks in the UI.
- Done when:
  - `ruleMark` renders on slots, recipe selections and shopping lines.
  - Partial recipe nutrition is labelled partial, not a full serving.
  - The vegan badge claims only on complete ingredient evidence, not on tags.
  - Recipe fit counts protein; small-portion rounding is fixed. Each item has a test or a "already fixed" note.
- Files: `components/SlotCard.tsx`, `components/RecipeDetails.tsx`, `components/nutrition/*`, `lib/recipes-hub/diet.ts`, `components/LogFoodSheet.tsx`.
- Risks and guards: Do not hide rule-marked items (marks, never refuses). Run `tests/design/inline-style.test.ts`; no raw colours.
- Depends on: W030.
- Sources: B052.

### W059 Barcode foods in name search
Priority P1 / lane capture-catalog / size S / owner-only no
- Goal: Make scanned foods appear in `catalog_search`.
- Done when:
  - `catalog_search` includes `off` and `fdc_branded` versions in the active join; the score expression is unchanged.
  - A DB test: scan a food, then search its name, get a hit; a rescan does not duplicate rows.
  - The 0.95 / 0.3 auto-resolve gate is recorded as a separate owner call.
- Files: `supabase/migrations/20261018090200_*.sql` (change ships as a new migration), `lib/server/catalog.ts`, `lib/server/barcode.ts`, `lib/search/thresholds.ts`.
- Risks and guards: Keep the relevance gate (top-1 at least 82%; `docs/catalog/relevance.md`). Policy categories still derive for rows not annotated. Apply the migration before the code.
- Depends on: none.
- Sources: B007, B064.

### W060 Phase 12 checked-writer cutover
Priority P1 / lane targets-safety / size M / owner-only no
- Goal: Add `write_target_revision_checked` with a `below_floor` result, and route `/api/targets` and proposals through it.
- Done when:
  - The SQL function and the floor migration exist; below-floor input is refused with `below_floor`.
  - `lib/server/targets.ts`, `lib/server/proposals.ts` and `app/api/targets` use it; the old writer is not called.
  - Weight and height units from chat are handled; tests named in the PR.
  - Owner confirms minima (protein 1.8 / 2.0 g/kg, `macroMinimumKcal`).
- Files: `lib/server/targets.ts`, `lib/server/proposals.ts`, `lib/server/target-writes.ts`, `app/api/targets/route.ts`, `docs/specs/phase-12-coach-tools.md`, new migration.
- Risks and guards: Writers are service-role only (`20261228090000`, already applied). Spec needs a second-model audit first. Pace holds and the adult floor stay. Apply the migration before the code; canary `tests/tenancy/admin-targets.test.ts`.
- Depends on: W007, W008.
- Sources: B029, B066, B250, B166.

### W061 Owner: physical-device acceptance
Priority P1 / lane owner / size M / owner-only YES
- Goal: Record real-device results for the unproven journeys.
- Done when:
  - Installed iPhone PWA: offline start, three barcode scans under 5 s, voice, share, calendar, device ingest, second-device equality.
  - Meal-card long-press drag, FAB single and double tap, day strip under 360 px, and the per-slot time editor are checked.
  - A receipt with pass or fail per journey is saved in `docs/readiness/`.
- Files: `docs/readiness/2026-09-15/README.md` (blocker 5), `docs/audit/2026-09-27-composer/acceptance.md`.
- Risks and guards: Needs a person with a phone. Use a test account, not Sasha's. Failures become backlog items, not silent notes.
- Depends on: none.
- Sources: B050, B154, B236, B093, B089.

### W062 Owner: re-test onb3 and flip the onboarding flag
Priority P1 / lane owner / size S / owner-only YES
- Goal: Turn on the new onboarding in production after a phone re-test.
- Done when:
  - Owner re-tests #36, #37, #39 on a phone, including 375x812.
  - `NEXT_PUBLIC_CHAT_ONBOARDING=1` is set and production is redeployed.
  - `docs/specs/onboarding-as-built.md` lists the PRs as merged.
- Files: `components/Onboarding/`, `docs/specs/onboarding-as-built.md`, `docs/readiness/2026-09-19/03-env.md`.
- Risks and guards: Flag was rolled back 2026-10-07; keep the rollback plan. Grandfathered accounts must not be forced through the flow. The U.S. country chip goes live with this flag.
- Depends on: W009.
- Sources: B040, B059, B247.

### W063 Owner: production data-repair script runs
Priority P1 / lane owner / size S / owner-only YES
- Goal: Run each repair script read-only on production, then `--fix --production` as an owner step.
- Done when:
  - `food-role-audit`, `food-membership-audit`, `recompute-target` (including user 40707946, 2104 vs 1960 kcal), `allergen-jev-holds --review` and `annotate-policy-categories --commit` each have a receipt.
  - A second `annotate-policy-categories` run covers barcode rows written by the old writer.
  - The audit reports show 0 contradictions after the fix.
- Files: `scripts/food-role-audit.ts`, `scripts/food-membership-audit.ts`, `scripts/recompute-target.ts`, `scripts/allergen-jev-holds.ts`, `scripts/annotate-policy-categories.ts`.
- Risks and guards: Production writes are an owner step with a backup first. Run membership repair after W029 so it does not fight the code. Never print user data.
- Depends on: W029.
- Sources: B232, B168, B010, B277.

### W064 Owner: delete the production smoke-test account
Priority P1 / lane owner / size S / owner-only YES
- Goal: Remove the agent-created account `mc-smoke-2026-09-13` (id 5a68b049-736c-4dc4-939c-9a257a1f2116) from production.
- Done when:
  - Owner deletes the account and its rows and Storage objects.
  - A count query shows 0 rows for that user id in user-owned tables.
  - The deletion is recorded in `docs/decisions/2026-09-13-audit-rulings.md` (R11a).
- Files: none in the repo; the cleanup script is gone. W057 gives a supported path.
- Risks and guards: Destructive; take a backup first. Agents never do this step. Agents must not create production accounts again (R11a).
- Depends on: none.
- Sources: B255.

### W065 Measure coach and capture speed (verify)
Priority P1 / lane coach-ai / size S / owner-only no
- Goal: Get current p50/p95 numbers for capture and coach, cold and warm.
- Done when:
  - `pnpm timings` and `pnpm timings:ai` output for label, plate and coach is saved in `docs/readiness/`.
  - Coach first-text p95 on the OpenRouter lane is compared with the 3 s and 15 s targets.
  - A streaming decision is written down from the numbers.
- Files: `scripts/timings.ts`, `lib/timing.ts`, `app/api/timings/route.ts`, `docs/plans/2026-09-17-t0-speed-foundations.md`.
- Risks and guards: Needs enough `client_timings` rows (T0 migration applied). Real model calls bill the metered lane; keep the run small and use the lane pins.
- Depends on: none.
- Sources: B025.

### W066 Owner: resolve the Gemini project 403
Priority P1 / lane owner / size S / owner-only YES
- Goal: Restore Gemini access so lookup grounding and the Gemini twins work.
- Done when:
  - A Gemini call from the project key returns 200.
  - Lookup grounding returns facts again, not "no fact today".
  - `scripts/ai-canary.ts` passes for the Gemini lanes.
- Files: `lib/ai/lanes.ts`, `lib/ai/gemini-grounded.ts`, `scripts/ai-canary.ts`.
- Risks and guards: Owner fixes billing or project access; the key stays in ZS Vault. Metered spend counts toward the AI cap.
- Depends on: none.
- Sources: B101, B077.


## P2 specs

### W067 Care points ledger: server-side balance sum, full-week accolade on any sync, no raise on zone-day mismatch
P2 / ui-today / S / not owner-only
- Goal: Make the seeds balance correct past 1,000 ledger rows. Make the full-week accolade and the sync date check work on any day.
- Done when:
  - A `care_balance` RPC (or a paged read) returns the exact balance and pending sum for an account with more than 1,000 rows; a test seeds 1,001+ rows.
  - A sync on Monday to Saturday grants the full-week accolade for the previous closed week when the retained-meal rule holds.
  - `care_points_sync` does not raise `22023 future_date` when the phone's day is one day ahead of the stored zone's today; the date is clamped or accepted within one day.
  - `tests/care/care-points-routes.test.ts` covers the three cases.
- Files: `lib/server/care-points.ts`, `lib/server/care-shop.ts`, `lib/server/care-accolades.ts`, `supabase/migrations/20261225090300_care_accolades.sql`, `supabase/migrations/20261225090100_care_points_ledger.sql`, `lib/server/care-zone.ts`, `tests/care/`.
- Risks and guards: New migration (do not edit applied ones); apply to production before the code merges. Care points hold no nutrition or safety data. Keep `lib/server/account-day.ts` rules for the account day.
- Depends on: none.
- Sources: F26; A106, A107, A108.

### W068 AI call layer: abort before retry, caller aborts not counted toward circuit, status-only provider errors, spend seed
P2 / coach-ai / S / not owner-only
- Goal: Stop a caller abort from starting a retry, from poisoning the shared circuit, or from leaking provider error text. Stop double-charging spend after UTC midnight.
- Done when:
  - `callModel` checks `signal.aborted` before each retry and attaches a rejection handler to the in-flight `send`; a test with an abort during backoff shows no second attempt and no unhandled rejection.
  - A caller abort or short Jev deadline records an `abort` outcome that `circuit.ts` does not count; `tests/ai/failures-circuit.test.ts` proves 5 aborts leave the circuit closed.
  - `ai_calls.error` and logs keep only `HTTP <status>` for every user-content purpose, Gemini (`lib/ai/adapter.ts`) and Jev (`lib/ai/typesafe.ts`) included; `tests/ai/typesafe-redaction.test.ts` extended.
  - `_ai_spend_lock_day` seeds day rows from `ai_calls` rows with no `spend_reservation_id` only; a DB test crosses UTC midnight.
- Files: `lib/ai/call.ts`, `lib/ai/circuit.ts`, `lib/ai/typesafe.ts`, `lib/ai/adapter.ts`, `lib/server/plan-ideas.ts`, `supabase/migrations/20261218090100_ai_spend_reservations.sql` (new migration replaces the function), `tests/ai/spend.test.ts`.
- Risks and guards: `tests/ai/call-registry.test.ts` boundary rules stay green; `callModel` stays the only governed path; `call-ledger.ts` stays the only `ai_calls` writer. New migration for the spend function.
- Depends on: W043.
- Sources: F27; A001, P01, A149, A084, P13, A161.

### W069 API input validation: shared calendar-date, UUID and limit parsers; catalog search trim and detail checks
P2 / server-api / S / not owner-only
- Goal: Answer malformed dates, ids and limits with 400 or 404. Never answer with a Postgres 500.
- Done when:
  - One shared validator rejects impossible dates (`2026-13-45`); health daily, `lib/health/contract.ts`, MCP `get_body_data` and export `from`/cursor use it.
  - UUID and integer-limit parsers guard `app/api/coach/threads/[id]`, `app/api/health/tokens/[id]`, `app/api/proposals/[id]/decide` and recipe ids; `?limit=abc` and `?limit=2.5` answer 400.
  - `GET /api/foods/search` trims `q`; whitespace-only answers 400. `getFoodDetail` checks the version is active, as search does.
  - One route test per fixed route.
- Files: `lib/server/health-daily.ts`, `lib/health/contract.ts`, `lib/mcp/health-tools.ts`, `app/api/health/daily/route.ts`, `app/api/coach/threads/[id]/route.ts`, `app/api/health/tokens/[id]/route.ts`, `app/api/proposals/[id]/decide/route.ts`, `app/api/foods/search/route.ts`, `lib/server/catalog.ts`, `lib/server/validate.ts` (new).
- Risks and guards: A stricter detail check can hide foods that were reachable by id; check the catalog tests first. `tests/server/ratelimit-call-sites.test.ts` stays green.
- Depends on: W038.
- Sources: F30, B249; A132, A073, A056, A105, A125.

### W070 Telemetry and event tables: revoke direct INSERT, rate-checked writers, client_timings checks NOT VALID then VALIDATE
P2 / server-db / S / not owner-only
- Goal: Make the database enforce the quotas that only the routes enforce today.
- Done when:
  - `authenticated` has no INSERT on `client_timings`, `onboarding_events` and `food_signal_events`; the routes write through the admin client or a rate-checked definer function.
  - A migration test shows a direct PostgREST insert fails with 42501 for each table.
  - `client_timings_path_check` and `client_timings_step_check` are re-added `NOT VALID` with `lock_timeout 3s`, then validated in a follow-up file.
- Files: `supabase/migrations/20261019090100_client_timings.sql`, `supabase/migrations/20261226090200_onboarding_events.sql`, `supabase/migrations/20261229090000_client_timings_plan_chips.sql` (all read only; add new files), `app/api/timings/route.ts`, `app/api/onboarding/events/route.ts`, `app/api/foods/signals/route.ts`, `lib/server/food-signals.ts`, `lib/server/onboarding-events.ts`.
- Risks and guards: Apply the revoke AFTER the code that writes through the service role is live, or the older build gets 42501 and loses telemetry (routes answer 202 either way). `record_food_signals` is `security invoker`; it must move to a definer or the admin client first. Keep the admin-client canary tests (`tests/tenancy/`).
- Depends on: W044.
- Sources: F31; A121, A145, P11.

### W071 Scale step 9: single-round-trip RPCs (apply_sync_ops batch with stamping, consolidated log commit, queued per-account jobs)
P2 / server-db / M / not owner-only
- Goal: Cut database round trips on the sync and log paths once measurement shows they dominate latency.
- Done when:
  - `apply_sync_ops` applies a batch in one RPC and returns per-op results equal to today's per-op results (golden test over the existing sync fixtures).
  - Occasion stamping runs inside the same call; `tests/server/log-occasion.test.ts` stays green.
  - `pnpm timings` p95 for `/api/sync/ops` and `/api/log/commit` before and after is recorded in the PR.
  - Per-account job work goes through a queue that `job-sweep` can resume.
- Files: `app/api/sync/ops/route.ts`, `lib/server/log-occasion.ts`, `lib/server/log.ts`, `lib/server/job-sweep.ts`, `scripts/timings.ts`, new migration for the batch RPC.
- Risks and guards: Keep per-op idempotency and conflict rules identical (op-log guards in `tests/sync/`). Build only if measured gain; stop after the measurement if not. New function bodies ship in a migration applied to production first.
- Depends on: W041, W026.
- Sources: SCALE-9.

### W072 Scale step 10: remove O(users) work (global catalog-ref revision, compute-tier triggers, partition big tables before Tier C)
P2 / server-db / M / not owner-only
- Goal: Remove writes that grow with the number of users. Prepare large tables for Tier C.
- Done when:
  - A catalog-ref change bumps one global revision row, not one `recipe_plan_state` row per user; a DB test counts rows touched.
  - Triggers that fire on shared catalog writes are listed and each is either removed or proven O(1).
  - A partition plan for `ai_calls`, `change_log` and `client_timings` is written with sizes and cut-over steps; no cut-over runs in this item.
- Files: `supabase/migrations/20261202090000_scope_recipe_food_ref_clock.sql` (read only), `lib/server/recipe-plan.ts`, new migration, `docs/` plan note.
- Risks and guards: Recipe/shopping migrations keep their order; `recipe_plan_bump_*` lock order must match batch F23 rules (evidence_clock, account_rules_clock, recipe_plan_state). Test on a branch DB, never production.
- Depends on: W034, W041.
- Sources: SCALE-10.

### W073 Phase 12 Later: floor check at proposal approval, one transaction for profile+target, weigh-in retarget RPC, below-minimum warning
P2 / targets-safety / M / not owner-only
- Goal: Close the remaining target write paths after the checked-writer cutover.
- Done when:
  - Approving a proposal re-checks the revision's floors and refuses or clamps; a test approves a proposal that crosses a floor.
  - A profile edit and its derived target revision commit in one transaction (one RPC); a failure leaves neither.
  - A weigh-in retarget RPC is idempotent on its action id.
  - Today shows a below-minimum warning and a dropped-target notice; component tests cover both.
- Files: `lib/server/proposals.ts`, `lib/server/targets.ts`, `lib/server/target-writes.ts`, `lib/server/target-recompute.ts`, `lib/profile/derive.ts`, `lib/targets/client.ts`, `docs/specs/phase-12-coach-tools.md`.
- Risks and guards: Target writers are service-role only (`20261228090000`); apply that migration after the code, as AGENTS.md says. Keep "a calorie change never moves protein" and the adult/pace-hold rules (`tests/tenancy/admin-targets.test.ts`). New RPCs need a migration applied first.
- Depends on: W060.
- Sources: B030.

### W074 goal_rate_bp_week preset CHECK on target_profiles; recheck confirm-your-rate invitation need
P2 / targets-safety / S / not owner-only
- Goal: Let the database refuse a `goal_rate_bp_week` outside the presets on `target_profiles`.
- Done when:
  - A migration adds the same preset check as `user_settings` (`20261029090000`) as `NOT VALID`, then `VALIDATE` in a follow-up file.
  - A DB test shows an off-preset insert fails and an existing row still reads.
  - A production count of accounts with null `goal_rate_bp_week` on loss/gain goals is recorded; if above 0, a ticket for the invitation is opened, else the item is closed.
- Files: `supabase/migrations/20261029090000_*.sql` (read the preset list), new migration, `lib/server/targets.ts`, `tests/migrations/`.
- Risks and guards: Validate only after checking existing rows; `lock_timeout 3s`. Apply the migration before any code that relies on it.
- Depends on: W007.
- Sources: B124, B241.

### W075 Extend test_reset_user for about 19 newer user-owned tables
P2 / docs-tests / S / not owner-only
- Goal: Make `test_reset_user` delete every user-owned table, so DB tests do not leak state.
- Done when:
  - `supabase/seed/test_helpers.sql` has a guarded `to_regclass` delete for each table that has a `user_id` column (now 3).
  - A test lists tables with `user_id` from the migrations and fails when one has no delete.
  - The DB suite passes twice in a row on one branch DB with the reset between.
- Files: `supabase/seed/test_helpers.sql`, `tests/migrations/`, `tests/tenancy/`.
- Risks and guards: Delete order follows foreign keys. The helper runs only on branch or local DBs; never apply it to production.
- Depends on: none.
- Sources: B144, B275, B166.

### W076 Endpoint security matrix test: identity, body limit, rate limit, idempotency per route
P2 / docs-tests / M / not owner-only
- Goal: Add one test that fails when a route lacks a declared security contract.
- Done when:
  - A table lists every `app/api/**/route.ts` handler with identity (session, token, cron secret, public), body limit, limiter key and idempotency key (or "none, reason").
  - The test walks the route tree and fails for a route missing from the table.
  - Known gaps (only `log/commit`, `jobs/weekly-proposal`, `sync/ops` have idempotency keys) are listed as explicit exceptions with a reason.
- Files: `tests/server/endpoint-security-matrix.test.ts` (new), `tests/server/ratelimit-call-sites.test.ts` (reuse its route walk), `docs/features.md` (F-099).
- Risks and guards: Do not duplicate `SINGLE_READ_GETS`; import it. Cron routes check their secret before the limiter.
- Depends on: W037.
- Sources: B115.

### W077 Identify and fix the flaky test trio (F7) and close ruling follow-ups
P2 / docs-tests / S / not owner-only
- Goal: Name the three flaky tests, fix their cause and close the F7 follow-ups.
- Done when:
  - The three tests are named from CI history (`gh run list` failures) with the recurrence mechanism written in `vitest.config.ts`.
  - Each passes 20 times in a loop locally.
  - The fast-path reply pair (D5), canonical food identity (D7) and serving-yield follow-ups each have a decision line: build, defer with reason, or drop.
- Files: `vitest.config.ts`, `docs/decisions/2026-09-19-sol-rulings.md`, `docs/decisions/2026-09-19-jev-everywhere-rulings.md`, the three test files.
- Risks and guards: Fix the test or the code, never retry flags. CI minutes cost money; run only the three specs.
- Depends on: none.
- Sources: B285, B053.

### W078 CI and test secret hygiene: fix six zizmor warnings, add a zizmor step, move DB URL out of argv
P2 / security / S / not owner-only
- Goal: Remove the known workflow warnings and keep credentials out of process arguments.
- Done when:
  - `zizmor` runs clean (or each remaining finding has a written suppression) on `ci.yml`, `migration-drift.yml`, `model-freshness.yml`.
  - A zizmor step gates CI.
  - `psql()` in `tests/catalog/helpers.ts` passes the URL through `PGSERVICEFILE` or env, not argv; a test greps the helper for the URL in the arg list.
- Files: `.github/workflows/ci.yml`, `.github/workflows/migration-drift.yml`, `.github/workflows/model-freshness.yml`, `tests/catalog/helpers.ts`.
- Risks and guards: No `blacksmith-*` runner labels (retired). Batch with one PR to save CI minutes.
- Depends on: none.
- Sources: B119, B120, B158.

### W079 Full script-src CSP plus Lighthouse mobile and bundle-size CI gates
P2 / security / M / not owner-only
- Goal: Add a strict `script-src` policy and CI gates for mobile performance and bundle size.
- Done when:
  - `next.config.ts` or `middleware.ts` sends a nonce-based `script-src` CSP; Today, Foods, Settings and Coach load with zero CSP violations in a browser check.
  - CI runs Lighthouse mobile on Today, Foods, Settings, Coach and fails under set budgets.
  - A bundle-size budget fails CI when a route grows past its limit.
- Files: `next.config.ts`, `middleware.ts`, `.github/workflows/ci.yml`, `app/layout.tsx`, parked branch `wip/2026-10-08-app-hardening` (headers block).
- Risks and guards: Land the headers block first; start the CSP in report-only. Service worker (`public/sw.js`) and `next/font` must still load.
- Depends on: W053.
- Sources: B097, B138, B166.

### W080 HEALTH_TOKEN_KEY rotation / re-seal script
P2 / security / S / not owner-only
- Goal: Let the owner rotate `HEALTH_TOKEN_KEY` without every Oura user reconnecting.
- Done when:
  - A script re-seals stored Oura tokens from the old key to the new key; dry run by default, `--commit` writes, `--production` needs the same guard as other owner scripts.
  - A test round-trips old-key to new-key on fixtures and fails on a wrong key without writing.
  - A short runbook states the order: set both keys, re-seal, switch, remove the old key.
- Files: `lib/server/oura.ts`, `lib/server/health-tokens.ts`, `scripts/reseal-health-tokens.ts` (new), `docs/`.
- Risks and guards: Never log key or token values. Back up the table before `--commit`.
- Depends on: W025.
- Sources: B110.

### W081 Env-name drift: HEALTH_INGEST_TOKEN, production-only env names, dark rollout flags and their state
P2 / docs-tests / S / not owner-only
- Goal: Record which env names and dark flags exist and what production sets.
- Done when:
  - `.env.example` documents or drops `HEALTH_INGEST_TOKEN`; the env-name comparison is re-run and attached.
  - A table lists every dark flag (`HEALTH_INGEST_ENABLED`, `ESTIMATOR_ENABLED`, `COACH_ACTIVITY_CONTEXT_ENABLED`, `CONDITION_PACKS_ENABLED`, `RECIPE_PLANNING_USER_IDS`, `REBALANCE_PANEL_USER_IDS`, `OPEN_WORLD_*`, `TASTE_CHIPS_ENABLED`, `NEXT_PUBLIC_CHAT_ONBOARDING`) with the production state and date.
  - Three production-only env names are resolved: added to `.env.example` or removed from Vercel (owner confirms removals).
- Files: `.env.example`, `docs/readiness/2026-09-19/03-env.md`, new `docs/readiness/flags.md` (new).
- Risks and guards: Read production state with names only, never values. Removing a Vercel env is the owner's step.
- Depends on: W050.
- Sources: B111, B214, B276.

### W082 Owner: health production rollout
P2 / owner / M / owner-only
- Goal: Turn on health ingest in production after the fixes land.
- Done when:
  - Oura developer app is registered; `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_REDIRECT_URI` are set in Production.
  - `HEALTH_INGEST_ENABLED`, `HEALTH_TOKEN_KEY`, `HEALTH_TZ` are set; the flag state is recorded in the W081 table.
  - Apple Health shortcuts are published and `NEXT_PUBLIC_APPLE_HEALTH_SHORTCUT_URL` and `_NAME` are set; iOS 26 "Group by Day" is tested on a phone.
  - One real ingest and one Oura sync show up in Settings.
- Files: `lib/server/oura.ts`, `lib/server/health-ingest.ts`, `.env.example`, `docs/specs/phase-5-body-data.md`.
- Risks and guards: Start only after F04 and F14 fixes ship (payload loss, step and energy double count, token refresh, open redirect). Never paste secrets in chat; use ZS Vault. Confirm the ring needs Gen3+ with membership.
- Depends on: W010, W025.
- Sources: B108, B125, B261, B262.

### W083 Owner: widen CAPTURE_METHODS one method per deploy
P2 / owner / S / owner-only
- Goal: Open capture methods in production one at a time, each after its gate.
- Done when:
  - Each method (text, voice, label, photo) has a 10-item eval result and a phone gate result recorded.
  - Voice has a real-phone audio canary result.
  - The production `CAPTURE_METHODS` value after each deploy is recorded.
- Files: `lib/capture/flags.ts`, `lib/capture/public-flags.ts`, `docs/plans/2026-09-11-phase-3-4/README.md`.
- Risks and guards: Open label capture only after the F07 and F11 fixes, photo only after the portion fixes. One method per deploy.
- Depends on: W013, W017.
- Sources: B122.

### W084 Owner: recipe/shopping pilot production deployment and wider enablement
P2 / owner / S / owner-only
- Goal: Enable more accounts for the recipe and shopping pilot with receipts.
- Done when:
  - Seed proof covers all 24 recipes in production, not the first 12.
  - Separate receipts exist for production deploy and for each enablement step (`docs/recipes/pilot-release.md`).
  - A live two-device mutation check is recorded.
  - `RECIPE_PLANNING_USER_IDS` lists only the accounts named in the receipt.
- Files: `docs/recipes/pilot-release.md`, `docs/recipes/pilot-source-rights.md`, `lib/server/recipe-access.ts`, `scripts/seed-recipe-catalog.ts`.
- Risks and guards: Wait for F12 preview crash fixes (W024) and the W085 acceptance tests. Source-rights owner items stay open until the owner answers. No store or price provider exists; package size and price stay unknown.
- Depends on: W024, W085.
- Sources: B020, B149, B251.

### W085 Recipe pilot acceptance gaps
P2 / recipes-shopping / M / not owner-only
- Goal: Prove the pilot's rejection, immutability and concurrency rules with tests.
- Done when:
  - A test shows a recipe with an off-plan ingredient is rejected (R6), including a dairy example and a three-food meal.
  - A test shows a logged recipe keeps its old version after the recipe is edited.
  - A two-account test shows owner scoping for recipes, selections and shopping lines.
  - A DB test runs concurrent consumed-history writes and inline removal and shows no lost or doubled row.
  - `docs/readiness/2026-09-15/README.md` cites the exact test names.
- Files: `tests/recipes/`, `tests/migrations/`, `lib/server/recipe-plan.ts`, `lib/recipe-catalog/`, `docs/readiness/2026-09-15/README.md`.
- Risks and guards: `tests/recipes/consumed-guard-local-db.test.ts` stays green; recipe migrations stay in order. Local Postgres only.
- Depends on: W024.
- Sources: B021, B251.

### W086 Coach Undo receipts PR B: apply_coach_op writer
P2 / coach-ai / L / not owner-only
- Goal: Write receipt_v1 Undo records from a server-minted write identity, or record the decision to drop.
- Done when:
  - The owner has chosen restart (reduced scope: stamp coach-issued actions in saved threads, server-only Undo for stamped actions) or drop; the spec states it.
  - If restart: migration `20261216090500_apply_coach_op.sql` exists, the phone stamps actions, routes call the writer, and cases R1-1, R1-2, R1-3, R1-7, R2-2..4, R3-1, P1, T2 pass.
  - If drop: the spec marks PR B dropped and the stale-device overwrite and E1/E2 bugs get tickets.
- Files: `docs/specs/coach-undo-receipt.md`, `lib/server/coach-undo.ts`, `lib/coach/undo-types.ts`, `components/coach/use-coach-undo.ts`, `components/coach/server-card.ts`, `lib/coach/actions/apply.ts`, `tests/migrations/coach-undo-sql.test.ts`.
- Risks and guards: Parked after about 9 review rounds; a Sol review is required. Receipts are immutable and `record_mode` stays immutable. Apply the migration to production before the code merges.
- Depends on: W003.
- Sources: B038, B055.

### W087 Coach live quality and privacy pass (verify)
P2 / coach-ai / M / not owner-only
- Goal: Measure current coach quality, truncation, leaks and health-context privacy on the OpenRouter lane.
- Done when:
  - `scripts/eval/coach-streak.ts` all-category run reaches 10 consecutive passes on the `coach-eval` branch, or the failures are filed.
  - The share of replies cut by the 1,200-token cap is measured over at least 30 live turns.
  - The off-plan request prompt-leak and 3-minute hang cases are re-run; the result is recorded.
  - One live F10 health-context prompt-log check passes on a non-production provider key and a branch test user; the one-exchange production check (B071) is closed or dropped.
- Files: `scripts/eval/coach-streak.ts`, `scripts/eval/coach-corpus.json`, `lib/ai/lanes.ts`, `docs/evals/2026-09-19-coach-streak.md`, `docs/readiness/2026-09-19/12-health-context.md`.
- Risks and guards: Bills real keys; never in CI. Use the `COACH_STREAK_BRANCH` rule. Do not create or reset the branch inside the script. Mark B069 and B071 superseded if the fresh runs are clean.
- Depends on: none.
- Sources: B051, B121, B069, B071, B112.

### W088 Transactional coach thread and message saves
P2 / coach-ai / S / not owner-only
- Goal: Save a coach thread and its first messages in one transaction.
- Done when:
  - One RPC appends a message and creates the thread when needed; a forced failure mid-call leaves no empty thread.
  - Concurrent seq collisions retry inside the function.
  - A cleanup script lists old empty threads (dry run) for the owner to delete.
- Files: `lib/server/coach-threads.ts`, `lib/server/coach-turn.ts`, `app/api/coach/threads/route.ts`, new migration, `tests/coach/`, `tests/migrations/`.
- Risks and guards: Owner-scoped RLS stays; service-role writes use an explicit `user_id`. Apply the migration before the code. Coordinate with the F24 seq-conflict retry.
- Depends on: none.
- Sources: B070.

### W089 Raise Jev MAX_LOGICAL_CALLS for plan-sheet chips and update the one-call test and W10 spec text
P2 / coach-ai / S / not owner-only
- Goal: Match code and spec to the owner's 2026-10-08 ruling that Jev calls are not capped at one.
- Done when:
  - `MAX_LOGICAL_CALLS` in `lib/ai/request-budget.ts` is raised to a stated number; the "at most one Jev call" test is updated.
  - The Phase 18 decisions log and the W10 acceptance 2 text carry the change.
  - Formula-order fallback and the 450 ms chip deadline stay; `tests/plan/ideas-chips.test.ts` is green.
- Files: `lib/ai/request-budget.ts`, `lib/server/plan-ideas.ts`, `docs/specs/phase-18-open-world-foods.md`, `tests/plan/ideas-chips.test.ts`.
- Risks and guards: The spend reservation and rate limit still bound cost. Do not unbound the loop.
- Depends on: none.
- Sources: B078, B200.

### W090 ExportCard: narrow the "Everything you have logged" claim; check closed-gate health context in coach (verify)
P2 / ui-settings / S / not owner-only
- Goal: Make the export copy match what the export holds.
- Done when:
  - `components/ExportCard.tsx` names exactly the 2 exports it offers; a component test checks the copy.
  - A note lists the 8 backend export kinds and whether to expose coach transcripts or profile export (decision recorded).
  - With the health gate closed, a coach turn test shows no health context in the prompt.
- Files: `components/ExportCard.tsx`, `lib/server/export.ts`, `lib/server/coach-context.ts`, `tests/coach/`.
- Risks and guards: ExportCard copy work also sits on parked `wip/2026-10-08-app-hardening` with a Sol BLOCK; read it before editing to avoid two versions.
- Depends on: W012.
- Sources: B060, B033.

### W091 Stream coach replies (first visible text 3 s or less)
P2 / coach-ai / L / not owner-only
- Goal: Show first coach text within 3 s at p95, if measurement shows it is needed.
- Done when:
  - Current first-text p95 is measured from `client_timings` and written down; build only if it is far above 3 s.
  - If built: `POST /api/coach` streams events, the client renders partial text, and card/action blocks arrive only after validation.
  - Fast-path actions keep present-tense copy until applied.
- Files: `app/api/coach/route.ts`, `lib/server/coach-turn.ts`, `lib/coach-client.ts`, `components/CoachChat.tsx`, `lib/fetch-with-deadline.ts`.
- Risks and guards: The reply check (`coach-verify`) must run before an unsupported claim shows, or the stream must label text as draft. Provider calls stay in `callModel`. The spend reservation and limiter stay fail closed.
- Depends on: W065.
- Sources: B024.

### W092 Phase 19b day rebalance
P2 / nutrition-engine / L / not owner-only
- Goal: Let the rebalance panel resize plates and apply changes with one Undo.
- Done when:
  - Options resize generated plates, trim, clear or move several slots, enlarge portions and add a dense side food.
  - Batch apply writes all edits and one Undo reverses all of them; coach `rebalance_day` carries an `editsHash`.
  - Protein never moves on a calorie change; tests in `lib/rebalance/` cover each option.
  - The 90-minute grace, the `max(100, 5% of T)` tolerance and learned ordering use the R0 study result.
- Files: `lib/rebalance/balance.ts`, `lib/rebalance/classify.ts`, `lib/rebalance/panel.ts`, `components/today/RebalancePanel.tsx`, `lib/coach/actions/`, `docs/specs/phase-19-day-rebalance.md`.
- Risks and guards: Wait for clinical sign-off on v1 (D6) and the W093 study. Use synthetic or consented accounts only. Add `rebalance_day` via the action registry and `apply.ts` binding.
- Depends on: W093.
- Sources: B026, B057, B239.

### W093 Owner: Phase 19b R0 drift study and first-client consent
P2 / owner / M / owner-only
- Goal: Record consent, then run the aggregate-only drift study.
- Done when:
  - The first client's consent (D7) is recorded in `docs/decisions/` before any read.
  - The five query fixes are applied (consent filter before the common CTE, revision rule, training weekday fallback, Q2 cohort, Q4 clamp).
  - The study runs branch-only, read-only, aggregate-only; the output is saved without account ids.
- Files: `docs/specs/phase-19-day-rebalance.md`, `lib/rebalance/`, `docs/decisions/`.
- Risks and guards: No read of the first client's rows without recorded consent. Never run on production.
- Depends on: none.
- Sources: B238.

### W094 TDEE step F test-suite audit (verify)
P2 / nutrition-engine / M / not owner-only
- Goal: Confirm the named step F test cases exist and add the missing ones.
- Done when:
  - A table maps each step F case (reference personas, derivation properties, adaptive convergence, noise-and-trust, cycle simulations) to a test in `tests/expenditure/` or marks it missing.
  - Missing cases are added; each fails when the engine rule it guards is changed.
  - The plan's status row for step E reads "built" with evidence.
- Files: `tests/expenditure/`, `lib/expenditure.ts`, `lib/expenditure-slope.ts`, `lib/expenditure-cycle.ts`, `docs/plans/2026-09-22-tdee-engine-plan.md`.
- Risks and guards: Tests only; no change to `exp-3.1.0` numbers. Run only `tests/expenditure/`.
- Depends on: W006.
- Sources: B242.

### W095 Duplicate-meal detection end to end
P2 / logging / M / not owner-only
- Goal: Show a "Logged twice?" card with Keep both and Merge, backed by synced duplicate groups.
- Done when:
  - The owner has chosen finish or drop for `origin/wip/2026-10-08-duplicate-card` (unreviewed, stopped mid guard run).
  - A migration adds the `change_log` event for `duplicate_groups` and publishes `duplicate_group_members` in the sync RPC; a DB test shows members reach a second device.
  - A card component reads groups; Keep both and Merge each have a test and one exact Undo.
  - The card follows the v4 meal-card family and DESIGN.md tokens.
- Files: `lib/server/log-duplicates.ts`, `lib/sync/merge.ts`, `lib/sync/client.ts`, new component under `components/today/`, new migration, `docs/readiness/2026-09-15/README.md`.
- Risks and guards: Needs a reviewed production schema migration applied before the code. Fingerprint must ignore deleted entries. Run the guard suite and one Sol review.
- Depends on: none.
- Sources: B008, B065, B083, B235, B273.

### W096 Replay already-consumed plan_days feed rows
P2 / sync / S / not owner-only
- Goal: Project old `plan_days` changes into Today's store once, so older cross-device edits show.
- Done when:
  - A one-time replay reads the account's `plan_days` rows and projects those missing from the local store; a test starts with a store lacking an edit that the feed already consumed.
  - A second run changes nothing.
  - The `lib/migrate` backfill part is closed as moot.
- Files: `lib/sync/plan-days.ts`, `lib/sync/plan-cache.ts`, `lib/sync/post-sync.ts`, `lib/plan-day-client.ts`, `lib/sync/idb.ts`, `tests/sync/`.
- Risks and guards: Do not overwrite a local pending edit or a consumed-recipe snapshot (history epochs, `tests/recipes/consumed-guard-local-db.test.ts`). Run after F05 plan_days merge fixes.
- Depends on: W011.
- Sources: B092.

### W097 W15 onboarding ablation: arm assignment, shell hook, report job
P2 / onboarding / M / not owner-only
- Goal: Assign stable random arms, hook the onboarding shell to the events API and report results.
- Done when:
  - `lib/server/profile-pilot.ts` assigns each account a stable pilot or control arm before first exposure (seeded hash, stored once); `profilePilotEnabled()` is true only for the pilot arm.
  - The onboarding shell sends `pilot_arm_assigned`, `step_*` and `question_*` events through `lib/profile/onboarding-events.ts`.
  - A report job reads `onboarding_events` (service role only) and writes aggregate completion by arm.
  - Tests: arm stability across calls, no free text in any event.
- Files: `lib/server/profile-pilot.ts`, `lib/profile/onboarding-events.ts`, `lib/server/onboarding-events.ts`, `app/api/onboarding/events/route.ts`, `app/api/onboarding/profile-pilot/route.ts`, `components/Onboarding/`, `docs/decisions/2026-10-08-onboarding-events.md`.
- Risks and guards: One question at a time (spec §5). Country is never inferred. Events table has no select policy; keep it so (and W070 moves inserts behind the route).
- Depends on: W062.
- Sources: B137, B212.

### W098 W13 UI: Favored copy, star toggle, Settings world switch, invitation screen
P2 / ui-foods / M / not owner-only
- Goal: Ship the screens for the open-world opt-in. The backend is done.
- Done when:
  - A copy test shows no "Eats" text reaches a person where "Favored" is meant; wire names stay `eats`.
  - The star toggles a Favored mark; a component test covers on, off and Avoid-blocked.
  - Settings has a world switch calling `POST /api/foods/world`; a held account never sees the invitation (`GET /api/foods/world/invitation`).
  - An invitation screen exists for existing accounts; no UI path opens the world without a tap.
- Files: `components/FoodsTabs.tsx`, `components/EatsView.tsx`, `components/MyFoods.favorites.ts`, `components/settings/`, new invitation component, `lib/foods/world-open-client.ts`, `docs/specs/phase-18-open-world-foods.md` (§7.2 W13).
- Risks and guards: No account is open until release (W112). Keep `tests/onboarding/open-food-world.test.ts` and `tests/foods/food-world.test.ts` green. Follow DESIGN.md; no inline style objects.
- Depends on: none.
- Sources: B188, B203.

### W099 Reason chips on generated meals, swap rows and coach composed cards
P2 / ui-foods / S / not owner-only
- Goal: Render the `eaten_often` and `on_list` reasons the engine already emits.
- Done when:
  - Meal cards and swap rows show "You eat this often" and "On your list" chips from `Meal.reasons` and `SwapAlternative.reasons`.
  - The coach composed card and its incomplete-card state show the same chips (confirm or add).
  - Component tests cover each chip and the no-reason case.
- Files: `components/SlotCard.tsx`, `components/MealSwapSheet.tsx`, `lib/today/swap-alternatives.ts`, `components/coach/` (composed card), `lib/meals/plate.ts`.
- Risks and guards: Copy never tells anyone to eat. Chips use `Tag` and role utilities, no hex. A chip does not change a safety verdict.
- Depends on: none.
- Sources: B201, B228.

### W100 Shopping "Use my list" toggle, end date and Undo (W11)
P2 / recipes-shopping / S / not owner-only
- Goal: Add the Shopping UI for the focus routes that already exist.
- Done when:
  - A toggle on Shopping calls `POST /api/shopping/focus`, shows the end date the server returns, and offers Undo through `/api/shopping/focus/undo`.
  - A component test covers on, off, Undo and a superseded Undo.
  - The control is hidden without Shopping access (404 `recipe_pilot_unavailable`).
- Files: `components/ShoppingRoot.tsx`, `lib/shopping/focus-client.ts`, `app/api/shopping/focus/route.ts`, `lib/server/shopping-focus.ts`, `docs/specs/phase-18-open-world-foods.md` (§7.2 W11).
- Risks and guards: Pilot only; follow the recipe pilot gate. Never send a timestamp from the phone.
- Depends on: W024.
- Sources: B202.

### W101 "Not verified / Evidence under review" copy for held allergens; cuisines/country/taste screen completeness (verify)
P2 / ui-foods / S / not owner-only
- Goal: Use one wording for held allergen marks on every surface. Confirm the taste screens are complete.
- Done when:
  - A grep-backed test lists every surface that shows an allergen verdict and checks it uses the shared reason words (`lib/policy/reason-words.ts`).
  - A held (Jev-only) flag shows "Not verified" with "Evidence under review" on Foods, Today, swap and coach cards.
  - Onboarding's optional cuisines screen, the country field and the rule-editor hand-off are checked against §7.2; gaps are fixed or ticketed.
- Files: `lib/policy/reason-words.ts`, `lib/policy/held-allergens.ts`, `components/Onboarding/`, `components/settings/`, `components/coach/TasteChipsCard.tsx`, `docs/specs/phase-18-open-world-foods.md`.
- Risks and guards: Jev is never on the allergy path; copy changes must not imply a Jev verdict clears anything (`tests/policy/facet-escalation-removal.test.ts`).
- Depends on: none.
- Sources: B230, B231.

### W102 Pass food_world into suggestion input so shortage copy knows open vs closed world (D13)
P2 / food-world / S / not owner-only
- Goal: Say "Favored" only to accounts in the open world.
- Done when:
  - The suggestion input carries `foodWorld`; shortage copy for a closed account does not say "Favored".
  - A test covers one closed and one open shortage message.
  - Behavior of ranking is byte-identical (`tests/foods/closed-world-eligible-bodies.test.ts`).
- Files: `lib/coach/suggest.ts`, `lib/meals/plate.ts`, `lib/meals/day.ts`, `lib/foods/layout-plan.ts`, `lib/server/plan-ideas.ts`.
- Risks and guards: v1 and v2 `/api/foods/eligible` bodies must stay byte-identical for closed accounts.
- Depends on: none.
- Sources: B198, B229.

### W103 Taste chips: first-time account 409 and stale TasteChipsCard
P2 / food-world / S / not owner-only
- Goal: Stop chip drops on first onboarding and refresh the card after another device changes chips.
- Done when:
  - A test shows a chip confirm on an account with no settings row yet does not end in `409 settings_not_synced`, and the final plan save keeps the chips (verify the draft-then-reconcile fix first).
  - After a pull that changes `diet_prefs.taste` or `cuisines`, the card re-reads server state, not only local state.
  - Tests cover confirm, Undo on device A, then the card on device B.
- Files: `components/coach/TasteChipsCard.tsx`, `components/Onboarding/`, `lib/profile/taste-confirm-client.ts`, `lib/profile/taste-confirm.ts`, `lib/sync/user-settings.ts`.
- Risks and guards: Keep the receipt rules (Undo removes only keys still held). Chips stay dark until `TASTE_CHIPS_ENABLED`.
- Depends on: none.
- Sources: B225, B195, B226.

### W104 Recover 36 Not-verified Eats foods: diet-label ingredient parser
P2 / food-policy / M / not owner-only
- Goal: Parse ingredient text so reviewed prepared, canned and branded foods can become `allowed` without Jev.
- Done when:
  - New `lib/policy/diet-label.ts` parses ingredient lists with a fixed word list; "vegetable glycerin" and "shortening (palm)" stay unverified.
  - Hard cases are pinned in tests (cut species words, pescatarian, "eggplant", "beef tomato", oyster mushrooms).
  - A read-only script counts foods recovered of the 36; the count is in the PR.
  - A complete label still never clears an animal facet.
- Files: `lib/policy/diet-label.ts` (new), `lib/policy/diet-evidence.ts`, `lib/policy/whole-foods.ts`, `tests/policy/diet-evidence-edges.test.ts`, `tests/policy/diet-rule-jev-removal.test.ts`.
- Risks and guards: Needs its own Sol review. Jev stays off the diet and allergy paths. Unknown wording fails closed to `unverified`.
- Depends on: W014.
- Sources: B190.

### W105 Wire contains_ingredient template facet in profile hard rules; tree-nut allergen key and policy coverage
P2 / food-policy / M / not owner-only
- Goal: Enforce declared `contains_ingredient` rules and give tree nuts a real allergen key.
- Done when:
  - `hard-rules.ts` evaluates `isTemplateFacet` facets from ingredient text; a test shows a declared ingredient blocks a matching food and an unreadable food is `unverified`.
  - A tree-nut key exists in allergens and policy with tags; foods without tags stay unverified.
  - Onboarding copy matches what is protected (no tree-nut claim before coverage exists).
- Files: `lib/policy/profiles/hard-rules.ts`, `lib/policy/allergens.ts`, `lib/policy/diet-evidence.ts`, `lib/catalog/category-map.ts`, `components/Onboarding/`.
- Risks and guards: Fails closed today; keep that for gaps. Catalog tags may need an annotate run (owner step) before the key bites.
- Depends on: W014.
- Sources: B213, B218.

### W106 Dietary profile map: remaining facets and rubrics with calibration, plus third Sol review round
P2 / food-policy / L / not owner-only
- Goal: Finish the remaining profile facets and run the missed review round.
- Done when:
  - The nine rubric fixes to existing facets and the remaining new facets have Jev rubrics, a `RUBRIC_VERSION` bump and labelled calibration sets.
  - Round 3 Sol review runs; R1-01, R1-08, R1-16, R1-17, R1-19, R2-20, R2-21, R2-22 are checked first.
  - No policy decision reads a Jev facet (`tests/policy/facet-escalation-removal.test.ts`).
- Files: `lib/foods/facet-questions.ts`, `lib/foods/facet-vocabulary.ts`, `lib/foods/facet-thresholds.ts`, `lib/server/occasion-facets.ts`, `lib/policy/profiles/`, `docs/audit/`.
- Risks and guards: Jev labels feed only ranking and `unverified` holds. Re-warm facets after a rubric bump (v1 rows are re-warmed, never reinterpreted). Billed eval never runs in CI.
- Depends on: none.
- Sources: B191, B192.

### W107 Real-phone planDay benchmark and snapshot telemetry
P2 / food-world / S / not owner-only
- Goal: Measure planDay on a phone-class CPU and watch snapshot build time and size.
- Done when:
  - A benchmark runs on a real phone or a 4x-throttled browser; p95 for 4 and 6 slots is compared to the 20 ms target and recorded in the spec.
  - Snapshot v3 build p95 (target 500 ms) and byte size are logged by section; bodies over 250 KB are logged.
  - A decision on a Favored soft cap is written from the data.
- Files: `lib/meals/day.ts`, `lib/meals/plate.ts`, `lib/server/meal-snapshot-v3.ts`, `lib/meals/snapshot-v3.ts`, `lib/timing.ts`, `docs/specs/phase-18-open-world-foods.md`.
- Risks and guards: Telemetry holds no food names or account data. Do not change ranking to pass the benchmark without the golden tests.
- Depends on: none.
- Sources: B179, B209, B199.

### W108 Feed pref-2 ranking inputs and run the replay report
P2 / food-world / L / not owner-only
- Goal: Supply the missing inputs to pref-2 and measure ranking lift before open release.
- Done when:
  - Snapshot v3 carries soft-rule `R_f`, W6 `N` and `Q` signals, shopping and pantry signals, eaten non-universe foods, and account-level `M`; pairing weights stay 0 until their evidence exists.
  - A replay report in `docs/evals/` shows lift against the section 5 gates.
  - `tests/meals/ranking-boundary.test.ts` and `pref2-baseline.test.ts` stay green: ranking never changes a verdict.
- Files: `lib/meals/preference.ts`, `lib/meals/snapshot-v3.ts`, `lib/server/meal-snapshot-v3.ts`, `lib/foods/world/taste-inputs.ts`, `lib/server/food-signals.ts`, `lib/foods/pairing/`, `docs/specs/phase-18-open-world-foods.md`.
- Risks and guards: Closed accounts keep byte-identical bodies. No demographic field in any payload. `pref-2` imports nothing beyond `lib/meals/occasion.ts`.
- Depends on: none.
- Sources: B180, B210, B184.

### W109 Owner: label universe plate sheet 1.1.0 and review CUISINE_STAPLES
P2 / owner / M / owner-only
- Goal: Pass Acceptance 7 for the open-world release.
- Done when:
  - `docs/eval/universe-plates/sheet-1.1.0.csv` (new) is regenerated with `scripts/eval/universe-plates-sheet.ts` and marked y/n by the owner.
  - The scorer shows at least 85 percent per cuisine.
  - The owner records a review of `CUISINE_STAPLES` in `lib/meals/data/cuisine.ts`.
- Files: `scripts/eval/universe-plates-sheet.ts`, `lib/meals/data/cuisine.ts`, `docs/eval/` (new), `docs/handoffs/2026-10-08-stopping-point.md`.
- Risks and guards: Sheet 1.0.0 is withdrawn. Labels come from the owner only; no model labeller.
- Depends on: none.
- Sources: B174, B206, B207.

### W110 Owner: universe and cuisine-tier human review, rename decisions, annotate-universe production run
P2 / owner / M / owner-only
- Goal: Record the named human review the open-world gate needs.
- Done when:
  - A named reviewer records review of universe 1.0.0 evidence and cuisine tiers in `docs/decisions/`.
  - The owner answers the rename calls in `docs/catalog/universe.md` lines 109-121.
  - `scripts/annotate-universe.ts --commit --production` runs with a backup and a receipt is stored.
- Files: `docs/catalog/universe.md`, `scripts/annotate-universe.ts`, `lib/foods/universe/`, `docs/decisions/`.
- Risks and guards: The open world must not open before this. Production run follows the owner-step guard and the "migrations first" order.
- Depends on: none.
- Sources: B175, B233.

### W111 Owner: run star-to-favored --production and record it
P2 / owner / S / owner-only
- Goal: Convert stars to Favored marks for existing accounts and record the run.
- Done when:
  - A backup is taken, the dry run is reviewed, then `scripts/star-to-favored.ts --production` runs.
  - A second run makes 0 writes and the receipt is stored.
  - Avoid-marked families are skipped, as in `tests/foods/star-to-favored.test.ts`.
- Files: `scripts/star-to-favored.ts`, `tests/foods/star-to-favored-cli.test.ts`, `docs/decisions/`.
- Risks and guards: Migration `20261227090100` must be live first. The invitation for existing accounts depends on this run.
- Depends on: W029.
- Sources: B189, B204.

### W112 Owner: release open world
P2 / owner / S / owner-only
- Goal: Open the open world to chosen accounts after every gate passes.
- Done when:
  - Gates are recorded as passed: plate labels (W109), universe review (W110), phone benchmark (W107), UI screens (W098), star merge (W111), policy items (W014), W029.
  - Condition-pack wording has clinical sign-off; the first client stays in `OPEN_WORLD_HOLD_USER_IDS`.
  - `OPEN_WORLD_ENABLED`, `OPEN_WORLD_USER_IDS` and `TASTE_CHIPS_ENABLED` are set in stages; each stage has a receipt.
- Files: `lib/foods/world/access.ts`, `lib/server/food-world.ts`, `docs/specs/phase-18-open-world-foods.md` (§12), `docs/readiness/flags.md` (new).
- Risks and guards: Staged roll-out, a few accounts first. Closed bodies stay byte-identical (`tests/foods/closed-world-eligible-bodies.test.ts`). A rollback is unsetting the flags.
- Depends on: W109, W110, W107, W098, W111, W014, W029.
- Sources: B173, B208.

### W113 Owner: occasion-facet calibration holdout review, then facets-occasion-eval --live --freeze
P2 / owner / S / owner-only
- Goal: Let v2 occasion facets reach ranking when they pass Acceptance 9.
- Done when:
  - The owner reviews the holdout.
  - `pnpm exec tsx scripts/eval/facets-occasion-eval.ts --live --freeze` runs (billed to TypeSafe) and writes the constant, or the item records that it stays `null`.
  - Plate plausibility per cuisine meets Acceptance 9 in the report.
- Files: `lib/foods/occasion-calibration.data.ts`, `lib/foods/occasion-gate.ts`, `scripts/eval/facets-occasion-eval.ts`, `lib/meals/facet-affinity.ts`.
- Risks and guards: The owner deprioritized this on 2026-10-08. The eval never runs in CI. Occasion scores never become a penalty.
- Depends on: none.
- Sources: B079, B216.

### W114 Owner: FNDDS inputs production import
P2 / owner / S / owner-only
- Goal: Load the FNDDS recipe inputs so mixed-dish taste expands real ingredients.
- Done when:
  - The owner confirms FNDDS public-domain status.
  - The three `catalog_food_inputs` migrations are applied.
  - A dry run passes every release-chain check, then `scripts/import-fndds-inputs.ts --commit --production --project-ref <ref>` runs.
  - The proof after the last write passes and the receipt is stored.
- Files: `scripts/import-fndds-inputs.ts`, `scripts/priors/fndds-release.ts`, `lib/server/mixed-dish-inputs.ts`, `docs/catalog/import.md`, `docs/catalog/fndds-inputs-sizing.md`.
- Risks and guards: The import is frozen pending the owner. Back up first. Remote target must equal `https://<ref>.supabase.co`. Migrations apply before the code merges.
- Depends on: W003.
- Sources: B010, B178, B215.

### W115 Meal Cards v4 redesign passes 2-4, critiques, Sol review and wiring
P2 / ui-today / L / not owner-only
- Goal: Finish the v4 meal card on `feat/cards-redesign-v4` and merge it.
- Done when:
  - 375x812 screenshots exist for every card state.
  - Gemini and `ui-ux-buddy` critiques are fixed; one Sol review passes.
  - `onSwapNext` is wired in `app/page.tsx`; DESIGN.md card prose is updated; `fix/onb3-plan-today` is merged.
  - Stale `wip/2026-10-08-onb2-*` backup branches are compared with main and deleted.
- Files: `components/SlotCard.tsx`, `components/ui/MealNutritionDivider.tsx`, `app/page.tsx`, `DESIGN.md`, `app/design-tokens.css` (generated, do not hand-edit).
- Risks and guards: Branch is at pass 1 and unreviewed; do not merge as is. The owner dropped the plate line on every card. No colour or type in `style` objects (`tests/design/inline-style.test.ts`). Land after the F18 Today fixes.
- Depends on: W030.
- Sources: B081.

### W116 Island views #470 leftovers (verify)
P2 / ui-today / S / not owner-only
- Goal: Fix the Sol FAIL items left on the Day card widget and confirm widget memory.
- Done when:
  - `lib/today/rebalance-widget.ts` no longer sets `expanded: true` on `justNudged` (line 65); a test shows a nudge does not expand the widget.
  - Blocked storage does not reset prefs; pager dots clear 44 px targets; the edit tray keeps focus.
  - Widget memory matches spec D3: opens on rebalance when tone is nudge, else on the last panel.
  - Throwaway branches `proto/wet-island` and `fix/well-open-glare` are deleted after the owner agrees.
- Files: `lib/today/rebalance-widget.ts`, `components/today/LiveWidget.tsx`, `components/today/LiveWidgetPanels.tsx`, `components/today/WidgetEditTray.tsx`, `components/today/island/`.
- Risks and guards: Storage reads wrap in try/catch. Touch targets 44 px or more. Springs from `lib/design/motion.ts` only.
- Depends on: W030.
- Sources: B088, B240.

### W117 Widget-save failure notice
P2 / ui-today / S / not owner-only
- Goal: Tell the person when a widget layout does not save.
- Done when:
  - `saveWidgetPrefs` reports failure through `writeAccountItem`; `LiveWidget.tsx` shows "Couldn't save layout" and keeps the unsaved choice on screen.
  - A component test forces a failed write and sees the notice.
  - The concurrent sign-up load test (#22) is ticketed separately.
- Files: `components/today/LiveWidget.tsx` (line ~162), `components/today/WidgetEditTray.tsx`, `lib/store.ts`, `lib/sync/idb.ts`.
- Risks and guards: Use the existing notice component; no new colour tokens.
- Depends on: none.
- Sources: B080, B280.

### W118 Service-worker waiting-worker race
P2 / ui-pwa / S / not owner-only
- Goal: Keep a superseding waiting worker reloadable.
- Done when:
  - A test shows a second waiting worker replaces the first and the Reload button still activates the newest one.
  - If not reproducible, the deferral is documented with the test.
- Files: `public/sw.js`, `components/SyncBootstrap.tsx`, `tests/pwa/` (new if absent).
- Risks and guards: A bad worker change can strand users on stale code; test with an update cycle on a preview build.
- Depends on: none.
- Sources: B223.

### W119 Idle-loop CPU profiling for pond and water scenes
P2 / ui-today / S / not owner-only
- Goal: Stop the animation loop when the scene is calm, and measure the CPU saved.
- Done when:
  - `components/today/island/WellWater.tsx` stops `requestAnimationFrame` when settled and restarts on input.
  - A CPU profile on a low-end phone profile (4x throttle) before and after is in the PR; pond CSS loops are profiled.
  - Reduced-motion users get no loop.
- Files: `components/today/island/WellWater.tsx`, `components/today/WaterLiquid.tsx`, `components/today/scene/`, `components/today/useWaterTilt.ts`.
- Risks and guards: Motion values come from `lib/design/motion.ts`. Verify Sprout mood stays correct.
- Depends on: none.
- Sources: B269.

### W120 Small UI fixes: scan-unavailable notice, sex picker "unspecified", Coach change card on token-less devices (verify)
P2 / ui-settings / S / not owner-only
- Goal: Close three small visible gaps.
- Done when:
  - "Scanning isn't available yet" shows from the coach screen when coach is off (`/coach?open=scan`); test covers coach off and scan off.
  - `BodyProfileFields` has an "unspecified" option; a saved "Prefer not to say" shows it, not "Choose".
  - A component test (U1), fed by real `listUndos` output, shows the generic "Coach change" card on a device with no token.
- Files: `components/CoachChat.tsx`, `app/coach/CoachScreen.tsx`, `components/BodyProfileFields.tsx`, `components/coach/server-card.ts`, `components/coach/use-coach-undo.ts`.
- Risks and guards: Sex is read only for the stored cohort and BMR; "unspecified" must keep the existing derivation fallback.
- Depends on: none.
- Sources: B054, B258, B107.

### W121 Authenticated-browser verification re-baseline
P2 / docs-tests / M / not owner-only
- Goal: Replace unverified release claims with current evidence.
- Done when:
  - The 69 pending rows in `docs/readiness/2026-09-15/inventory.md` are marked verified, covered by a named test, or obsolete (ramp rows).
  - The c11 end-to-end walk-through (sign-up to c9) has screenshots in the repo.
  - The 390 px clean-storage sweep shows zero console errors; `/api/health/daily` 503 is no longer probed on Settings (`lib/health/capability.ts`).
  - The 2026-10-04 UI pass evidence is stored or its location is noted.
- Files: `docs/readiness/2026-09-15/inventory.md`, `docs/readiness/2026-09-15/remaining-ui.md`, `lib/health/capability.ts`, `docs/plans/2026-10-04-ui-pass.md`.
- Risks and guards: Loop 010 rulings are owner-only. Use local stack or branch DB, test accounts only.
- Depends on: none.
- Sources: B156, B282, B086, B272, B271.

### W122 Owner: production-readiness steps
P2 / owner / S / owner-only
- Goal: Collect the readiness evidence only the owner can produce.
- Done when:
  - The next Vercel cron runs show 2xx for every cron route.
  - Signed-in phone checks pass (needs Sasha's magic link).
  - A Lighthouse run is stored; 15 security WARNs and 37 performance INFOs from the Supabase advisor are triaged.
- Files: `docs/readiness/2026-09-19/README.md`, `docs/readiness/2026-09-15/README.md`, `vercel.json`.
- Risks and guards: Sign-in uses ZS Vault Fill, never 1Password. No credentials in logs.
- Depends on: none.
- Sources: B147, B152.

### W123 Save, re-use, swap (T5): Log again, "You logged this before", Recent meals swap row
P2 / logging / M / not owner-only
- Goal: Let people log a past meal again in one tap.
- Done when:
  - Past entries show Log again; it creates a new entry with a new id and today's clock.
  - Duplicate fingerprints raise "You logged this before" on capture review.
  - The swap sheet has a Recent meals row; a `logged:<id>` meal id kind resolves in `resolveDay`.
  - Logging still marks, never refuses; rule marks apply to old foods under current rules.
- Files: `components/LogFoodSheet.tsx`, `components/MealSwapSheet.tsx`, `lib/today/swap-alternatives.ts`, `lib/log-commit-client.ts`, `lib/resolve.ts`, `lib/server/log-duplicates.ts`.
- Risks and guards: Respect the logging-marks ruling (2026-09-14). Keep account-scoped IDs; no history leaks across accounts.
- Depends on: none.
- Sources: B004.

### W124 Label scan T3: dedupe repeat scans, 10-label eval, latency targets, scanned food star
P2 / capture-catalog / M / not owner-only
- Goal: Reuse a scanned food instead of creating a row on each scan.
- Done when:
  - `lib/server/log-label-food.ts` matches brand, name and per-100 g and reuses the row; a test scans the same label twice and sees 1 `user_foods` row.
  - A 10-real-label eval is stored; p95 is 5 s or less and a cached rescan 1.5 s or less (`pnpm timings`).
  - The scanned food has a star; the barcode row on the production FAB follows `NEXT_PUBLIC_FEATURE_SCAN`.
- Files: `lib/server/log-label-food.ts`, `lib/capture/propose.ts`, `components/ScanConfirmSheet.tsx`, `components/BarcodeScanSheet.tsx`, `docs/plans/2026-09-17-fab-coach-program.md`.
- Risks and guards: Match must not merge two foods with different nutrition; compare per-100 g. Do this after F11 label-save fixes.
- Depends on: W017.
- Sources: B002, B003.

### W125 Plate photo T2: candidate-aware grounding, per-method gate, thumbnail, EXIF time, editable name, Save-as-recipe
P2 / capture-catalog / L / not owner-only
- Goal: Improve plate-photo accuracy and the confirm sheet.
- Done when:
  - Grounding lets the model choose among top-K catalog candidates; a measured per-method auto-resolve gate replaces 0.95 (owner rules on the number).
  - A 512 px thumbnail links to the entry, shows on Today and the entry sheet, and is deleted with the entry and by export-delete.
  - The photo logs at its EXIF `DateTimeOriginal`, read before resize; the meal name is editable; Save-as-recipe is a toggle.
- Files: `lib/capture/grounding.ts`, `lib/capture/propose.ts`, `components/PhotoCapture.tsx`, `components/CaptureConfirm.tsx`, `lib/media/strip-metadata.ts`, `app/api/jobs/media-sweep/route.ts`, `docs/plans/2026-09-17-fab-coach-program.md`.
- Risks and guards: EXIF time is read client-side, the upload still strips EXIF. The thumbnail needs the F20 media path rules first. Eval bills real keys.
- Depends on: W019, W013.
- Sources: B001, B018.

### W126 Phase 11: re-audit shipped conversation triggers and RPCs against round-13 spec (verify)
P2 / coach-ai / S / not owner-only
- Goal: Check migration `20261126090000` against the round-13 spec.
- Done when:
  - A table lists each spec trigger and RPC, and the matching shipped object or a gap.
  - Gaps are fixed or ticketed; one independent (Sol) review is attached.
  - The spec status line says "audited" with the date.
- Files: `docs/specs/phase-11-conversations-memory.md`, `supabase/migrations/20261126090000_*.sql`, `lib/server/coach-threads.ts`, `tests/migrations/`.
- Risks and guards: Read only unless a gap is found; any fix is a new migration.
- Depends on: none.
- Sources: B129.

### W127 Docs reconciliation
P2 / docs-tests / S / not owner-only
- Goal: Remove stale statements that mislead agents.
- Done when:
  - The AGENTS.md phase table has rows for phases 2-7 descriptions and phases 9-19 with landed, dark or unbuilt status from `docs/specs/phase-*.md`.
  - These rows are fixed: `universeRefs` is wired in `lib/server/compose-pool-ports.ts`; the pet row (care_* migrations exist); Phase 19 header (`lib/rebalance` exists); the handoff lists `20261229090000` as applied 2026-10-09.
  - `docs/specs/onboarding-as-built.md` ~line 61 says #36/#37/#39 merged; `docs/specs/phase-4-ai-capture.md:273` says DESIGN.md.
  - Phase 0/7/11 notes, readiness counts, and the old-log immutability test reference are fixed or cited.
- Files: `AGENTS.md`, `docs/specs/onboarding-as-built.md`, `docs/specs/phase-4-ai-capture.md`, `docs/specs/phase-0-foundations.md`, `docs/specs/phase-7-coach.md`, `docs/readiness/2026-09-15/README.md`, `docs/handoffs/2026-10-08-stopping-point.md`.
- Risks and guards: Doc only. `next dev` rewrites the Next.js block in AGENTS.md; commit it with the change. Keep the AGENTS.md row text exact where tests grep it.
- Depends on: none.
- Sources: B171, B279, B248, B011, B143, B132, B133, B161.

### W128 Owner: delete persistent Supabase branch p1-catalog
P2 / owner / S / owner-only
- Goal: Stop the cost of an unused preview branch (about $0.31 a day).
- Done when:
  - The branch still exists (checked with `supabase branches list`).
  - `supabase branches update p1-catalog --persistent=false` and `scripts/db-branch.sh destroy p1-catalog` have run.
  - The Dependabot majors (TypeScript 6, `@types/node` 26, motion 14) are reopened as separate PRs or declined.
- Files: `scripts/db-branch.sh`, `package.json`, `docs/decisions/2026-09-19-sol-rulings.md`.
- Risks and guards: Deleting a branch destroys its data; confirm nothing needs it. Destructive step is the owner's.
- Depends on: none.
- Sources: B151, B140.


## P3 specs

### W129 Coach Undo receipts for remaining action kinds and parked feat/undo-followups cleanup
Priority P3 / lane coach-ai / size M / owner-only: no
- Goal: Move the other coach action kinds from phone-only Undo to receipt Undo. Clean up the parked `feat/undo-followups` branch.
- Done when:
  - Each added kind (slot items, moves, deletes, water, weight, profile, targets, shopping, skip/restore, list marks) has a receipt card in `lib/coach/undo-receipt-card.ts` and `record_mode = 'receipt_v1'`.
  - Each moved kind sets `serverUndoable: true` and has a database test like `tests/migrations/coach-undo-sql.test.ts`.
  - `CoachActionSource` plumbing stays. `food_ideas.tsx` and `CoachShell.tsx` pass block and source into `applyAction`. `20261211090200_coach_undo_block_source.sql` is never applied.
  - `coach-undo-display.ts` is dropped. The undo-list harness cases are rewritten for receipts.
- Files: `docs/specs/coach-undo-receipt.md` (section 9), `lib/coach/undo-receipt-card.ts`, `lib/coach/undo-client.ts`, `lib/coach/actions/apply.ts`, `lib/server/coach-undo.ts`, `components/coach/CoachShell.tsx`.
- Risks and guards: Migrations apply to production before the code merges. A `receipt_v1` record is undone from its receipt only; the two legacy closing endpoints refuse it with 409. Golden files in `tests/coach/action-golden/` must not change.
- Depends on: W086 (PR B writer, `apply_coach_op`).
- Sources: B056, B127, B039.

### W130 Owner: label 432 pairing holdout pairs, then jev-labels and calibrate with W8 replay-lift record
Priority P3 / lane owner / size M / owner-only: yes
- Goal: Create the human holdout that unlocks non-curated pairing weights. Curated scores stay in force until then.
- Done when:
  - `docs/pairing/holdout-pairs.csv` holds at least 400 owner labels, at least 25 per cuisine.
  - `scripts/pairing/jev-labels.ts --items holdout` and `scripts/pairing/calibrate.ts` run. The report meets the section 5 numbers.
  - A W8 replay-lift record is in the manifest `activation`. Only then may a co/jev/comp weight go above 0.
- Files: `docs/pairing/holdout-pairs.csv`, `scripts/pairing/jev-labels.ts`, `scripts/pairing/calibrate.ts`, `scripts/pairing/build.ts`, `lib/foods/pairing/gate.ts`.
- Risks and guards: A model labeller is refused; labels come from Devin only. `tests/foods/pairing-activation.test.ts` and `pairing-calibration.test.ts` must stay green. jev-labels bills TypeSafe and never runs in CI.
- Depends on: none.
- Sources: B177, B217.

### W131 Architecture refresh for phases 9-19 in docs/architecture.md (fill or remove empty 2026-10-10 directory)
Priority P3 / lane docs-tests / size M / owner-only: no
- Goal: Bring `docs/architecture.md` from v2.1 to the current system. Resolve the empty `docs/architecture/2026-10-10` directory.
- Done when:
  - `docs/architecture.md` covers phases 9-19: tenancy, sync, coach, open-world foods, jobs, AI call layer.
  - The empty directory is either filled or removed.
  - Every file path named in the new text exists (checked with a script).
- Files: `docs/architecture.md`, `docs/architecture/2026-10-10/`, `docs/features.md`, `docs/specs/`.
- Risks and guards: Docs only. Do not copy AGENTS.md rows verbatim; link them.
- Depends on: none.
- Sources: B287.

### W132 Repo hygiene: delete landed and backup wip branches (week-entry-scan, onb2-*, proto/wet-island, fix/well-open-glare) after diffing
Priority P3 / lane docs-tests / size S / owner-only: no
- Goal: Remove stale remote branches that are landed or empty. Keep any branch with unique work.
- Done when:
  - Each branch is diffed against `origin/main`. The result is recorded in the PR or a note.
  - Empty or squash-merged branches are deleted: `wip/2026-10-08-week-entry-scan-notice`, `fix/week-entry-scan-notice`, `wip/2026-10-08-onb2-p0-{chat,save,ui}`, `onb2-voice`.
  - `proto/wet-island` and `fix/well-open-glare` are checked first; they were not found locally.
  - Branches with unique work get a one-line retire or revive decision.
- Files: none (git remote branches). Context: `docs/handoffs/2026-10-08-stopping-point.md`.
- Risks and guards: Check `git status` of any worktree that uses a branch. Do not delete `wip/2026-10-08-down-migrations` (see W134). The onb2 flow sits behind `NEXT_PUBLIC_CHAT_ONBOARDING` (off in production).
- Depends on: none.
- Sources: B017, B274, B167.

### W133 Reopen dependency majors as separate PRs: TypeScript 6, motion 14, npm minor group; keep Node 22 types
Priority P3 / lane docs-tests / size M / owner-only: no
- Goal: Land each parked major as its own PR. Keep the Node 22 runtime and its types.
- Done when:
  - Separate PRs for the npm minor/patch group, `motion` 13.5 to 14, and `typescript` 5 to 6.
  - Each PR passes `pnpm lint`, a type check, `pnpm test` and `pnpm build`.
  - `@types/node` stays on the Node 22 line (`package.json` now has `^20`; decide and record). The Node 26 types stay deferred.
  - Dependabot branches for MCP sdk, sharp and source-map-js are handled the same way.
- Files: `package.json`, `pnpm-lock.yaml`, `lib/design/motion.ts`, `tsconfig.json`.
- Risks and guards: Motion springs in `lib/design/motion.ts` need a visual check (`DayCard.motion.test.tsx`). Batch to limit CI minutes; keep PRs in draft until ready. Rulings: `docs/decisions/2026-09-12-wave4-rulings.md`, `2026-09-19-sol-rulings.md`.
- Depends on: none.
- Sources: B140, B148, B160.

### W134 Redesign down migrations so they preserve data
Priority P3 / lane server-db / size M / owner-only: no
- Goal: Write down migrations that do not delete user data. Replace the blocked drafts.
- Done when:
  - Down files exist in `supabase/migrations/down/` for `20261023092000`, `20261126090000`, `20261210090100`.
  - Each down keeps plan threads, transcripts and timings, and allows role-only writes.
  - A throwaway Postgres test applies up, adds rows, applies down and checks that no row is lost.
  - A second-model review passes.
- Files: `supabase/migrations/down/`, `supabase/migrations/20261023092000*`, `20261126090000*`, `20261210090100*`; draft: `origin/wip/2026-10-08-down-migrations`.
- Risks and guards: Never run a down against production. Do not merge the wip branch as is (Sol BLOCK).
- Depends on: none.
- Sources: B131, B165.

### W135 W14 Taste T2: taste_models migration, trainer, leakage-free replay and report (data-gated: 60 days of W6 signals)
Priority P3 / lane food-world / size L / owner-only: no
- Goal: Learn per-account taste weights from `food_signal_events`. Start only when enough data exists.
- Done when:
  - Migration 8 adds `taste_models` (owner-scoped RLS).
  - A trainer and a leakage-free replay run. The report goes to `docs/evals/`.
  - The per-account gate is met: about 60 days of W6 signals. Without it, ranking stays on `pref-2`.
  - `tests/meals/ranking-boundary.test.ts` stays green: no safety verdict moves.
- Files: `lib/meals/preference.ts`, `lib/foods/signals.ts`, `lib/server/food-signals.ts`, `docs/specs/phase-18-open-world-foods.md` (W14).
- Risks and guards: Ranking never changes a safety verdict (W7 guard). No demographic field in features. Apply the migration before the code merges.
- Depends on: W108.
- Sources: B182, B211.

### W136 Jev short-list veto: adjudicate 60 vetoes for the live gate (stays shadow until then)
Priority P3 / lane food-world / size M / owner-only: no
- Goal: Collect the evidence needed to take the Jev veto out of shadow mode.
- Done when:
  - At least 60 vetoes are adjudicated by a human, with 95 percent precision (90 percent lower bound).
  - Timeouts are 5 percent or less. Added p95 latency is 1.5 s or less. A report is written.
  - Only after that, `suggest-rank.ts` stops running in shadow.
- Files: `lib/coach/suggest-rank.ts`, `lib/coach/suggest.ts`, `lib/ai/call-registry.ts`.
- Risks and guards: Jev never replaces a policy verdict. A Jev error or timeout keeps formula order (`JEV_DEADLINE_MS`). Telemetry holds no food names.
- Depends on: none.
- Sources: B181.

### W137 Open-world date change uses stale v3 set for ~300 ms before rules-version recheck
Priority P3 / lane food-world / size S / owner-only: no
- Goal: Close the short window where a date change builds meals from an in-memory v3 set before the rules-version check.
- Done when:
  - On a date change, the phone checks `GET /api/foods/rules-version` first, or marks the meals provisional until it returns.
  - A test in `tests/foods/open-world-freshness.test.ts` shows a removed account or a moved token never yields a stale-set meal.
- Files: `app/page.tsx` (near line 229), `lib/foods/eligible-client.ts`, `tests/foods/open-world-freshness.test.ts`.
- Risks and guards: Open world is dark (`OPEN_WORLD_ENABLED`), so risk is low. Closed accounts keep byte-identical bodies (`tests/foods/closed-world-eligible-bodies.test.ts`). Do not add a blocking wait on Today.
- Depends on: none.
- Sources: B196, B227.

### W138 Meal-planning follow-ups t20 (O4 gaps) and t22 (O3 gate prerequisites); facet warming in coach grounding and log commit (verify)
Priority P3 / lane food-world / size M / owner-only: no
- Goal: Finish the open ranking follow-ups. Check whether cached facets reach coach grounding and `/api/log/commit`.
- Done when:
  - t20 and t22 are each done or closed with a note in `docs/plans/`.
  - A check shows whether coach grounding and log commit read cached facets. If not, add the read or record why not.
  - Calibration stays `null` (abstain) until Acceptance 9 passes.
- Files: `lib/foods/occasion-gate.ts`, `lib/foods/occasion-calibration.data.ts`, `lib/server/occasion-facets.ts`, `lib/meals/facet-affinity.ts`, `lib/server/log-occasion.ts`.
- Risks and guards: Facets are scores only. Jev stays off the allergy, diet and religion paths (`tests/policy/facet-escalation-removal.test.ts`, `diet-rule-jev-removal.test.ts`). Universe WARNs (tahini, coconut milk) belong to the allergen item.
- Depends on: none.
- Sources: B197, B219.

### W139 Capture and UI minors: CaptureSheet lane-L items, Undo behind standing error, 12-meal text cap, swapped alternative verdict lookup, N+1 lookups (verify)
Priority P3 / lane capture-catalog / size S / owner-only: no
- Goal: Re-check each minor against current code. Fix the ones still real.
- Done when:
  - Each item is marked fixed, still open, or dropped, with evidence. Items: empty draft "0 of 0 today" subtitle, `propose()` parsing a 200 body outside try, ignored `saveDraft` return, no state reset when `open` flips, `CaptureGlyph` in the Today bundle.
  - A success queued behind a standing error shows its Undo. A text capture over 12 meals says so.
  - A swapped alternative looks up its verdict by `food_ref_id`.
  - The per-item catalog lookups are confirmed concurrent, or fixed.
- Files: `components/CaptureSheet.tsx`, `lib/capture.ts`, `lib/server/catalog.ts`, `app/api/log/propose`.
- Risks and guards: Commit-time policy still blocks unsafe items, so this is UX only. Logging marks and never refuses. Keep the route parameter small and owner-scoped.
- Depends on: none.
- Sources: B067, B076, B194, B012.

### W140 Coach small items: tool-schema .positive() and NOUS_* names, chart-claim verifier rule, abort transcribe on page hide, weekday-series per-date titles (verify)
Priority P3 / lane coach-ai / size S / owner-only: no
- Goal: Close four small coach defects, after checking each is still real.
- Done when:
  - `.positive()` in `lib/coach/registry.ts` (near line 167) is replaced or covered by a keyword allowlist test against the SDK Schema type. Stale `NOUS_*` names are removed from docs.
  - `lib/coach/verify.ts` flags a reply that claims a chart or breakdown with no block. A test covers it.
  - `HoldController` aborts an in-flight transcription on `pagehide`/`visibilitychange`. A test covers it.
  - Per-date titles persist for weekday-series plans, or the item is closed as not needed.
- Files: `lib/coach/registry.ts`, `lib/coach/verify.ts`, `lib/coach/hold.ts`, `lib/coach/actions/set-slot-meal.ts`.
- Risks and guards: `tests/coach/action-golden/` pins the provider schema byte for byte; a schema change needs a golden update with review. Do not change the model-reachable route set.
- Depends on: none.
- Sources: B068, B073, B062, B075.

### W141 Slot editing Phase C (build from any items, verify) and Phase D "Make this my usual"
Priority P3 / lane ui-today / size M / owner-only: no
- Goal: Decide Phase C. Build Phase D: save an edited meal as a recipe and offer it as a swap for that slot.
- Done when:
  - Phase C is confirmed wanted (build) or closed; `BuildMealSheet` is gone and "Log a meal" exists.
  - A "Make this my usual" control saves the meal and shows it in `MealSwapSheet` for that slot.
  - Tests cover the save, the swap row and Undo. The saved meal still passes the account's current rules.
- Files: `components/SlotCard.tsx`, `components/MealSwapSheet.tsx`, `lib/today/swap-alternatives.ts`, `lib/favorite-meals-client.ts`, `docs/plans/2026-09-14-slot-item-editing*`.
- Risks and guards: Reuse the favorite-meal path (`favoritesTx`) rather than a new store. Recipes with off-plan items stay refused (R6). No new colour or inline style (`tests/design/inline-style.test.ts`).
- Depends on: W123.
- Sources: B084, B085.

### W142 Jev day_completeness nudge before "Day fully logged"
Priority P3 / lane coach-ai / size S / owner-only: no
- Goal: Show a gentle check before the user marks a day fully logged. Use a typed Jev judgement.
- Done when:
  - A `day_completeness` purpose is in `lib/ai/call-registry.ts` with a typed payload builder and a 0.80 threshold.
  - `DayCompleteControl` shows the nudge only above threshold. A Jev error shows nothing and never blocks the mark.
  - The payload holds no free text, name or health field. A test in `tests/ai/` checks it.
- Files: `lib/ai/call-registry.ts`, `lib/ai/payloads.ts`, `components/today/DayCompleteControl.tsx`, `docs/plans/2026-10-04-jev-opportunities.md` (section 2).
- Risks and guards: Copy never tells anyone to eat. The mark rules stay as in ruling R3 (`day_marks_started_on` only moves earlier). `callModel` spend reservation applies. The `far_from_seed` ranking and "why did my TDEE change?" intent stay out of scope.
- Depends on: none.
- Sources: B027.

### W143 Deferred coach ideas: Phase 12 Later capabilities, account memory, Jev swap/bridge, gut-log correlation, multi-day plans, recall_conversations (verify)
Priority P3 / lane coach-ai / size XL / owner-only: no
- Goal: Keep one idea list. Re-spec any item before a build starts. Do not build from this item.
- Done when:
  - One doc lists each idea with a status (not built, partial, dropped) and a revisit condition. Cover: web research, calendar tools, `edit_entry`/`edit_recipe`, 4-week plan, plateau, carb timing, `coach_memories`, Jev swap/bridge, gut-log correlation, multi-day plans, `recall_conversations`.
  - Each kept idea names its first spec file under `docs/specs/`.
- Files: `docs/specs/phase-12-coach-tools.md`, `docs/specs/phase-11-conversations-memory.md`, `docs/research/2026-09-23-dietary-profile-map.md`, `docs/plans/2026-09-19-chat-first.md`.
- Risks and guards: Memory and recall need independent retrieval checks and "historical, not current" wording. Data minimisation applies to any new AI payload.
- Depends on: none.
- Sources: B031, B034, B035, B036, B037, B128.

### W144 Deferred integrations: native shell, Garmin, Health Connect, Withings, web push and out-of-app notifications, ChatGPT connector
Priority P3 / lane health / size XL / owner-only: no
- Goal: Record revisit conditions for the parked integrations. Build none now.
- Done when:
  - `docs/features.md` (F-109 to F-116) states each item's revisit condition and owner call.
  - A short note says what push needs first: `public/sw.js` has no push handler and no sender exists.
- Files: `docs/features.md`, `public/sw.js`, `app/api/mcp/route.ts`.
- Risks and guards: New vendors or paid services need Devin's approval. Push and ChatGPT connector need privacy review of what leaves the app.
- Depends on: none.
- Sources: B063, B283, B286.

### W145 Sprout and companions: stored state (streaks, growth), shop wearables and per-companion art
Priority P3 / lane ui-today / size L / owner-only: no
- Goal: Plan stored companion state, wearables and art. Reuse the care points and shop tables where they fit.
- Done when:
  - A spec states the stored fields, the sync path, and non-shaming copy rules; Devin rules on the copy.
  - A migration widens `care_items.mascots` (default is `array['sprout']`) for Blu, Button and Pod.
  - Per-companion pond, water and outfit art exists. Art waits for Higgsfield credits after Oct 29.
- Files: `lib/today/pet-mood.ts`, `components/today/island/`, `components/today/care/`, `supabase/migrations/20261225090200_care_shop.sql`, `public/pet/`.
- Risks and guards: Mood stays computed from the viewed day; copy never tells anyone to eat. Check overlap with F26 (care ledger) first. Apply the migration before the code merges.
- Depends on: F26 (care ledger fixes).
- Sources: B265, B266, B267.

### W146 Quarterly catalog refresh job (F-107) and build-time unpaid Gemini-key gate (F-120)
Priority P3 / lane server-ops / size S / owner-only: no
- Goal: Schedule the catalog refresh. Fail the build when the Gemini key has no billing.
- Done when:
  - A quarterly job or a documented command re-imports Foundation, SR Legacy and FNDDS through `scripts/import-fdc.py`, branch first, with a sizing sign-off.
  - `pnpm ai:canary` (or a light variant) runs in CI or build and fails on an unbilled key.
  - Both steps are in `docs/catalog/import.md`.
- Files: `scripts/import-fdc.py`, `scripts/ai-canary.ts`, `package.json`, `.github/workflows/ci.yml`, `docs/catalog/import.md`.
- Risks and guards: Production import is the owner's step and stays so. The canary bills Gemini; keep it out of per-push CI. Never run it with a key that is off the billing lane.
- Depends on: none.
- Sources: B145, B146.

### W147 Act on the weekly model-freshness issue (lane-bench PR if a pin should change)
Priority P3 / lane coach-ai / size S / owner-only: no
- Goal: Read the open freshness issue. Open a lane-bench PR if a pin should change.
- Done when:
  - The issue state is read and noted.
  - If a pin changes, the PR edits `lib/ai/lanes.ts` only and attaches the `lane-bench.ts` report.
  - Otherwise the issue gets a closing comment.
- Files: `.github/workflows/model-freshness.yml`, `lib/ai/lanes.ts`, `scripts/eval/lane-bench.ts`.
- Risks and guards: No model id is read from env. The bench bills real keys and never runs in CI. `tests/ai/call-registry.test.ts` must stay green.
- Depends on: none.
- Sources: B170.

### W148 Truly remove an "Other foods" row (new stored state)
Priority P3 / lane ui-foods / size S / owner-only: no
- Goal: Let a user remove a neutral food row from the Other list for good.
- Done when:
  - A stored hidden/removed state exists, with a sync op and a migration.
  - A swipe removes the row; Undo restores it. A test covers both.
  - Avoid and Favored marks are not changed by a removal.
- Files: `components/MyFoods.tsx`, `components/MyFoods.list.tsx`, `lib/foods/prefs-client.ts`, `lib/foods/normalize.ts`.
- Risks and guards: Nothing is deleted; only hidden. `set_food_membership` stays unchanged. Needs Devin's ruling because it was ruled out of scope. Apply the migration first.
- Depends on: none.
- Sources: B016.

### W149 Split tests/search/recall.test.ts under the 400-line soft limit
Priority P3 / lane docs-tests / size S / owner-only: no
- Goal: Split the 473-line test file into files under 400 lines.
- Done when:
  - `tests/search/recall.test.ts` is split by topic. Test count and names are unchanged.
  - `pnpm test tests/search` passes. No file is over 400 lines.
- Files: `tests/search/recall.test.ts`.
- Risks and guards: The plan mandated a single file (ruling 7, 2026-09-12). Record the new ruling in the PR. Keep shared setup in one helper.
- Depends on: none.
- Sources: B013.

### W150 Onboarding Phase 10 Later gaps: offline turns, draft expiry, thread delete, Add-from-onboarding; G10-G12 clinician numbers and rounding (verify against onb3)
Priority P3 / lane onboarding / size M / owner-only: no
- Goal: Check each gap against the current onboarding. Close the ones onb3 covers. Spec the rest.
- Done when:
  - Each of: offline turns, draft expiry, user delete of the onboarding thread, Avoid-aware Add-from-onboarding, G10, G11, G12 is marked done, open or dropped, with evidence.
  - Open items get a short spec or a follow-up item.
- Files: `components/Onboarding/ConversationalOnboarding.tsx`, `docs/specs/phase-10-conversational-onboarding.md`, `lib/profile/onboarding-client.ts`, `lib/profile/rate-eligibility.ts`.
- Risks and guards: Pace holds, adult-only and tuna-check rules in AGENTS.md stay. The chat flow is behind `NEXT_PUBLIC_CHAT_ONBOARDING` (off). Clinician numbers must not override a hold.
- Depends on: none.
- Sources: B041, B254.

### W151 Phase 9 per-user day templates: keep as spec-only Later (no build)
Priority P3 / lane docs-tests / size S / owner-only: no
- Goal: Mark per-user day templates as spec-only. Make sure no other spec assumes them.
- Done when:
  - `docs/specs/phase-9-tenancy-blank-slate.md` says "Later, not built, needs a product decision".
  - A search finds no spec or code that assumes `day_templates`, `template_slots` or `replace_day_template`.
- Files: `docs/specs/phase-9-tenancy-blank-slate.md`, `docs/plans/2026-09-22-phase-9-tenancy/README.md`.
- Risks and guards: Docs only. Account layouts keep generating `Meal 1` to `Meal N`.
- Depends on: none.
- Sources: B104.

### W152 FluidVoice UI recovery acceptance ledger at 320/390/430/1024 (verify)
Priority P3 / lane docs-tests / size S / owner-only: no
- Goal: Write the acceptance ledger. Separate production proof from source-only proof.
- Done when:
  - Screenshots exist at 320, 390, 430 and 1024 px for the pages in the recovery spec.
  - The ledger lists each criterion as "production proof" or "source only".
  - Stale branches and worktrees from this work are listed for W132.
- Files: `docs/specs/2026-09-28-fluidvoice-ui-recovery.md`, `components/CoachMic.tsx`, `components/DictateMic.tsx`.
- Risks and guards: Voice is retired for Gemini Live; check only the live mic paths. A signed-in production walkthrough needs a pilot account and Devin's sign-in through ZS Vault Fill.
- Depends on: none.
- Sources: B043.

### W153 Four selectable background themes
Priority P3 / lane ui-today / size M / owner-only: no
- Goal: Let a user pick one of four backgrounds. Change token values only.
- Done when:
  - Four theme token sets exist; a Settings control switches them and the choice persists per account.
  - `lib/design/theme-color.ts` follows the theme.
  - Lint with Google Design MD CLI 0.3.0 passes. `tests/design/inline-style.test.ts` stays green. A 390 px check shows no contrast failure.
- Files: `DESIGN.md`, `app/design-tokens.css` (regenerate, never hand-edit), `app/globals.css`, `lib/design/theme-color.ts`, `components/settings/`.
- Risks and guards: Components never name a colour. Matte charcoal on the meal card and dock stays reserved. Keep legacy token names. Devin picks the four looks.
- Depends on: none.
- Sources: B270.

### W154 Owner housekeeping: confirm Vercel billing card, rename provisional ZS Vault entry, supply board videos and nutritionist tips
Priority P3 / lane owner / size S / owner-only: yes
- Goal: Devin closes three small items that no agent can do.
- Done when:
  - Devin confirms the Vercel Pro payment method is current.
  - Devin names the service of the 60-character credential; the vault entry is renamed from its provisional id.
  - Devin supplies the board explainer videos and nutritionist-authored coach tips. The paths in `ExplainerPlayer` and `TipTile` show real content.
- Files: `components/today/ExplainerPlayer.tsx`, `components/today/TipTile.tsx`, `docs/decisions/2026-10-01-liquid-day-card-rulings.md`.
- Risks and guards: Agents never change billing. Agents never read the credential value; the owner confirms the service only.
- Depends on: none.
- Sources: B155, B281, B114.

### W155 Regional priors (state-level NHANES, Canada CCHS) and photoToIdeas byte-size telemetry
Priority P3 / lane food-world / size L / owner-only: no
- Goal: Spec regional priors and add byte-size telemetry for `photoToIdeas`. Build the priors only after review and licence checks.
- Done when:
  - A spec covers state-level weights and a Canada build, with the NCHS review and CCHS licence checks as entry gates.
  - `photoToIdeas` records image byte size per call (size only, no content). A test checks it.
- Files: `lib/foods/universe/prior.ts`, `lib/foods/universe/artifacts.ts`, `scripts/priors/`, `lib/plan/`, `docs/decisions/2026-10-05-nhanes-aggregate-use.md`.
- Risks and guards: No state, region, race or ethnicity field (ruling and `tests/foods/nhanes-no-microdata.test.ts`). Only `country_code = 'US'` gets the U.S. prior. No NHANES microdata ships.
- Depends on: none.
- Sources: B220.

### W156 compose_meal on the lib/meals engine: pinned foods, incomplete named draft result
Priority P3 / lane coach-ai / size M / owner-only: no
- Goal: Rebuild `compose_meal` on the `lib/meals` engine. Support pinned foods and an "incomplete named draft" result.
- Done when:
  - A named combo that cannot form a plate returns an incomplete draft with the missing part named.
  - Pinned foods stay in the plate; protein never softens.
  - Devin decides whether the four-food-term cap stays. Tests in `tests/coach/` cover pinned, incomplete and cap cases.
- Files: `lib/coach/compose.ts`, `lib/coach/compose-pinned.ts`, `lib/coach/compose-template.ts`, `lib/server/compose-pool-ports.ts`, `lib/meals/plate.ts`.
- Risks and guards: Every candidate passes D4 admission first. Golden files in `tests/coach/action-golden/` must stay byte-stable unless reviewed. compose_meal writes nothing.
- Depends on: none.
- Sources: B224.

### W157 Day-strip seven 44 px targets below 360 px (verify)
Priority P3 / lane ui-today / size S / owner-only: no
- Goal: Check the day strip at widths under 360 px. Fix edge placement and target size.
- Done when:
  - A 320 and 340 px check shows seven targets of at least 44 px, or a scroll that keeps each target reachable.
  - The first and last day are not clipped at the edge. A test in `components/TodayDayStrip.test.tsx` covers the rule.
- Files: `components/TodayDayStrip.tsx`, `components/TodayDayStrip.test.tsx`.
- Risks and guards: 44 px target rule from the design contract. No inline style; use tokens and role utilities. Keep the snap scroller behaviour.
- Depends on: none.
- Sources: B256.

### W158 Restaurant and chain-menu nutrition source (Nutritionix vs alternatives)
Priority P3 / lane research / size S / owner-only: yes
- Goal: Compare Nutritionix, Noms and Food Info for chain-restaurant and U.S. branded coverage, against USDA + Open Food Facts on a sample of 50 real logs.
- Done when:
  - A one-page decision note in `docs/research/` with coverage %, price, licence (storage and attribution terms vs our permanent log snapshots) and data-class impact.
  - Devin decides yes or no. Any paid vendor is added to `billing-lanes.md` first.
- Files: `docs/research/`, `lib/catalog/*`, `lib/ai/call-registry.ts` (data class if adopted).
- Risks and guards: New paid vendor needs owner approval. Licence may forbid permanent nutrient snapshots.
- Depends on: none.
- Sources: Devin, 2026-10-10 session (Nutritionix and public-apis question).

### W159 Food recall alerts from Daily Food Recalls (free API)
Priority P3 / lane research / size S / owner-only: no
- Goal: Warn a user when a product they logged, saved or have in the pantry is on an FDA/USDA recall.
- Done when:
  - Spike proves matching by UPC or brand+name on 20 recent recalls with no false alerts.
  - Decision note on match rules, alert surface and cron cadence.
- Files: `docs/research/`, `app/api/jobs/*`, `lib/shopping/*`.
- Risks and guards: Free, no key. A false alert harms trust: match by UPC only at first.
- Depends on: none.
- Sources: Devin, 2026-10-10 session (Nutritionix and public-apis question).

### W160 Household-unit densities from ExactCup (free API)
Priority P3 / lane research / size S / owner-only: no
- Goal: Use measured grams per cup, tablespoon and teaspoon to improve household-unit to gram conversion where USDA portions are missing.
- Done when:
  - Spike compares ExactCup densities with USDA portions for 40 common ingredients and lists the gaps it fills.
  - Decision note on bundling the table at build time (no runtime call).
- Files: `docs/research/`, `lib/foods/portions.ts`, `scripts/build-food-db.py`.
- Risks and guards: Bundle at build time only; never call it on a hot path. Check its licence before bundling.
- Depends on: none.
- Sources: Devin, 2026-10-10 session (Nutritionix and public-apis question).
