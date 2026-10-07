# Phases 5 + 6 + 7 — Body data, Estimator, Coach: Implementation Plan (master, wave 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each lane plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Her weight, steps, energy and sleep arrive daily from Health Auto Export and Oura with no effort after setup; 14 days of real intake and weight become an advisory expenditure number and one weekly one-tap target proposal that never lowers an authored floor; and a chat coach reads her day, week, targets and constraints through a fixed read-only tool set, proposes (never commits) a log entry, and stays inside that set when her own data carries an injection string.

**Architecture:** Three file-disjoint lanes branch from `main` after wave 3. P ships ingest (per-source tokens, privileged boundary), Oura OAuth + daily pull, the merged-day read path and the `/body` dashboard. Q ships the pure `lib/expenditure.ts` engine with its backtests, percent targets with the floor sequence, the two cron jobs, the proposal decide path and the four cards. R ships the static coach registry, envelope, deflection, policy wrappers, the turn loop, the constraints editor, the injection corpus and the live canary. MCP tools, crons, Settings, Today and the tab bar are wired at integration from each lane's hand-off.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, Tailwind 4 (DESIGN.md tokens), pnpm 11, Node 22, vitest 5, Supabase Postgres 17, `@google/genai` 2.21 (`gemini-3.8-flash`), Nous Portal (`anthropic/claude-sonnet-5`, `anthropic/claude-opus-5`), `zod` 4, `mcp-handler`. No new dependencies.

**Specs:** `docs/specs/phase-5-body-data.md`, `docs/specs/phase-6-estimator.md`, `docs/specs/phase-7-coach.md`. Contracts: `00-contracts.md` (this folder) + Phase 0, 1–2, 3–4 contracts. Numbers: `/Users/zero-suminc./projects/clients/Sasha/analysis/targets.md`. Reference (MIT, read-only): fud-ai review.

## Global Constraints
Phase 0 §8, Phase 1–2 §8a, Phase 3–4 §10 (TDD, conventional commits, no AI attribution, request-local clients, `user_id` from `auth.uid()` or the token/source row, rate-limit → identity → body, files < 400 lines, `null` ≠ `0`, provider text is data) plus: `null` is an absent observation and is never rendered as 0 or interpolated; every engine constant is a named export with a test; the engine and the coach never write a target; tool output enters a prompt only inside the untrusted envelope; every job route is rate-limit → timing-safe `CRON_SECRET` → `job_runs` lock; gates are measured and reported, never lowered.

