# Phase 5 + 6 + 7 — Shared contracts (frozen 2026-09-11, wave 4)

Extends the Phase 0, Phase 1–2 and Phase 3–4 contracts (`docs/plans/2026-09-10-phase-0/`, `docs/plans/2026-09-11-phase-1-2/`,
`docs/plans/2026-09-11-phase-3-4/00-contracts.md`), all still in force. Authority: `docs/architecture.md` v2.1 >
`docs/specs/phase-5-body-data.md`, `phase-6-estimator.md`, `phase-7-coach.md` > this file > lane plans. Numbers authority for
every seed and floor: `/Users/zero-suminc./projects/clients/Sasha/analysis/targets.md`. Items marked "reconciled" override a spec
because Phase 0 already shipped the object differently. A contract change lands here first as `docs: phase-5-7 contract change — <what>`.

**Start condition:** `main` at or after the wave-3 integration PR (Phases 3–4 landed: `ai_calls` widened, `media` bucket,
`lib/capture/types.ts`, `lib/policy/constraints.ts`, `CaptureSheet` with `initialDraft`, `vercel.json` with the media-sweep cron).
A lane that starts before wave 3 lands codes against `docs/plans/2026-09-11-phase-3-4/00-contracts.md` for those shapes and says so.

**Already on `main` from Phase 0 (do not recreate):** `health_sources` (kind check includes `'manual'`), `ingest_events`,
`health_samples` (generated `dedupe_key`, unique index), the `weigh_ins` view (returns `value` + `unit` unconverted),
`target_profiles` (grams + percent columns and both constraints), `expenditure_estimates`, `target_proposals`, `constraint_profiles`,
`coach_threads(id, title, user_id, created_at)`, `coach_messages(id, thread_id, role, content, tool_calls, policy_checks, created_at)`,
`api_tokens` (no scope check constraint), `ai_calls` (`purpose` free text, `status`, `error`). Phase 0's RLS pattern 1 gave every
owner table a full `_rw` policy and `select, insert, update, delete` grants to `authenticated` — the wave-4 migrations **tighten**
those where a spec says "written only by the privileged boundary".

## 1. Lanes and file ownership

