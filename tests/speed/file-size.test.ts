/**
 * The house rule, applied to the files T0 grew: under 400 lines for a module (~/AGENTS.md). T0
 * added a measurement, a deadline and a settle step to files that were already long, and two of
 * them went over (Grok pass 3, LOW 10).
 *
 * This is a guard, not a style preference: every one of these files is read by someone trying to
 * work out why a commit did or did not land.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MODULE_MAX = 400;

/**
 * components/LogFoodSheet.tsx was past the 800-line hard max on main, at 841. T0 has brought it
 * under: the meal card, the inline style recipes and the catalog card are modules of their own
 * now. The baseline follows it down, so the room T0 made cannot be spent again (Grok pass 4,
 * LOW 6; Grok pass 16, the 800-line max).
 */
const BASELINES: Record<string, number> = {
  "components/LogFoodSheet.tsx": 770,
  /**
   * `tests/coach/context.test.ts` crossed the 400-line aim by one line in the new-user run, when
   * the coach context grew the `needs_profile` cases (design §5). It is pinned here rather than
   * held under the aim: the cases are the point of the file, and a baseline stops it growing
   * further on this run's account. The next lane to touch it should split one `describe` out.
   * +36 (2026-10-02 DeepSeek audit, finding #3): the `eatsForSuggestions` anchors regression
   * tests — the empty-anchors repro and the protein-first/carb-fat-last ordering case.
   */
  "tests/coach/context.test.ts": 437,
  /** +5 in W029: an applied membership op hands the server-assigned revision to the mark cache. */
  "lib/sync/outbox-membership.ts": 42,
  /** +3 in Phase 9 slice 1: the transcript cache is filed under the account the shell was rendered
   *  for, and a write for an account that has since gone is skipped. */
  /** +3 in the 2026-10-01 audit: food-ideas taps queue onto the shell's action ledger (Undo). */
  /** 344 after the dock-composer consolidation (2026-10-01): Composer.tsx is gone (the dock's
   *  AssistantField is the one ask field now), replaced by the broadcast of the composer's
   *  disabled and send-feedback state to it and a tray-aware CoachFrame clearance. */
  /** +10 in the DeepSeek audit (2026-10-02, finding 2): `send` used to be an async function whose
   *  guard clauses doubled as its only way to say "declined" — a caller awaiting it could not tell
   *  that apart from "accepted, in flight". It now answers synchronously and runs the network round
   *  trip in an inner closure, so the dock can clear its draft only on a real acceptance. */
  /** 331 in the UI pass (2026-10-04): CoachFrame moved to its own module (components/coach/CoachFrame). */
  "components/coach/CoachShell.tsx": 331,
  "components/coach/Transcript.tsx": 99,
  "components/coach/NewMessagePill.tsx": 13,
  "components/coach/attachments/ScanAttachmentSheet.tsx": 94,
  /** 170 in the UI pass (2026-10-04, U19): the weigh-in logs directly and turns into its follow-ups
   *  (Undo, trend, suggestions) instead of sending a chat sentence; the weight path is weigh-in.ts. */
  "components/coach/attachments/WeighInField.tsx": 171,
  "components/coach/attachments/context.ts": 18,
  "components/coach/attachments/useAttachmentTurn.ts": 97,
  "components/coach/attachments/shell-state.ts": 65,
  "components/coach/editors/BarcodeDraftEditor.tsx": 276,
  /** +12 in W125: the meal's name, time and Save as recipe (CaptureMealDetails) when the capture sheet asks. */
  "components/coach/editors/CaptureDraftEditor.tsx": 273,
  "components/coach/editors/EditorPill.tsx": 27,
  "components/coach/editors/SanityNotices.tsx": 66,
  "components/coach/editors/not-verified.ts": 28,
  "components/coach/LogMealWarnings.tsx": 22,
  /** 37 in the AI-label pass (2026-10-05): blocks carry their message's provenance, so a
   *  compose_meal card inside a food_ideas block inherits it (one field, its import, its comment). */
  "components/coach/blocks/context.ts": 37,
  // +7: Phase 13 slice 4's dietary_profile_proposal import, BLOCK_KINDS entry and dispatch arm.
  "components/coach/blocks/index.tsx": 46,
  "components/coach/blocks/log_draft.tsx": 260,
  "components/coach/blocks/chart.tsx": 86,
  "components/coach/blocks/quick_replies.tsx": 24,
  "components/coach/blocks/food_search.tsx": 82,
  /** 23 in Phase 18 W6 UI: the tap-once idea card moved to FoodIdeaCard.tsx when it grew the
   *  offered slate a "picked" signal reports; the block keeps only the list. */
  "components/coach/blocks/food_ideas.tsx": 23,
  "components/coach/blocks/FoodIdeaCard.tsx": 34,
  /**
   * 196 on main; 201 after design §8.5's default arm, which is five lines of comment and one of
   * code. The card is the one place a forward-compatible action kind becomes a blank title, so the
   * reason the arm exists belongs beside it. 190 once LogMealWarnings moved to its own module.
   * 124 in architecture step 4: each kind's copy is its spec's `card` (lib/coach/actions/).
   * 135 in t23 #7/#8: the "Saved. Nutrition not fully checked." line and the "already undone"
   * line and their two props, plus the ALREADY_UNDONE_COPY constant and its import.
   */
  "components/CoachActionCard.tsx": 135,
  /** +11 in W124: the scanned food's star works with no caller wiring (starScanned). */
  "components/ScanConfirmSheet.tsx": 109,
  /** +5 in W125: the details spec in, and the details out to the save. */
  "components/CaptureConfirm.tsx": 71,
  "lib/coach/use-visual-viewport.ts": 42,
  "lib/coach/use-bottom-follow.ts": 93,
  "lib/coach/thread-history.ts": 29,
  /**
   * `lib/ai/adapter.ts` was 420 before Phase 13 slice 0's review-fix round and 511 after it (the
   * live-dictation mint and its Live-token plumbing landed there), and nothing tracked it. The
   * mint moved out (and was retired with Live dictation) and the `ai_calls` row, spend lock and
   * write live in lib/ai/call-ledger.ts, the same split-by-concern as models.ts, circuit.ts and
   * failures.ts.
   * Pinned where the split left it so it cannot climb back; the next lane to touch it should
   * move the Files API media helpers out too and bring it under the aim. The 2026-10-01 audit moved
   * withMediaPart to lib/ai/gemini-media.ts and the baseline followed it down. Removing the retired
   * Nous transport and Live dictation (2026-10-01) took it under the aim, and the baseline followed.
   * Moving the gates, the retry loop and the row into callModel (lib/ai/call.ts, 2026-10-01) left
   * it the Gemini transport and schema parse, and the baseline followed again.
   * +5 (scale S2): the per-attempt spend reservation's upper bound — the input bound of the parts,
   * media and response schema at the call's output cap (`reserveCostUsd`, lib/ai/models.ts).
   */
  "lib/ai/adapter.ts": 279,
  /** +21 (2026-10-01): the row takes its cost from callModel, and capture's blocked row moved here
   *  from lib/server/capture.ts so the ledger is the only `ai_calls` writer. Scale S2 removed the
   *  per-instance spend lock (lib/ai/spend.ts reserves in the database), and the baseline followed.
   *  +3: each row names its spend reservation, so a sweep can reconcile an unsettled hold. */
  "lib/ai/call-ledger.ts": 64,
  /**
   * 2026-10-02, owner decision (plain whole foods clear for allergens they cannot contain): this
   * file was 424 on main, already past the 400 aim, before escalation-by-name and the whole-food
   * clearance call added foodName/brand threading. The whole-food class table itself moved to its
   * own module (lib/policy/whole-foods.ts) to keep this file's own growth to the call site; the
   * next lane to touch it should split the evidence-level derivation out to bring it under 400.
   * +6 (2026-10-02 DeepSeek audit, finding #2): `packaged` threaded alongside `brand` so a
   * scanned barcode/label can never read as a generic unbranded whole food.
   */
  /** +2 (2026-10-02, live warm): name and brand reach deriveEvidence, so a plain whole food's
    *  class bounds what Jev may list (jasmine rice had been stored as gluten "listed"). +2
   *  (W022): the "sesame butter" exclusion and the import of the name scan, which lives in its
   *  own module (lib/policy/allergen-name.ts). */
  /** +6 (W014, audit 2026-10-10 A026): an OFF `en:crustaceans` class tag is crustacean evidence. */
  "lib/policy/allergens.ts": 473,
  /**
   * 2026-10-02 DeepSeek audit (HIGH, finding #2): was exactly 400 before `toMatch` and
   * `matchFromDraft` both gained `foodBrand`/`packaged` on their evaluatePolicy call, so a scanned
   * barcode's whole-food check sees this row's real brand and is never cleared as a generic
   * unbranded commodity. The next lane to touch this file should split `toMatch` out.
   */
  "lib/server/barcode.ts": 403,
};

