# Phases 1 + 2 — Catalog and Real Logging: Implementation Plan (master)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each lane plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Real USDA food data behind search, and every logged item carrying grams plus a frozen nutrient snapshot, so Today reports measured calories, macros, fibre and micronutrient coverage — with CSV export of it all.

**Architecture:** Four file-disjoint lanes branch from the `main` that carries Phase 0 release A. F imports the catalog (worker, off-Vercel); G serves the ranked search (SQL score mirrored in TypeScript); H owns the snapshot rule, `daily_totals`, the commit route and export streams; I puts search, grams and nutrients in front of Sasha behind a build-time flag. A short integration stage runs the real import on a branch, calibrates search, applies Devin's food mapping, and hands him a preview.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, Tailwind 4 (Lane E tokens), pnpm 11, Node 22, vitest 5, Supabase Postgres 17 (`pg_trgm`, `unaccent`), Python 3.12 + psycopg for the worker, `idb`, `zod`.

**Specs:** `docs/specs/phase-1-catalog.md`, `docs/specs/phase-2-real-logging.md`. Contracts: `00-contracts.md` (this folder) + `docs/plans/2026-09-10-phase-0/00-contracts.md`.

## Global Constraints
Phase 0 §8 (TDD, conventional commits, no AI attribution, request-local clients, `user_id` from `auth.uid()`, rate-limit → identity → body order, files < 400 lines) plus: every SQL function is either `security invoker` or `security definer` with `p_user_id` first — never both; `null` = not measured, `0` = measured zero, never coerced; no new npm dependencies; Lane I styles only with Lane E utilities; the catalog is public-domain USDA plus (later) ODbL OFF rows that never leave the app.

## Bundle
| File | What |
|---|---|
| `00-contracts.md` | Ownership, catalog columns and nutrient codes, `catalog_search` signature + score, wire types by reference, client cache shape, env |
| `lane-F-catalog-data.md` | Import worker, activation + Atwater SQL, grants, sizing dry run, her-foods mapping CSV |
| `lane-G-search.md` | `catalog_search` RPC, `lib/search/*`, search + detail routes, labelled set, calibration, mapping apply script |
| `lane-H-logging-server.md` | `compute_item_snapshot`, `daily_totals`, DRI seed, `lib/nutrients/*`, `lib/log/*`, commit route, export streams, MCP `get_day` |
| `lane-I-client.md` | Catalog search UI, log sheet grams, nutrient breakdown, DayNutrients, export card, offline catalog cache |
| `terminal-prompts.md` | Paste-ready ultracode prompts |

## Start condition
Phase 0 release A on `main` (five lanes + integration I-1, I-2, I-4, I-5). Release B (legacy deletion) may land before or after — these lanes do not touch the legacy path.

## Stage 1 — Four lanes in parallel (4 terminals; 2 = F→H, G→I)
All four start together against fixture rows. Landing order that keeps branch tests honest: **F, G, H, I** — but do not block a green lane on an earlier one; land as each gate passes. Lane G's relevance gate and Lane F's sizing sign-off are the two steps that need the real import.

| Terminal | Lane | Needs from others | Gives to others |
|---|---|---|---|
| F | Catalog data | nothing | rows for G's relevance eval, H's parity test, I's cache |
| G | Search | F's rows for the ≥ 85/95 gate only | `/api/foods/search`, `/api/foods/[id]`, `FoodSearchHit` |
| H | Logging server | nothing (fixtures) | `/api/log/commit`, `computeSnapshot`, `daily_totals`, export |
| I | Client | G and H route shapes (from contracts) | the screens |

## Stage 2 — Integration (`feat/p1-2-integration`, one terminal)
1. Supabase branch; real FDC import (`scripts/import-fdc.py`) — first the dry run (`docs/catalog/sizing.md`, headroom ≥ 40 %), then the branch.
2. `pnpm test:integration`: relevance gate (≥ 85 % top-1, ≥ 95 % top-3), snapshot parity, cross-user suites. On a relevance miss: `scripts/search-eval.ts` → commit `lib/search/thresholds.ts` → re-run.
3. Devin signs `docs/catalog/her-foods-mapping.csv` → `scripts/apply-food-mapping.ts` on the branch → all 53 foods carry `catalog_food_id` + `food_refs`.
4. `NEXT_PUBLIC_CATALOG_SEARCH=1` on Vercel **preview** only; Devin logs five real meals on the phone and checks numbers against fdc.nal.usda.gov with `scripts/verify-snapshots.ts`.
5. `zs-land` the integration branch.

## Stage 3 — Devin flips production
Import into production (same script, `CATALOG_IMPORT_DB_URL` of prod, one active version); set `NEXT_PUBLIC_CATALOG_SEARCH=1` in Vercel production; redeploy. Rollback = unset the flag + redeploy (client), `scripts/import-fdc.py --rollback-to <label>` (catalog).

## Verification matrix (acceptance criteria → lane)
| Spec | AC | Lane |
|---|---|---|
| P1 | 1 sizing + headroom · 2 import + one active version · 3 one active revision per food, idempotent reimport · 4 Atwater + mismatch rate | F |
| P1 | 5 search route codes · 7 `security invoker` proof · 8 relevance ≥ 85/95 · 9 calibrated thresholds committed · 10 53 foods mapped (apply) | G (10 with F's CSV + Devin) |
| P1 | 6 catalog RLS select-only | F |
| P1 | 11 flag unset = Phase 0 behavior · 12 offline fallback test | I |
| P2 | 1–4 snapshot, null/zero, edit recompute, `daily_totals` coverage · 8 commit replay/conflict · 9–10 CSV meals/progress · 11 cross-user · MCP `get_day` | H |
| P2 | 5 rings from snapshots · 6 fibre band + coverage pill · 7 offline entry then server snapshot | I |
| both | `pnpm test`, `lint`, `build` green | every lane PR + integration |

## Decisions Devin owes
1. Sizing sign-off after the dry run (keep FNDDS in, or move it to on-demand).
2. Review of `docs/catalog/her-foods-mapping.csv` (53 rows).
3. Phone check on the preview before the production flag.
