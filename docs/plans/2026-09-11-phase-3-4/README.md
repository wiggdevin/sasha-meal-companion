# Phases 3 + 4 — Fast capture and AI capture: Implementation Plan (master, wave 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each lane plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Logging a packaged food, a repeated food, a saved recipe or a cup of water takes seconds (barcode → OFF/FDC cache, versioned recipes, favorites, water), and a typed, spoken, label-photo or plate-photo meal becomes a draft she checks and taps to save — with the catalog grounding every item and the constraint policy judging it.

**Architecture:** Five file-disjoint lanes branch from `main` (≥ PR #27). K ships the barcode path end to end (GTIN → `catalog_barcodes` → OFF/FDC cache-on-miss → scan and confirm sheets, `/scan` page). L adds the four synced entities (recipes, three favorites kinds), the water goal, the SQL sync extension and the Foods/Recipes screens. M builds the capture server (media sign/validate/sweep, `ai_calls` caps, propose → grounding → policy → draft, commit extensions, eval runner). N builds the one capture sheet and its four entry modes. O widens search recall with a synonym table so the blocked Phase 1 relevance gate can pass without touching the §4.1 score. Today's wiring (`app/page.tsx`, `QuickActions`, `LogFoodSheet`) is an integration-stage task with each lane's hand-off diff.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, Tailwind 4 (DESIGN.md tokens only), pnpm 11, Node 22, vitest 5, Supabase Postgres 17 + Storage, `zxing-wasm` (pre-lane), `@google/genai` 2.21 (`gemini-3.8-flash`, pinned), `zod` 4, `idb` 8.

**Specs:** `docs/specs/phase-3-fast-capture.md`, `docs/specs/phase-4-ai-capture.md`. Contracts: `00-contracts.md` (this folder) + the Phase 0 and Phase 1–2 contracts. Reference implementation (MIT, read-only): fud-ai — `~/Desktop/Sasha app/04-open-source-bases/E-fud-ai-review.md`.

## Global Constraints
Phase 0 §8 and Phase 1–2 §8a (TDD, conventional commits, no AI attribution, request-local clients, `user_id` from `auth.uid()`, rate-limit → identity → body order, files < 400 lines, `null` ≠ `0`) plus: no new npm dependencies beyond the pre-lane `zxing-wasm`; provider and model text is data, never instruction; no draft reaches `log_entries` without her tap; the only request-path writer of `catalog_*` is `lib/server/catalog-writer.ts`; every prompt is temperature 0 with a per-purpose `maxOutputTokens`; gates are measured and reported, never lowered.

## Bundle
| File | What |
|---|---|
| `00-contracts.md` | Ownership; barcode, sync-entity, policy, capture wire contracts; flags; recall lane; integration stage |
| `lane-K-barcode.md` | GTIN, quorum, OFF/FDC fetch + map, catalog writer, barcode route + cache, scan/confirm sheets, `/scan` |
| `lane-L-recipes-favorites-water.md` | Migrations (favorites tombstones, water goal, sync entities in SQL), sync client extension, engines, Foods/Recipes screens, export kinds |
| `lane-M-capture-server.md` | `ai_calls` caps + media bucket, adapter multimodal path, schemas/prompts, media validate/sign/sweep, propose + grounding + policy, commit extension, eval runner |
| `lane-N-capture-client.md` | CaptureSheet + Confirm, voice/photo capture, resize, drafts, method glyphs, offline behaviour |
| `lane-O-search-recall.md` | Synonym table + recall widening in `catalog_search`, query expansion, relevance re-measurement |
| `terminal-prompts.md` | Paste-ready prompts (`prompts/<lane>.txt` are the same text as files for `scripts/lane-terminal.sh`) |

## Start condition
`main` includes PR #27 and the pre-lane setup PR (zxing-wasm, `lib/capture/types.ts`, `lib/capture/flags.ts`, `lib/policy/constraints.ts`). Phase 0 release B (#18) may land before or after — no lane touches the legacy path.

## Stage 1 — Five lanes in parallel (up to 5 terminals; 3 = K+L, M+N, O)
All start together on fixtures. Landing order that keeps branch tests honest: **K, L, M, N**, O when green. Do not block a green lane on an earlier one.

| Terminal | Lane | Needs from others | Gives to others |
|---|---|---|---|
| K | Barcode | pre-lane `lib/policy/constraints.ts` | `/api/foods/barcode`, `catalog-writer`, scan + confirm sheets |
| L | Recipes / favorites / water | nothing (fixtures) | four synced entities, `user_settings.water_goal_cups`, export kinds, Foods strip |
| M | Capture server | pre-lane types/flags/policy; K's `catalog-writer` only for the label-food path (not required to land) | `/api/media/sign`, `/api/log/propose`, commit extensions, eval runner |
| N | Capture client | M's routes only through `lib/capture/types.ts` (a fake fetch in tests) | `CaptureSheet` and the hand-off diff |
| O | Search recall | a Supabase branch with the real import (the wave-2 branch or a fresh one) | `catalog_search` with synonyms; unblocks AC8 and Phase 4 grounding |

## Stage 2 — Integration (`feat/p3-4-integration`, one terminal)
Exactly `00-contracts.md` §9: wire Today (Scan + four capture actions, `WaterCard`, `FavoritesStrip` in the log sheet, `logWater()` rewired), branch tests, the two canaries (iOS audio container; OFF rate probe), preview with `NEXT_PUBLIC_FEATURE_SCAN=1` and `CAPTURE_METHODS=text`, Devin's phone gates, `zs-land`.

## Stage 3 — Devin flips production
One method per deploy: `text` → `voice` → `label` → `photo`, each after its 10-item eval and phone gate. Rollback = flag off (instant) or `CAPTURE_DAILY_HARD_CAP=0`; scan rollback = `NEXT_PUBLIC_FEATURE_SCAN` unset + redeploy. Migrations are additive.

## Verification matrix (acceptance criteria → lane)
| Spec | AC | Lane |
|---|---|---|
| P3 | 1 GTIN normalisation + 400 · 2 first scan writes one version/food/revision/barcode · 3 cached repeat makes no outbound call · 4 not_found + 7-day negative cache · 5 offline repeat from cache · 12 (ODbL on detail + CSV, with L) | K |
| P3 | 7 recipe edit = rev + 1, old revision and logs unchanged · 8 coverage < 1, never 0 for unmeasured · 9 favorites union · 10 water max on both devices and server · 11 cross-user denial on every Phase 3 table · 12 export kinds | L |
| P3 | 6 three packaged foods < 5 s (Devin's phone) | integration |
| P4 | 2 no draft persisted without commit · 4 foreign `mediaPath` = 403 · 5 every provider call writes an `ai_calls` row · 6 soft warning at 31, 429 at 101 · 7 schema-invalid → zero items, one row · 8 media deleted on commit / 24 h / provider `finally` · 9 blocked stays blocked · 10 server recomputes snapshots · 3 eval runner + report | M |
| P4 | 1 each method produces a draft and saves one entry (with M) · 11 offline disables the four actions · 12 44 px targets, design contract | N |
| P1 | 8 relevance ≥ 85 / 95 re-measured · 9 thresholds regenerated | O |
| all | `pnpm test`, `lint`, `build` green | every lane PR + integration |

## Decisions Devin owes (DECISION REQUIRED — lanes proceed on the ASSUMED value)
1. **`FDC_API_KEY`** — which vault id, and does the runtime reuse the import worker's key or get its own? (K builds with the env name; the value goes in Vercel + `.env.local`.)
2. **Negative-cache window** for unknown barcodes — ASSUMED 7 days.
3. **Daily capture caps** — ASSUMED soft 30 / hard 100 per local day; soft cap warns her in the sheet.
4. **Photo grams** — ASSUMED the grams stepper opens focused and `was_edited` stays false until she touches it.
5. **Label duplicates** — ASSUMED a second scan of the same brand + name reuses the first `user_foods` row.
6. **Nous retention** — still "unconfirmed — ask" in `docs/ai-data-handling.md`; Gemini serves every Phase 4 call until answered.
7. **Search relevance (AC8)** — Lane O is the proposed fix; approve landing it even if the gate is not fully met when it strictly improves both numbers.
8. Carried from wave 2: sizing sign-off, the 53-row mapping CSV, the phone check on the preview.