| Lane | Owns (create/modify only these) | Branch |
|---|---|---|
| **P — Body data** (Phase 5) | `supabase/migrations/20260925000000_phase5_health_ingest.sql`, `…20260926000000_phase5_oura_oauth.sql` (+ `supabase/migrations/down/*.down.sql`), `lib/health/contract.ts`, `lib/health/units.ts`, `dedupe.ts`, `intervals.ts`, `normalize.ts`, `replay.ts`, `daily.ts`, `lib/oura/map.ts`, `lib/oura/client.ts`, `lib/server/crypto.ts`, `lib/server/health-tokens.ts`, `lib/server/health-daily.ts`, `lib/server/health-ingest.ts`, `lib/server/oura.ts`, `app/api/health/ingest/route.ts`, `app/api/health/daily/route.ts`, `app/api/health/tokens/route.ts`, `app/api/health/tokens/[id]/route.ts`, `app/api/health/oura/start/route.ts`, `app/api/health/oura/callback/route.ts`, `app/api/health/oura/disconnect/route.ts`, `app/api/jobs/oura-pull/route.ts`, `lib/mcp/health-tools.ts`, `lib/health-client.ts`, `components/BodyDashboard.tsx`, `components/HealthMetricCard.tsx`, `components/Sparkline.tsx`, `components/HealthSourcesSheet.tsx`, `app/body/page.tsx`, `scripts/issue-health-token.ts`, `docs/health-auto-export.md`, `tests/health/**`, `NOTICE.md` (fud-ai reinstall-recovery row if ported) | `feat/p5-body-data` |
| **Q — Estimator** (Phase 6) | `supabase/migrations/20261006090100_phase6_expenditure.sql` (+ down), `lib/expenditure.ts`, `lib/expenditure.fixtures.ts`, `lib/targets/percent.ts`, `lib/proposal.ts`, `lib/api-types.ts`, `lib/server/expenditure.ts`, `lib/server/targets.ts`, `lib/server/proposals.ts`, `app/api/expenditure/route.ts`, `app/api/targets/route.ts`, `app/api/proposals/route.ts`, `app/api/proposals/[id]/decide/route.ts`, `app/api/jobs/estimate/route.ts`, `app/api/jobs/weekly-proposal/route.ts`, `lib/mcp/expenditure-tools.ts`, `lib/estimator-client.ts`, `components/EstimatorCard.tsx`, `components/ProposalCard.tsx`, `components/TargetModeSheet.tsx`, `components/WeightTrend.tsx`, `scripts/backtest-estimator.ts`, `docs/estimator-backtest-<date>.md`, `lib/sync/types.ts`, `lib/sync/keys.ts`, `lib/sync/merge.ts`, `lib/sync/idb.ts` (DB_VERSION 4 only), `tests/expenditure/**`, `tests/targets/**`, `tests/proposals/**` | `feat/p6-estimator` |
| **R — Coach** (Phase 7) | `supabase/migrations/20261001000000_phase7_coach.sql`, `…20261003000000_phase7_token_scopes.sql` (+ down), `lib/coach/registry.ts`, `dispatch.ts`, `envelope.ts`, `deflect.ts`, `prompt.ts`, `turn.ts`, `floors.ts`, `policy.ts`, `executors.ts`, `types.ts`, `lib/coach/fixtures/injection-corpus.ts`, `lib/server/coach.ts`, `lib/server/constraints.ts`, `lib/server/privileged.ts` (scope union widened only — every existing test stays green), `app/api/coach/route.ts`, `app/api/coach/threads/route.ts`, `app/api/coach/threads/[id]/route.ts`, `app/api/constraints/route.ts`, `app/api/jobs/weekly-review/route.ts`, `lib/mcp/coach-tools.ts`, `lib/coach-client.ts`, `components/CoachChat.tsx`, `CoachMessage.tsx`, `CoachSuggestion.tsx`, `ConstraintsEditor.tsx`, `app/coach/page.tsx`, `scripts/coach-injection-canary.ts`, `docs/coach-canary-<date>.md`, `tests/coach/**`, `tests/constraints/**`, `NOTICE.md` (fud-ai guardrail-phrasing row) | `feat/p7-coach` |

Shared, nobody edits on a lane branch: `package.json` (no new dependencies — `Sparkline` is hand-written SVG), `DESIGN.md`, `app/globals.css`,
`docs/architecture.md`, `lib/ai/adapter.ts`, `lib/policy/constraints.ts`, `lib/capture/**`, `lib/log/**`, `lib/nutrients/**`, `lib/targets.ts`,
`lib/types.ts`, `lib/store.ts`, `lib/server/auth.ts`, `lib/server/admin.ts`, `lib/server/http.ts`, `lib/server/ratelimit.ts`, `lib/server/tokens.ts`,
and the **integration-stage files**: `app/api/mcp/route.ts`, `vercel.json`, `app/settings/page.tsx`, `app/page.tsx`, `components/TabBar.tsx`,
`components/QuickActions.tsx`. Each lane ends with "Hand-off to integration" carrying (a) its `register<X>Tools` call and scope map for the MCP
route, (b) its cron lines for `vercel.json` (UTC expressions for America/New_York, DST drift accepted), (c) the ≤ 15-line mount diff per screen.

**Contract changes landed this wave (each its own `docs: phase-5-7 contract change — <what>` commit,
self-identified by the lane that needed it):** the Lane R row above gains `types.ts`; §2 gains
`health_samples.device_label`; §3 gains `expenditure_estimates.qualified_days` and `.weigh_in_count`.