## Bundle
| File | What |
|---|---|
| `00-contracts.md` | Ownership; health, estimator, coach contracts (reconciled with Phase 0's tables and RLS); MCP/cron integration pattern; flags |
| `lane-P-body-data.md` | Ingest RPCs + route, tokens, Oura OAuth + pull, merged-day read path, `/body` dashboard, HAE recipe |
| `lane-Q-estimator.md` | Engine + backtests, percent targets, jobs, proposals, decide, cards, pull-only sync entities |
| `lane-R-coach.md` | Registry, executors with ports, envelope, deflection, turn loop, routes, constraints editor, corpus, canary |
| `terminal-prompts.md` | Paste-ready prompts (`prompts/<lane>.txt` for `scripts/lane-terminal.sh`) |

## Start condition
`main` includes the wave-3 integration PR. A lane started earlier codes against `docs/plans/2026-09-11-phase-3-4/00-contracts.md` for wave-3 shapes and re-checks its anchors once wave 3 lands (the plans were written before wave 3 merged — expect small anchor drift in `lib/ai/adapter.ts`, `vercel.json` and `CaptureSheet`).

## Stage 1 — Three lanes in parallel (3 terminals)
Landing order **P → Q → R**; do not block a green lane on an earlier one — cross-lane executors are coded against contract signatures with test doubles.

| Terminal | Lane | Needs from others | Gives to others |
|---|---|---|---|
| P | Body data | nothing | `toCanonical`, `weighInsKg`, `mergedDays`, `Sparkline`, `job_runs` |
| Q | Estimator | P's `weighInsKg`/`toCanonical` (double until P lands) | `latestEstimate`, `activeTargets`, `authorTargets`, pull-only sync entities |
| R | Coach | Q's `latestEstimate`/`activeTargets` (ports with doubles); wave-3 `CaptureSheet initialDraft` | the coach, constraints editor, `constraints:write` scope |

## Stage 2 — Integration (`feat/p5-7-integration`, one terminal)
Exactly `00-contracts.md` §8: MCP route restructure + tool registration, crons, Settings/Today/TabBar mounts, branch tests, the Oura PKCE canary and the coach live canary, Devin's phone setup, `zs-land`, flags 5 → 6 → 7. P and R landed together in PR #45; Q's own integration wiring (MCP registration, crons, Settings/Today mounts) landed after, once Q (PR #42) was off draft — see `docs/decisions/2026-09-12-wave4-rulings.md` "Landing mechanics".

## Stage 3 — Devin flips production
`HEALTH_INGEST_ENABLED` after the seven-day gate; `ESTIMATOR_ENABLED` first (UI off, a week of estimates readable via `/api/expenditure`), then `NEXT_PUBLIC_ESTIMATOR_UI`; `COACH_ENABLED` + `NEXT_PUBLIC_COACH_ENABLED` after the canary table is on the PR. Rollbacks per each spec: flags off, crons removed, down migrations (observations and approved targets are never deleted).

## Verification matrix (acceptance criteria → lane)
| Spec | AC | Lane |
|---|---|---|
| P5 | 1 ingest writes event + samples · 2 duplicate payload = no change · 3 replay window 409 · 4 revoked token 401 before user reads · 5 partial payload applies valid rows · 7 idempotent oura-pull (hash) · 8 refresh rotates · 9 no plaintext token · 10 cross-user + MCP · 11 offline `/body` from cache, gaps not zeros · 12 unit files green | P |
| P5 | 6 seven days on `/body` (Devin's phone) | integration |
| P6 | 1–3 burn-in semantics + gated trend · 4 three backtests + committed table · 5 one proposal per user-week · 6–7 approve is one transaction, 409 on repeat · 8–9 floors and blocked · 10–11 percent round trip + 422 naming the minimum pct · 12 engine_version + constant tests · 13 cross-user · 14 offline card | Q |
| P7 | 1–5 registry, refusal recorded, no writes, schema walk, corpus in CI · 6–8 verdicts, deflection, allergen floor · 9–10 cross-user, messageId idempotent · 11 caps · 12 offline · 13 ai_calls rows · 14 canary table on the PR | R |
| all | `pnpm test`, `lint`, `build` green | every lane PR + integration |

## Decisions Devin owes (DECISION REQUIRED — lanes proceed on the ASSUMED value)
1. Closed 2026-09-12 — ruling 1 in `docs/decisions/2026-09-12-wave4-rulings.md`.
2. Closed 2026-09-12 — ruling 2 in `docs/decisions/2026-09-12-wave4-rulings.md`.
3. Closed 2026-09-12 — ruling 3 in `docs/decisions/2026-09-12-wave4-rulings.md`.
4. Closed 2026-09-12 — ruling 4 in `docs/decisions/2026-09-12-wave4-rulings.md`.
5. Closed 2026-09-12 — ruling 5 in `docs/decisions/2026-09-12-wave4-rulings.md`.
6. Closed 2026-09-12 — ruling 6 in `docs/decisions/2026-09-12-wave4-rulings.md`.
7. Closed 2026-09-12 — ruling 7 in `docs/decisions/2026-09-12-wave4-rulings.md`.
8. Closed 2026-09-12 — ruling 8 in `docs/decisions/2026-09-12-wave4-rulings.md`.
9. Closed 2026-09-12 — ruling 9 in `docs/decisions/2026-09-12-wave4-rulings.md`.