const MODULES = [
  // P5: static design guards and the card-specific legibility proof stay focused.
  "tests/design/tokens.test.ts",
  "tests/design/no-text-shadow-in-surfaces.test.ts",
  "tests/design/overflow.test.tsx",
  "components/LoggedExtras.test.tsx",
  "tests/design/visible-field-labels.test.tsx",
  // P2: the Settings page, section modules, controller and focused proofs stay reviewable.
  "app/settings/page.tsx",
  "components/settings/DataAccountSection.tsx",
  "components/settings/HealthConnectionsSection.tsx",
  "components/settings/ScheduleSection.tsx",
  "components/settings/Section.tsx",
  "components/settings/TargetsSection.tsx",
  "components/settings/use-settings-controller.ts",
  "tests/settings/authority-paths.test.ts",
  "tests/settings/data-account.test.tsx",
  "tests/settings/health-connections.test.tsx",
  "tests/settings/input-wells.test.tsx",
  "tests/settings/tap-paths.test.tsx",
  // P1: display-unit controls, conversion contracts and focused proofs stay independently small.
  "lib/units/height.ts",
  "components/HeightField.tsx",
  "components/WeightField.tsx",
  "tests/units/height.test.ts",
  "tests/units/height-field.test.tsx",
  "tests/body/unit-preferences.test.ts",
  "tests/body/profile-height-settings.test.tsx",
  "tests/body/units-migration.test.ts",
  "tests/body/weight-units.test.tsx",
  "lib/timing.ts",
  "lib/fetch-with-deadline.ts",
  "lib/dates/range.ts",
  "lib/coach/meal-title.ts",
  "scripts/eval/coach-streak-meals.ts",
  "tests/coach/streak-meals-p2.test.ts",
  // M2: each client-apply, title, sync and card boundary stays independently readable.
  "lib/types.ts",
  "lib/coach/apply-client.ts",
  "lib/coach/apply-slot.ts",
  "lib/coach/apply-log.ts",
  "lib/plan-day-client.ts",
  "lib/resolve.ts",
  "lib/sync/plan-days-schema.ts",
  "lib/sync/plan-days.ts",
  "lib/log-client.ts",
  "lib/server/log.ts",
  "app/api/log/commit/route.ts",
  "components/SlotCard.tsx",
  "components/LoggedExtras.tsx",
  "components/LoggedExtras.test.tsx",
  "tests/log/title.test.ts",
  "tests/log/migration-title.test.ts",
  "supabase/migrations/20261025090200_log_entries_title.sql",
  "supabase/migrations/down/20261025090200_log_entries_title.down.sql",
  "lib/capture-client.ts",
  "lib/capture/presentation.ts",
  "lib/log-commit-client.ts",
  "lib/log-commit-settle.ts",
  "lib/log/meal-card.ts",
  "lib/log/pending.ts",
  "lib/log/reconcile.ts",
  "lib/log/live-commits.ts",
  "lib/log/outcome.ts",
  "lib/log/today-state.ts",
  "lib/log/read-result.ts",
  "lib/log/delete-entry.ts",
  // W027: split out of pending, reconcile and the settle to keep each under the house rule.
  "lib/log/pending-types.ts",
  "lib/log/card-from-request.ts",
  "lib/log/queued-ops.ts",
  // W123: Log again and the recent meals it reads.
  "lib/log/log-again.ts",
  "lib/log/recent-meals.ts",
  "lib/log/catalog-card.ts",
  "lib/log/card-items.ts",
  "lib/log/web-lock.ts",
  "lib/log/retry-unsaved.ts",
  "lib/log/queue-commit.ts",
  "lib/sync/log-entry-ops.ts",
  // W011 (2026-10-10): the conflict rebase moved to lib/sync/outbox-conflict.ts, which took the
  // outbox under the house rule; it leaves its 406-line baseline for the rule itself.
  "lib/sync/outbox.ts",
  "lib/sync/outbox-conflict.ts",
  // W026 (2026-10-11): parking and its release, and the settings replay's watermark.
  "lib/sync/outbox-park.ts",
  "lib/sync/settings-recovery.ts",
  "components/LogFoodSheet.styles.ts",
  "lib/server/barcode-policy.ts",
  "lib/warm-client.ts",
  // T7: the coach's voice, added to the same guard so it cannot grow past the house rule either.
  "lib/coach/dictation.ts",
  "lib/coach/hold.ts",
  "lib/coach/hold-ports.ts",
  "lib/capture-mic.ts",
  "lib/coach/speech-api.ts",
  "lib/coach-transcribe-client.ts",
  "lib/server/coach-transcribe.ts",
  // B1: each deterministic server hydrator stays independently inspectable.
  "lib/coach/blocks/hydrate-chart.ts",
  "lib/coach/blocks/hydrate-food-search.ts",
  "lib/coach/blocks/hydrate-food-ideas.ts",
  "lib/coach/blocks/quick-replies.ts",
  "lib/coach/blocks/index.ts",
  "components/CoachMic.tsx",
  "components/CoachChat.tsx",
  // C1a: the shared facet vocabulary, stable identity/hash, and frozen provider rubric.
  "lib/foods/facets.ts",
  "lib/foods/facet-keys.ts",
  "lib/foods/facet-questions.ts",
  "lib/foods/facet-vocabulary.ts",
  "lib/foods/sha256.ts",
  // C6b: the reproducible labelled evaluator, generated freeze, and its contract test.
  "scripts/eval/jev-facets.ts",
  "lib/foods/facet-thresholds.ts",
  "tests/foods/facet-thresholds.test.ts",
  // C6a: the shared provider brake and request-scoped Jev call budget.
  "lib/ai/typesafe.ts",
  "lib/ai/call.ts",
  "lib/ai/spend.ts",
  "lib/ai/request-budget.ts",
  "tests/ai/typesafe.test.ts",
  // C1b: offline facet warming, its resumable driver, and focused seam tests.
  "lib/foods/catalog-ingredients.ts",
  "lib/foods/facet-warm.ts",
  "scripts/warm-facets.ts",
  "scripts/annotate-policy-categories.ts",
  "tests/foods/facets/warm.test.ts",
  "tests/foods/facets/catalog-ingredients.test.ts",
  "tests/foods/facets/warm-cli.test.ts",
  "tests/foods/facets/call-sites.test.ts",
  "tests/foods/facets/import-graph.test.ts",
  // C3a: deterministic/async sanity and annotation-only serving identity.
  "lib/log/sanity-types.ts",
  "lib/log/sanity-deterministic.ts",
  "lib/log/sanity.ts",
  "lib/log/serving-identity.ts",
  "tests/log/sanity/deterministic.test.ts",
  "tests/log/sanity/async.test.ts",
  "tests/log/sanity/serving-identity.test.ts",
  // C3b: one server integration boundary, its warning UI, and focused behavior proof.
  "lib/server/coach-sanity.ts",
  "tests/coach/sanity-integration.test.ts",
  "tests/coach/editors/sanity.test.tsx",
  // C2: pure preference-to-facet policy, empty clinical table, and precedence boundary.
  "lib/policy/facet-rules.ts",
  "lib/policy/condition-rules.ts",
  "lib/policy/constraints.ts",
  // 2026-10-02: the whole-food class table and its own focused unit test stay independently small.
  "lib/policy/whole-foods.ts",
  "lib/policy/whole-food-classes.ts",
  "lib/policy/whole-foods.test.ts",
  // Phase 18 W2c: the deterministic diet evidence, the preference marks split out of constraints.ts,
  // and the read-only impact report with its pre-W2c half.
  "lib/policy/diet-evidence.ts",
  "lib/policy/preference-marks.ts",
  "scripts/diet-rule-jev-impact.ts",
  "scripts/diet-rule-jev-impact-legacy.ts",
  "tests/policy/diet-rule-jev-removal.test.ts",
  // C4a: cache-gated suggestion candidates, one ranking payload, and advisory role Choice.
  "lib/coach/suggest.ts",
  "lib/coach/suggest-candidates.ts",
  "lib/coach/suggest-messages.ts",
  "lib/coach/suggest-policy.ts",
  "lib/coach/suggest-rank.ts",
  "lib/coach/role-advice.ts",
  "lib/coach/log-policy.ts",
  "lib/server/coach-role-advice.ts",
  "lib/server/coach-ports.ts",
  "tests/coach/suggest.test.ts",
  "tests/coach/suggest-facets.test.ts",
  "tests/coach/suggest-role-advice.test.ts",
  // C4b: one recipe reject boundary plus explicit role-confirmation persistence.
  "lib/coach/compose.ts",
  "lib/coach/recipe-policy.ts",
  "lib/coach/apply-entries.ts",
  "lib/coach/apply-shared.ts",
  "tests/coach/recipes/policy.test.ts",
  "tests/coach/recipes/apply.test.ts",
  "tests/coach/recipes/client-import-graph.test.ts",
  "tests/coach/recipes/role-confirmation.test.ts",
  // B3: evaluator state and report rendering stay split into independently readable modules.
  "scripts/eval/coach-streak-state.ts",
  "scripts/eval/coach-streak-report.ts",
  "scripts/eval/coach-streak-harness.ts",
  "scripts/eval/coach-streak-evaluate.ts",
  "scripts/eval/coach-streak-proof.ts",
  "scripts/eval/coach-streak-jev-contract.ts",
  "scripts/eval/coach-streak-jev.ts",
  // H4: coach activity context, advisory expenditure tool, and their tests.
  "lib/server/coach-context.ts",
  "lib/coach/registry.ts",
  "lib/coach/prompt.ts",
  "lib/mcp/expenditure-tools.ts",
  "tests/coach/prompt-language.test.ts",
  "tests/coach/mcp-tools.test.ts",
  "tests/coach/streak-runner.test.ts",
  "tests/expenditure/mcp-tools.test.ts",
  /**
   * The new-user run, lane T4 (design §8.3, §8.4): the card render specs, the manifest they share
   * and the reachability gate that reads it, plus the body trend the gate now has something to
   * point at. Every one of these is read by someone asking "which states does this card have?",
   * so each stays inside the house limit.
   */
  "tests/cards/inventory.test.ts",
  "tests/cards/manifest.ts",
  "tests/cards/today.test.tsx",
  "tests/cards/week.test.tsx",
  "tests/cards/body.test.tsx",
  "tests/cards/coach.test.tsx",
  "tests/cards/settings.test.tsx",
  "tests/cards/foods.test.tsx",
  "tests/cards/onboarding.test.tsx",
  "tests/cards/sheets.test.tsx",
  "tests/expenditure/weight-trend-series.test.ts",
  "tests/cards/scan-sheet.test.tsx",
  "tests/expenditure/proposal-card-copy.test.tsx",
  "components/BodyDashboard.tsx",
  "components/WeightTrend.tsx",
  "lib/api-types.ts",
  "lib/server/expenditure.ts",
  "lib/server/expenditure-intake.ts",
  "app/api/expenditure/route.ts",
  "components/settings/ScheduleSection.tsx",
  // The new-user run, lane W1: the readiness walkthrough runner and its helper library.
  "scripts/readiness/new-user-walk.mjs",
  "scripts/readiness/new-user-walk.lib.mjs",
  // The new-user run, lane T1: the eaten-tick migration pair, the moved grid and the RLS proof.
  "supabase/migrations/20261026090000_plan_days_eaten_slots.sql",
  "supabase/migrations/down/20261026090000_plan_days_eaten_slots.down.sql",
  "components/week/WeekGrid.tsx",
  "tests/rls/new-user-isolation.test.ts",
  "components/add-food/catalog-food.ts",
  "tests/plan/eaten-migration.test.ts",
  // The new-user run, lane T2: the neutral-defaults migration pair and its focused proofs.
  "supabase/migrations/20261026090100_neutral_user_defaults.sql",
  "supabase/migrations/down/20261026090100_neutral_user_defaults.down.sql",
  "tests/onboarding/auth-gate.test.tsx",
  "tests/constraints/neutral-defaults.test.ts",
  "tests/constraints/avoid-rules-picker.test.tsx",
  "tests/profile/time-zone-capture.test.ts",
  "tests/helpers/constraint-profile.ts",
  // The new-user run, lane T3: legacy retirement, the tenancy gate and the live readiness check.
  "supabase/migrations/20261026090200_retire_legacy_store.sql",
  "supabase/migrations/down/20261026090200_retire_legacy_store.down.sql",
  "scripts/readiness/new-user-live.sh",
  "tests/jobs/new-user-live.test.ts",
  "tests/tenancy/no-personal-defaults.test.ts",
  "tests/tenancy/personal-defaults.allowlist.json",
  // Architecture step 3: the coach turn split into one module per stage (lib/server/coach-turn/).
  // lib/server/coach-turn.ts was 1,230 lines with a 900-line runTurn; it is the orchestrator now.
  "lib/server/coach-turn.ts",
  "lib/server/coach-turn/attachment.ts",
  "lib/server/coach-turn/deadline.ts",
  "lib/server/coach-turn/deflect.ts",
  "lib/server/coach-turn/fast-path.ts",
  "lib/server/coach-turn/fast-path-copy.ts",
  "lib/server/coach-turn/final-step.ts",
  "lib/server/coach-turn/finish.ts",
  "lib/server/coach-turn/history-recall.ts",
  "lib/server/coach-turn/intent.ts",
  "lib/server/coach-turn/kit.ts",
  "lib/server/coach-turn/model-context.ts",
  "lib/server/coach-turn/model-loop.ts",
  "lib/server/coach-turn/model-state.ts",
  "lib/server/coach-turn/outcome.ts",
  "lib/server/coach-turn/reply.ts",
  "lib/server/coach-turn/setup.ts",
  "lib/server/coach-turn/tool-batch.ts",
  "lib/server/coach-turn/types.ts",
  // Architecture step 4: one ActionSpec per coach action kind, registered once (lib/coach/actions/).
  "lib/coach/actions/apply.ts",
  "lib/coach/actions/copy.ts",
  "lib/coach/actions/delete-entry.ts",
  "lib/coach/actions/fields.ts",
  "lib/coach/actions/food-lists.ts",
  "lib/coach/actions/ground-kit.ts",
  "lib/coach/actions/index.ts",
  "lib/coach/actions/log-meal.ts",
  "lib/coach/actions/log-water.ts",
  "lib/coach/actions/log-weight.ts",
  "lib/coach/actions/move-entry.ts",
  "lib/coach/actions/move-slot.ts",
  "lib/coach/actions/save-recipe.ts",
  "lib/coach/actions/schemas.ts",
  "lib/coach/actions/set-slot-meal.ts",
  "lib/coach/actions/set-targets.ts",
  "lib/coach/actions/shift-schedule.ts",
  "lib/coach/actions/slot-items.ts",
  "lib/coach/actions/spec.ts",
  "lib/coach/actions/update-profile.ts",
  "lib/coach/actions/wire-fields.ts",
  "lib/coach/ground.ts",
  "lib/coach/history.ts",
  "lib/coach/intent.ts",
  "lib/coach/intent-args.ts",
  "tests/coach/action-golden/action-golden.test.tsx",
  "tests/coach/action-registry.test.ts",
  "tests/coach/action-golden/corpus.ts",
  "tests/coach/action-golden/ground-corpus.ts",
  // Phase 18 W1: the universe manifest, its data split across files, and its scripts and tests.
  "lib/foods/universe/vocabulary.ts",
  "lib/foods/universe/seed.ts",
  "lib/foods/universe/manifest.ts",
  "lib/foods/universe/derive.ts",
  "lib/foods/universe/data/base.ts",
  "lib/foods/universe/data/staples.ts",
  "lib/foods/universe/data/packs.ts",
  "lib/foods/universe/data/excluded.ts",
  "scripts/annotate-universe.ts",
  "scripts/universe-report.ts",
  "tests/helpers/universe-matrix.ts",
  "tests/foods/universe-data.test.ts",
  "tests/foods/universe-annotate.test.ts",
  "tests/foods/universe-report.test.ts",
  // Phase 18 W1b: the population prior and substitute graph build, its runtime contract and checks.
  "lib/foods/universe/prior.ts",
  "lib/foods/universe/substitutes.ts",
  "lib/foods/universe/artifacts.ts",
  "lib/foods/universe/artifact-schema.ts",
  ...["artifact-io", "build", "build-nhanes", "check-artifact", "crosswalk", "csv", "fairness", "fetch", "graph", "holdout", "inputs",
    "metrics", "nhanes", "panel", "report", "report-extra", "sources", "workspace", "xpt"].map((name) => `scripts/priors/${name}.ts`),
  "tests/foods/priors-check-artifact.test.ts",
  "tests/foods/nhanes-no-microdata.test.ts",
  "tests/foods/nhanes-workspace-ignored.test.ts",
  "tests/foods/population-prior-gate.test.ts",
  "tests/foods/priors-pipeline.test.ts",
  "tests/foods/substitute-graph.test.ts",
  "tests/meals/ranking-boundary.test.ts",
  // Phase 18 W3: eaten history and choice episodes, the food key, the taste route and its tests.
  "lib/meals/taste.ts",
  "lib/meals/taste-identity.ts",
  "lib/meals/food-key.ts",
  "lib/meals/size.ts",
  "lib/server/taste-history.ts",
  "lib/server/taste-admission.ts",
  "lib/server/taste-resolve.ts",
  "tests/server/taste-resolution-matrix.test.ts",
  "lib/server/date-chunks.ts",
  "app/api/foods/taste/route.ts",
  "tests/helpers/taste-fixture.ts",
  "tests/meals/taste.test.ts",
  "tests/meals/food-key-wire.test.ts",
  "tests/server/taste-history.test.ts",
  "tests/server/taste-route.test.ts",
  // Phase 18 D6: POST /api/foods/favor.
  "lib/server/taste-favor.ts",
  "app/api/foods/favor/route.ts",
  "tests/server/taste-favor.test.ts",
  "tests/server/favor-route.test.ts",
  "lib/server/membership-revisions.ts",
  "tests/tenancy/admin-favor.test.ts",
  "tests/helpers/favor-fakes.ts",
  "tests/migrations/favor-families-db.test.ts",
  // Phase 18 W1c: the pairing table, the Jev pair labels and their checks.
  ...["table", "schema", "questions", "gate", "artifacts"].map((name) => `lib/foods/pairing/${name}.ts`),
  ...["artifact-io", "build", "calibrate", "check-pairing", "co-consumption", "holdout", "jev-labels", "labels", "occasions",
    "pairs", "report"].map((name) => `scripts/pairing/${name}.ts`),
  "tests/helpers/pairing-evidence.ts",
  ...["activation", "calibration", "check-artifact", "co-consumption", "formula", "gate", "import-graph", "labels"]
    .map((name) => `tests/foods/pairing-${name}.test.ts`),
  "lib/ai/payloads.ts",
  // Scale S1: the region drift guard and the retry jitter.
  "tests/speed/region-pins.test.ts",
  "lib/jitter.ts",
  "lib/sync/backoff.ts",
  "tests/speed/jitter.test.ts",
  "app/api/health/route.ts",
  "tests/server/health-route.test.ts",
  // Phase 18 W6: signal events with offered slates, the route, the purge job and their tests.
  "lib/foods/signals.ts",
  "lib/foods/signals-client.ts",
  "lib/server/food-signals.ts",
  "app/api/foods/signals/route.ts",
  "app/api/jobs/signal-purge/route.ts",
  "tests/foods/signals-route.test.ts",
  "tests/foods/signals-client.test.ts",
  "tests/jobs/signal-purge.test.ts",
  "tests/migrations/food-signal-events-db.test.ts",
  // W029: the role delta, server-assigned membership revisions and their tests.
  "lib/sync/role-delta.ts",
  "tests/sync/role-delta.test.ts",
  "tests/foods/membership-server-rev.test.ts",
  "tests/migrations/membership-server-rev-sql.test.ts",
];

const COMPONENTS = Object.keys(BASELINES);

/** Lines as `wc -l` counts them: the trailing newline ends the last line, it does not start one. */
function lines(path: string): number {
  const text = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

describe("the files T0 touched", () => {
  it.each(MODULES)("keeps %s under 400 lines", (path) => {
    expect(lines(path)).toBeLessThanOrEqual(MODULE_MAX);
  });

  it.each(COMPONENTS)("keeps %s within the size it is allowed", (path) => {
    expect(lines(path)).toBeLessThanOrEqual(BASELINES[path]);
  });
});