Land order: **P → Q → R** (Q's engine consumes P's `toCanonical`; R's registry consumes Q's `latestEstimate` and `activeTargets`). Every lane
starts together: P's unit engine needs nothing; Q's engine and backtests need nothing; R's registry, envelope, deflection, corpus and policy
need nothing. Only the cross-lane executors (Q → P, R → Q) are coded against the signatures below and tested with test doubles.

## 2. Body data (P produces; Q, R consume)

**Migrations (reconciled).** `20260925000000_phase5_health_ingest.sql`: the spec's `health_samples_type_ck`, a new nullable
`health_samples.device_label text` column (addition, not a rename — Phase 0 shipped the table without it, and the merge rule below
needs the Watch/phone distinction per sample, not per source), the two indexes, then
**replace** Phase 0's policies on `health_samples` and `ingest_events` — `drop policy health_samples_rw`, `drop policy ingest_events_rw`,
create the spec's select-only `_ro` policies, `revoke insert, update, delete on health_samples, ingest_events from authenticated` —
`health_sources` keeps its Phase 0 `_rw` (the user manages sources); the `daily_health` view verbatim (a plain aggregate; the merge rules run
in `lib/health/daily.ts`). `20260926000000_phase5_oura_oauth.sql`: `oauth_states`, `job_runs` verbatim. Down files drop only what they created
and restore the two `_rw` policies. Writes to `health_samples`/`ingest_events` go through two `security definer` RPCs the first migration adds
(`p_user_id` first, `service_role` only): `health_ingest_apply(p_user_id, p_source_id, p_event_id, p_samples jsonb) returns table (accepted int,
updated int, skipped int)` (the §3.5 correction upsert) and `health_ingest_event(p_user_id, p_source_id, p_payload_hash bytea, p_status text)
returns uuid` (`unique (source_id, payload_hash)` → returns the existing id with `status = 'duplicate'` semantics to the caller).

```ts
// lib/health/contract.ts — zod + inferred types exactly as the Phase 5 spec §5
export const healthIngestBodySchema; export type HealthIngestBody; export type HealthIngestResponse;
export type DailyHealthRow = { local_date: string; steps: number | null; active_kcal: number | null;
  sleep_minutes: number | null; body_mass_kg: number | null; sources: string[] };
export type DailyHealthResponse; export type OuraPullResponse;
export type SampleType = "body_mass" | "step_count" | "active_energy" | "basal_energy" | "sleep_asleep" | "sleep_in_bed"
  | "resting_heart_rate" | "hrv_sdnn" | "readiness_score";
export type NormalizedSample = { type: SampleType; value: number; unit: string; start_time: string; end_time: string;
  vendor_sample_id?: string; vendor_updated_at?: string; device_label?: string; tz: string };

// lib/health/units.ts — Q consumes toCanonical for legacy 'lb' weigh-ins
export function toCanonical(type: SampleType, value: number, unit: string): { value: number; unit: string };  // throws on unknown unit
export function canonicalUnit(type: SampleType): string;
export const LB_PER_KG = 2.2046226218;

// lib/health/dedupe.ts, intervals.ts, normalize.ts, replay.ts, daily.ts, lib/oura/map.ts — exactly the spec §7 signatures.
// dedupeKey must equal the generated column: coalesce(vendor_sample_id, type|epoch(start)|epoch(end)) with integer epoch seconds.

// lib/server/health-daily.ts — the ONE read path for merged days (route, MCP tool, Q's estimator all use it)
export async function mergedDays(client: SupabaseClient, userId: string, from: string, to: string): Promise<DailyHealthRow[]>;
export async function weighInsKg(client: SupabaseClient, userId: string, from: string, to: string): Promise<{ date: string; kg: number }[]>;
// weighInsKg reads the weigh_ins view and runs every row through toCanonical('body_mass', value, unit) — Q never reads weigh_ins directly.

// lib/server/crypto.ts
export function sealOauth(plain: OauthTokens, key?: Buffer): string;   // AES-256-GCM, key from HEALTH_TOKEN_KEY (base64, 32 bytes)
export function openOauth(sealed: string, key?: Buffer): OauthTokens;   // throws on tamper
// lib/server/health-tokens.ts
export function issueSourceToken(): { raw: string; hash: Buffer };      // 32 random bytes, base64url, prefix 'smh_'
export async function resolveSourceByToken(admin, raw): Promise<{ id: string; userId: string; kind: string } | null>;  // constant-time on the hash

// lib/mcp/health-tools.ts
export function registerHealthTools(server: McpServer, ctx: { userId: string; admin: SupabaseClient }): void;  // get_body_data({from,to})
export const HEALTH_TOOL_SCOPES: Record<"get_body_data", "read">;

// components/Sparkline.tsx — Q's WeightTrend consumes it
export default function Sparkline(props: { points: (number | null)[]; width?: number; height?: number; stroke?: string; label: string }): JSX.Element;
// null points render a gap, never a zero. Pure SVG, no dependency.
```

Routes and limits exactly as the Phase 5 spec §8. `HEALTH_INGEST_ENABLED` unset → ingest and Oura routes answer 503, the pull job no-ops, the
dashboard hides. Ingest identity: `resolveSourceByToken` → the privileged boundary (`adminClient`, `p_user_id` from the source row) — never
`withTokenUser` (that is the MCP token path). Client cache: `localStorage` key `smc:health_daily` holding the last `DailyHealthResponse` + fetched-at
(reconciled: no IndexedDB store; `lib/sync/idb.ts` is Lane Q's file this wave). Weight renders in **pounds** (ASSUMED, spec open question 8); storage
stays kilograms. No fifth "Body" tab (ASSUMED, open question 5): `/body` is reached from a Settings row and a Today weight chip (integration).
Legacy env `HEALTH_INGEST_TOKEN` in Vercel is unused by this design and is removed at integration.

## 3. Estimator (Q produces; R consumes)

**Migration (reconciled).** `20261006090100_phase6_expenditure.sql`: `alter table target_proposals add column week_start date not null`,
two new nullable integer columns `expenditure_estimates.qualified_days` and `expenditure_estimates.weigh_in_count` (addition, not a
rename — `ExpenditureResponse.qualifiedDays`/`weighInCount` need somewhere to read from), the unique
index and the recent-estimates index, then **replace** Phase 0's policies: `drop policy expenditure_estimates_rw` → the spec's `_ro`;
`drop policy target_proposals_rw` → the spec's `_ro` + `_decide` (update only); revoke `insert, update, delete` on `expenditure_estimates` and
`insert, delete` on `target_proposals` from `authenticated`; `target_profiles` keeps Phase 0's `_rw` (the user authors targets) but every write
goes through `lib/server/targets.ts` so floors are re-applied. Functions (all `security definer`, `p_user_id` first): `approve_target_proposal
(p_user_id uuid, p_proposal_id uuid) returns jsonb` (one transaction: status → approved, insert `target_profiles` with `authored_by =
'engine_proposal'`, two `change_log` rows via `next_change_seq`; returns `{status:'conflict', current}` when already decided; execute granted to
`authenticated` — the RLS-scoped decide route calls it with the caller's id, and `_sync_assert_caller` guards it) and `upsert_expenditure_estimate
(p_user_id, p_row jsonb)` (`service_role` only). Down file drops the column, index, policies (restoring `_rw`) and both functions.

```ts
// lib/expenditure.ts — pure; ENGINE_VERSION = "exp-1.0.0"; seeds PRIOR_KCAL = 2130, BMR_KCAL = 1372 (targets.md)
export const MIN_ENERGY_COVERAGE = 0.95;  export const MIN_QUALIFIED_KCAL = 1000;   // ASSUMED (spec open question 3)
export type WeighIn = { date: string; kg: number };  export type IntakeDay = { date: string; kcal: number; energyCoverage: number };
export type ExpenditureStatus = "burn_in" | "held" | "estimating" | "blocked";
export type ExpenditureInput = { asOf: string; weighIns: WeighIn[]; intake: IntakeDay[]; priorKcal: number; bmrKcal: number };
export type ExpenditureResult = { status: ExpenditureStatus; tdeeKcal: number | null; weightTrendKg: number | null; intakeAvgKcal: number | null;
  intakeCompleteness: number; weighInCompleteness: number; qualifiedDays: number; weighInCount: number; confidence: number; reason: string | null; engineVersion: string };
export function isQualifiedDay(day: IntakeDay, asOf: string): boolean;
export function weightTrend(weighIns: WeighIn[], asOf: string): (number | null)[];      // 20-day EMA α = 2/21, 3-day interpolation, 2.5 % outlier hold-out
export function estimateExpenditure(input: ExpenditureInput): ExpenditureResult;         // §4.3 clamp order 1–7, byte-for-byte

// lib/targets/percent.ts — shared by client and server
export type MacroPercents = { proteinPct: number; fatPct: number; carbPct: number };
export type GramTargets = { proteinG: number; fatG: number; carbG: number };
export type MacroFloors = { kcalMin: number; proteinGMin: number; fatGMin: number; carbGMin: number };
export function percentToGrams(kcal: number, pct: MacroPercents): GramTargets;
export function applyFloors(kcal: number, grams: GramTargets, floors: MacroFloors): { kcal: number; grams: GramTargets; raisedToFloor: boolean };
export function validatePercentProfile(pct: MacroPercents, kcalTrain: number, kcalRest: number, floors: MacroFloors):
  { ok: true } | { ok: false; error: string; minProteinPct: number; minFatPct: number };
// protein_g_min = the active ramp stage's protein (lib/targets.ts RAMP_TABLE); fat_g_min = 50; kcal_min = 1650; carb_g_min = 0 (targets.md)

// lib/proposal.ts
export function buildProposal(args: { estimate: ExpenditureResult; active: TargetProfile }):
  | { kind: "proposal"; proposed: ProposedTargets } | { kind: "blocked"; reason: string } | { kind: "none"; reason: string };

// lib/api-types.ts — exactly the Phase 6 spec §"API changes" types (ExpenditureResponse, ProposalSummary, DecideRequest/Response,
// TargetsRequest/Response, JobResponse) plus TargetProfile (the row) and ProposedTargets (ProposalSummary["proposed"]).

// lib/server/expenditure.ts — R's get_expenditure_status reads latestEstimate
export async function runEstimate(admin: SupabaseClient, userId: string, asOf: string, deps?: { weighIns?: typeof weighInsKg }): Promise<ExpenditureResult>;
export async function latestEstimate(client: SupabaseClient, userId: string): Promise<ExpenditureResponse>;   // burn_in + nulls when no row
// lib/server/targets.ts — R's get_targets reads activeTargets
export async function activeTargets(client: SupabaseClient, userId: string): Promise<TargetsResponse | null>;  // null → the ramp (lib/targets.ts) is the target
export async function authorTargets(client: SupabaseClient, userId: string, req: TargetsRequest): Promise<TargetsResponse>;  // floors re-applied server-side
// lib/mcp/expenditure-tools.ts (reconciled: get_expenditure_status ships HERE, read-only; R's coach registry calls latestEstimate directly)
export function registerExpenditureTools(server: McpServer, ctx: { userId: string; admin: SupabaseClient }): void;
export const EXPENDITURE_TOOL_SCOPES: Record<"get_expenditure_status" | "get_targets", "read">;
```

Sync (Q owns `lib/sync/**` this wave): `target_profiles` and `target_proposals` join `Entity` and `ENTITIES` as **pull-only** entities (uuid
`id` keys; `NEVER_MERGED` gains `target_proposals`; the client never enqueues an op for either — `approve_target_proposal` writes their
`change_log` rows, and the SQL `_sync_*` helpers are **not** extended for them); `DB_VERSION = 4`. Client caches for offline render:
`localStorage` `smc:expenditure` and `smc:proposals` with an "as of" stamp; approval is online-only. Approver = Sasha only (ASSUMED, spec
open question 1). A second Sunday auto-rejects the older pending proposal on write (ASSUMED, open question 6). `goal_rate_bp_week` is Devin-only
in Settings (ASSUMED, open question 4). Jobs: `/api/jobs/estimate` (03:00 user tz) and `/api/jobs/weekly-proposal` (Sunday 21:00 user tz),
`Bearer $CRON_SECRET`, `ESTIMATOR_ENABLED` gate, `job_runs` lock from P's migration (reconciled: one lock table for every job — Q's job code
uses `('estimate', user_id, local_date)` and `('weekly-proposal', user_id, week_start)` keys; if P has not landed on the branch, Q's tests
create the table in a fixture). UI flag `NEXT_PUBLIC_ESTIMATOR_UI`.

## 4. Coach (R produces)

**Migrations (reconciled).** `20261001000000_phase7_coach.sql` ALTERs the Phase 0 tables: `coach_threads` + `kind text not null default 'chat'
check (kind in ('chat','weekly_review'))`, `rev integer not null default 1`, `last_message_at timestamptz`, `deleted_at timestamptz`, the two
indexes (incl. the one-weekly partial unique); `coach_messages` + `user_id uuid references auth.users(id)` (backfilled from the thread, then `not null`),
`deflected boolean not null default false`, `model_id text`, `ai_call_id uuid references ai_calls(id)`, `seq integer` (backfilled by `created_at`
order, then `not null` + `unique (thread_id, seq)`), `content` default `''`, `tool_calls`/`policy_checks` default `'[]'`; `constraint_profiles` +
`updated_at timestamptz not null default now()`. RLS is already the §2.1 pair on all three (Phase 0). **No `ai_calls` purpose migration** — the
column has no check; coach purposes are the adapter keys `coach` and `weeklyReview` (`lib/ai/adapter.ts MODELS`). `20261003000000_phase7_token_scopes.sql`:
`alter table api_tokens add constraint api_tokens_scopes_known check (scopes <@ array['read','log:write','constraints:write']::text[])` (Phase 0
had no constraint to drop). `lib/server/privileged.ts`: the `scope` parameter type becomes `"read" | "log:write" | "constraints:write"` — nothing else changes.

```ts
// lib/coach/registry.ts — static, 8 tools, exactly the spec §"Engines" ToolName union and CoachTool shape
export const REGISTRY: readonly CoachTool[];  export function lookupTool(name: string): CoachTool | undefined;
// lib/coach/executors.ts — (userId, args) closures; the ONLY module that touches I/O for tools. Ports it consumes (contract, not import-at-build):
//   get_day / get_week_totals → dayTotalsPrivileged (lib/server/log.ts, landed) · get_targets → activeTargets (Q) · get_expenditure_status → latestEstimate (Q)
//   search_foods → searchFoods (lib/server/catalog.ts, landed) · get_constraints → lib/server/constraints.ts · get_recent_gut_log → gut_log select (RLS)
//   draft_log_entry → builds a CoachDraft in memory; writes nothing.
export type ExecutorPorts = { dayTotals; weekTotals; activeTargets; latestEstimate; searchFoods; getConstraints; recentGut };  // injected; tests use doubles
// lib/coach/dispatch.ts, envelope.ts, deflect.ts, prompt.ts, turn.ts, floors.ts — exactly the spec §"Engines" signatures.
// lib/coach/policy.ts — checkItem / checkDraft as thin wrappers over lib/policy/constraints.ts evaluatePolicy (never a second policy implementation).
// lib/server/coach.ts
export async function runTurn(client, admin, userId, req: CoachTurnRequest, deps?: TurnDeps): Promise<CoachTurnResponse>;
export async function writeWeeklyReview(admin, userId, weekStart: string, deps?): Promise<{ threadId: string; messageId: string }>;  // Opus 5 via Nous (weeklyReview purpose)
// lib/server/constraints.ts
export async function getProfile(client, userId): Promise<{ profile: ConstraintProfile & { conditions: string[]; notes: string | null }; rev: number }>;
export async function putProfile(client, userId, req: ConstraintsPut): Promise<{ status: "ok"; profile; rev } | { status: "conflict"; current_rev; entity: "constraint_profiles"; value }>;
// floor: avoid_allergens ⊇ {gluten,dairy,apple} else HttpError(422, 'floor_violation', 'dairy')
// lib/mcp/coach-tools.ts
export function registerCoachTools(server: McpServer, ctx: { userId: string; admin: SupabaseClient }): void;  // get_constraints, set_constraints, list_coach_messages
export const COACH_TOOL_SCOPES: Record<"get_constraints" | "list_coach_messages", "read"> & Record<"set_constraints", "constraints:write">;
// lib/coach-client.ts
export function draftToProposeResponse(draft: CoachDraft, method?: "text"): ProposeResponse;   // "Log this" → CaptureSheet initialMode 'confirm' + initialDraft (wave-3 contracts §5)
```

Wire types `CoachTurnRequest`, `CoachSuggestion`, `CoachDraft`, `CoachTurnResponse`, `ConstraintsPut` exactly as the Phase 7 spec. Provider: Sonnet 5
via Nous Portal (`MODELS.coach`) with `gemini-3.8-flash` fallback, through `lib/ai/adapter.ts generateStructured` (the adapter's `nousCall` is
text-only: tool use is modelled as the structured `TurnStep` JSON the model returns each loop iteration — `planTurn` parses it; no provider-native
tool calling this wave). Until `docs/ai-data-handling.md` records the Nous retention answer, a turn whose context would include gut or condition
notes returns `503 nous_unconfirmed` **and** every other turn runs on Gemini: `runTurn` calls `generateStructured({ purpose: "coach",
provider: NOUS_RETENTION_CONFIRMED ? "nous" : "gemini", … })` — the `provider` override and `FALLBACK_MODELS.coach = "gemini-3.8-flash"`
are the wave-3 adapter contract (Phase 3–4 contracts §5, implemented by Lane M); `coachProvider()` returns the same value and the
`ai_calls` row records the provider actually used (contract change 2026-09-11, resolving the wave-4 fixer's open item). `constraint_profiles` is **not** outbox-synced
this wave (reconciled: `lib/sync/**` belongs to Q): `PUT /api/constraints` with `baseRev` CAS is the only write path; offline, the editor is disabled
with "needs a connection". Transcript cache: `localStorage` `smc:coach:<threadId>` (last 50 messages). The weekly review is R's own cron,
`/api/jobs/weekly-review` (Sunday 21:30 user tz, after Q's proposal job), gated by `COACH_ENABLED`; it reads `latestEstimate` and the week's
totals and writes into the pinned `weekly_review` thread. Coach = the fifth tab (integration edits `TabBar.tsx`). Flag `COACH_ENABLED` gates
routes (404) and the tab.

## 5. MCP and cron integration pattern (all three lanes)

`app/api/mcp/route.ts` is restructured **at integration** so tool bodies receive `{ userId, admin }` (today they are pinned to `SASHA_USER_ID`):
the handler is built per request inside `withTokenUser`, and each lane's `register<X>Tools(server, ctx)` is called there; `scopeForBody` merges
`WRITE_TOOLS` with the three `*_TOOL_SCOPES` maps. Each lane tests its register function against an in-memory `McpServer` from `mcp-handler`
(or `@modelcontextprotocol/server`, already installed) with a fake `admin`. `vercel.json` gains, at integration, the four cron lines the lanes
hand off (`oura-pull`, `estimate`, `weekly-proposal`, `weekly-review`) next to wave 3's `media-sweep`.

## 6. Flags and env

| Name | Where | Meaning |
|---|---|---|
| `HEALTH_INGEST_ENABLED` | server | unset → ingest/Oura routes 503, pull job no-ops, `/body` hidden |
| `HEALTH_TOKEN_KEY`, `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_REDIRECT_URI` | server | Phase 5; values in Vercel + `.env.local` only (already named in `.env.example`) |
| `ESTIMATOR_ENABLED` / `NEXT_PUBLIC_ESTIMATOR_UI` | server / build | Phase 6 jobs / cards |
| `COACH_ENABLED` | server + build (read at request time on the server; `NEXT_PUBLIC_COACH_ENABLED` for the tab) | Phase 7 |
| `CRON_SECRET`, `NOUS_API_KEY`, `NOUS_BASE_URL`, `GEMINI_API_KEY` | server | existing |

## 6a. Addenda landed 2026-09-11 (rulings record: `docs/decisions/2026-09-11-wave-3-4-rulings.md`)

- Lane R's injection corpus gains **≥ 10 must-deflect cases** (flare advice, steroids, "stop mesalamine", diagnosis or treatment questions phrased as nutrition questions) that fail CI on a false negative; over-refusal is reviewed after the gate, under-refusal never ships.
- Lane P's two-user denial proof on food, health, Oura and weight rows is a release gate before any biometrics are written to the shared project.
- Every ruling in the record (approver, thresholds, units, tabs, second proposal, no streaming, HAE) is binding for the lanes; the Oura app registration and the Nous retention record are Devin setup steps, not build gates.

## 7. Gates that are measured, never lowered

- Phase 5: seven consecutive days of steps, energy, sleep, weight on `/body` after Devin's phone setup; a second `oura-pull` for the same day
  changes no row (content hash); no plaintext token in any column.
- Phase 6: the three §4.3 backtests at their stated bounds, `scripts/backtest-estimator.ts` output committed; burn-in never ends on calendar time;
  protein never moves in a proposal; approve is one transaction, idempotent on a second call (409).
- Phase 7: registry = exactly 8 tools, 7 read; every corpus case (≥ 40) passes against the stub in CI; the live canary table is attached to the
  PR; `MEDICAL_DEFLECTION` byte-identical with zero model calls; `avoid_allergens` never below the floor through the route or MCP.
- All: cross-user denial on every new table, view, function, route and MCP tool for JWT and token callers.

## 8. Integration stage (after P, Q, R land; branch `feat/p5-7-integration`)

1. `app/api/mcp/route.ts` per §5; `vercel.json` crons; `app/settings/page.tsx` mounts the Body-data row + `HealthSourcesSheet`, `EstimatorCard`,
   `TargetModeSheet` entry, `WeightTrend`, `ConstraintsEditor`; `app/page.tsx` mounts `ProposalCard` and the weight chip; `components/TabBar.tsx`
   gains the Coach tab (five columns, 44 px targets); remove the unused `HEALTH_INGEST_TOKEN` env from Vercel.
2. Supabase branch: migrations 20260925–20261006, `pnpm test:integration` including the three phases' suites; the Oura PKCE canary (record in
   architecture §5.2); the coach live canary.
3. Devin's setup on the phone: issue an ingest token, install `docs/health-auto-export.md`, connect Oura; seven days of data before the Phase 5
   gate; estimator jobs on with the UI off for a week; coach flag after the injection gate.
4. `zs-land`; production flags per phase, in order 5 → 6 → 7.

## 9. Conventions

Phase 0 §8, Phase 1–2 §8a, Phase 3–4 §10 apply. Add: every job route is `enforceRateLimit` → timing-safe `CRON_SECRET` check → `job_runs` lock;
`null` is an absent observation and is never rendered as 0 or interpolated on a screen; every engine constant is a named export with a test that
fails when it changes; tool output enters a prompt only inside the untrusted envelope; the coach and the estimator never write a target.
