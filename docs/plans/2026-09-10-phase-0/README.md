# Phase 0 — Foundations: Implementation Plan (master)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each lane plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a real identity, a multi-tenant schema, entity-level sync, a tested legacy migration, export/backup and a pinned AI adapter under the app — with no visible change for Sasha.

**Architecture:** Four file-disjoint lanes run in parallel on their own branches and land on `main` independently; an integration branch then wires the seams (layout, store switch, op emission, legacy deletion) and ships two releases (A: both paths live; B: cut-over). Shared interfaces are frozen in `00-contracts.md`.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, Tailwind 4, pnpm 11.25.0, Node 22, vitest 5, Supabase (Postgres 17, Auth, Storage, CLI 2.117), `@supabase/ssr` 0.12, `idb` 8, `@google/genai` 2.21, Zod 4, `tsx`, `fake-indexeddb`, Vercel.

**Spec:** `docs/specs/phase-0-foundations.md` (authority: `docs/architecture.md` v2.1 → spec → `00-contracts.md` → lane plans).

## Global Constraints
- TDD per task: failing test → run → minimal code → run → commit. Conventional commits (`type: subject`), no AI attribution lines.
- No module-level Supabase client except the lazy admin client in `lib/server/admin.ts`; `SUPABASE_SERVICE_ROLE_KEY` appears in exactly one source file.
- `user_id` never comes from a request body. Every route: `enforceRateLimit` → identity → `readJson`. Errors are `{ error, message }`; never echo the body.
- Every view `with (security_invoker = true)`. Every RPC `security definer`, `search_path = public`, `p_user_id` first.
- Files < 400 lines, functions < 50 lines. Before a PR: `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test <your files>`. Never the full suite twice.
- A lane edits only the files in its ownership row (`00-contracts.md` §1). A needed contract change lands in `00-contracts.md` first, as `docs: phase-0 contract change — <what>`.

---

## Bundle

| File | What |
|---|---|
| `00-contracts.md` | Frozen interfaces, file ownership, key encodings, fingerprint bytes, env names, pre-lane setup |
| `lane-A-database.md` | 16 tasks — migrations 000100–000600, RLS, RPCs, test helpers, RLS + apply_sync_op integration tests |
| `lane-B-auth.md` | 14 tasks — Supabase Auth, request-local client, privileged token boundary, rate limit, middleware, sign-in, AuthGate, MCP auth swap |
| `lane-C-sync.md` | 16 tasks — wire types, keys, merge rules, fingerprint, IndexedDB, outbox, pull/push, sync routes, SyncBootstrap/Status, two-client test |
| `lane-D-data-ops.md` | 16 tasks — units, legacy mapping, backfill + down + drop migrations, export, backup (route + launchd), AI adapter, canary |
| `lane-E-theme.md` | 8 tasks — NeuForm restyle from `DESIGN.md`: tokens, light ground, Arena gauge, Today, tab bar + sheets, Foods/Week/Settings, a11y + motion |
| `terminal-prompts.md` | Paste-ready ultracode prompts, one per terminal |

The four lane plans were cross-checked by a consistency critic (15 gaps: SDK major, zod JSON-schema, apply_sync_op ↔ outbox semantics, per-op route errors, cross-user HTTP tests, key encoding, fingerprint bucketing, spend cap, backup timer, tsx) and the fixes were applied before this bundle was committed.

---

## Stage 0 — Done on `main` (2026-09-10)
- [x] Deps installed: `@supabase/ssr`, `idb`, `@google/genai` 2.21, `supabase` CLI, `fake-indexeddb`, `tsx` (commits `e3cd2ba`, `3b94770` on `chore/p0-deps`, landing with this bundle).
- [x] Vercel env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `GEMINI_API_KEY`, `NOUS_*`, `CRON_SECRET`, `HEALTH_INGEST_TOKEN`, `AI_DAILY_SPEND_CAP_USD`.
- [x] Contracts frozen (`00-contracts.md`).

## Stage 1 — Five lanes in parallel (2–5 terminals)

Dependency truth: **unit work in B, C and D needs nothing from A** (they code against the contracts). Only the `[needs branch]` integration tests need Lane A's migrations on a Supabase branch. So all four lanes start at once; B/C/D run their branch tests after Lane A lands (or by cherry-picking A's `supabase/migrations/*` into their worktree — read-only use, never committed on their branch).

Recommended terminal split:

| Terminals | Assignment |
|---|---|
| 5 | one lane each (A, B, C, D, E) |
| 4 | A, B, C, D; E starts on whichever terminal frees first |
| 3 | T1 = A then D's migration tasks 8–11 after A lands; T2 = B; T3 = C, then D's tasks 1–7, 12–16 |
| 2 | T1 = A → B; T2 = C → D |

### Worktree + launch recipe (run once per lane, from `main`)

```bash
cd ~/projects/clients/Sasha/meal-companion && git checkout main && git pull --ff-only
git worktree add ../meal-companion-p0-A -b feat/p0-database main    # A
git worktree add ../meal-companion-p0-B -b feat/p0-auth     main    # B
git worktree add ../meal-companion-p0-C -b feat/p0-sync     main    # C
git worktree add ../meal-companion-p0-D -b feat/p0-data-ops main    # D
git worktree add ../meal-companion-p0-E -b feat/p0-theme    main    # E
```

In each worktree: `pnpm install --frozen-lockfile && cp ../meal-companion/.env.local .env.local`, then start Claude Code and paste:

```
ultracode. Execute docs/plans/2026-09-10-phase-0/lane-<X>-<name>.md end to end with
superpowers:subagent-driven-development. Read docs/plans/2026-09-10-phase-0/00-contracts.md first;
it is frozen — if a task needs a contract change, stop and report instead of changing it.
Only touch files in Lane <X>'s ownership row. TDD every task, conventional commits, no AI attribution.
Skip [needs branch] tests when SUPABASE_TEST_URL is unset and list them in the final report.
When the lane exit gate passes, run ~/bin/zs-land.
```

Lane exit gate (each plan's own section restates it): `pnpm lint`, `pnpm exec tsc --noEmit`, `pnpm test <lane files>` green; `[needs branch]` tests either green against a branch or listed as pending; PR body = task summary + test plan. `zs-land` opens the PR, waits for CI, squash-merges.

### Supabase branch for integration tests (Lane A Task 1 creates the script)

```bash
pnpm db:branch create p0          # scripts/db-branch.sh → prints SUPABASE_TEST_* for .env.local
pnpm db:reset                     # applies supabase/migrations + supabase/seed/test_helpers.sql
pnpm test:integration             # tests/**/*.test.ts, skipped when SUPABASE_TEST_URL is unset
```

Lane A lands first among the five (its PR unblocks everyone's branch tests). Lanes B, C, D land in any order; their files are disjoint, so no rebase is needed except `package.json` scripts (Lane A only).

## Stage 2 — Integration branch `feat/p0-integration` (one terminal, after all four land)

Each item is a task in the writing-plans format below. Files here are the ones no lane owned.

### Task I-1: Wire AuthGate and the new SyncBootstrap into the layout
**Files:** Modify `app/layout.tsx` — wrap `{children}` only; `Ground`, `ServiceWorkerRegistrar`, `InstallPrompt`, `SyncBootstrap`, `TabBar` stay outside.
**Interfaces:** Consumes `AuthGate` (Lane B), `SyncBootstrap` (Lane C).
- [ ] Write `app/layout.test.tsx`: renders `<AuthGate>` around children (snapshot of the tree order). Run → FAIL (component not in layout).
- [ ] Add `import AuthGate from "@/components/AuthGate"` and `<AuthGate>{children}</AuthGate>`. Run → PASS.
- [ ] `git commit -m "feat: gate the app shell behind supabase auth"`

### Task I-2: Store reads from IndexedDB, writes emit sync ops
**Files:** Modify `lib/store.ts`; Test `lib/store.test.ts` (extend).
**Interfaces:** Consumes `allRows()`, `enqueue()`, `encodeKey()` (Lane C); `lib/migrate/legacy.ts` field mapping (Lane D).
- [ ] Test: `loadStore()` returns rows from a fake IndexedDB seeded with one `user_foods` row and one `plan_days` row. Run → FAIL.
- [ ] Point `loadStore()` at `allRows()`; keep the localStorage blob as the first write. Run → PASS.
- [ ] Test: `updateDay('2026-09-12', {floorDay: true})` enqueues one op `{entity:'plan_days', entity_id:'2026-09-12', kind:'update'}`. Run → FAIL.
- [ ] Add one `enqueue()` per mutation (`updateDay`, `addExtra`, `updateExtra`, `removeExtra`, `setSlotNote`, `upsertFood`, `setFoodStatus`, `setFoodNote`) using the Lane D mapping for the payload. Run → PASS.
- [ ] `git commit -m "feat: read the store from indexeddb and emit sync ops on write"`

### Task I-3: Retire the legacy imports (release B only — keep on a separate commit)
**Files:** Modify `app/settings/page.tsx:11` (`SYNCED_EVENT` from `@/lib/sync/client`); Modify `app/api/mcp/route.ts` (remove the `SASHA_USER_ID` pin, `isConfigured()`, and the `@/lib/server/db` import; tools read the new tables through the `admin` client `withTokenUser` passes); Delete `lib/sync.ts`, `lib/sync.test.ts`, `app/api/sync/route.ts`, `lib/server/db.ts`; Modify `lib/server/admin.test.ts` expected array → `["lib/server/admin.ts"]`.
- [ ] Run `pnpm exec tsc --noEmit` → FAIL on the two dangling imports; fix; PASS.
- [ ] `rg SASHA_SYNC_TOKEN` → no matches. `git commit -m "refactor: delete the single-tenant sync path"` — **this commit ships only in release B.**

### Task I-4: Repo plumbing
**Files:** Modify `.env.example` (add `# --- Integration tests ---` block: `SUPABASE_TEST_URL`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_SERVICE_ROLE_KEY`, `SUPABASE_TEST_DB_URL`; retire `SASHA_SYNC_TOKEN`/`SASHA_MCP_TOKEN` in release B); Modify `package.json` scripts: add `"ai:canary": "tsx scripts/ai-canary.ts"`; Modify `.github/workflows/ci.yml` build env: add `NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=placeholder`; Modify `AGENTS.md` phase table (Phase 0 → in progress) and the Sync/MCP section.
- [ ] `pnpm build` locally with the CI env → PASS. `git commit -m "chore: phase 0 env, scripts and ci plumbing"`

### Task I-5: Release A gate
- [ ] `pnpm db:branch create p0-int && pnpm db:reset && pnpm test:integration` → all green, including every `[needs branch]` test from the four lanes.
- [ ] `pnpm ai:canary` → exit 0; `docs/ai-data-handling.md` updated with the date.
- [ ] `POST /api/jobs/backup` against the branch → `{ok:true, bytes>0}`; `scripts/restore-to-branch.sh` restores it.
- [ ] `zs-land` (PR "feat: phase 0 release A — auth, shadow schema, entity sync, export, backup, adapter"; **without Task I-3's commit and without `…000800_drop_legacy.sql`**).

## Stage 3 — Release A → backfill → Release B (Devin in the loop)

1. Release A is live. Sasha signs in with the magic link (first sign-in creates her `auth.users` row → that id becomes `SASHA_USER_ID` in Vercel + `.env.local`). `pnpm exec tsx scripts/mint-token.ts --scopes read,log:write` → paste the token into Codex.
2. **Manual gate A (Devin, phone):** food list, today's ticks, targets unchanged; airplane-mode tick + add food survive a reopen; laptop sees both after reconnect; revoked MCP token → 401; old `#k=` link signs nothing in.
3. `pnpm exec tsx scripts/migrate-legacy.ts` (dry run) → `docs/migration-unresolved.csv` must be header-only; Devin supplies gram weights for anything listed. Then `--apply` → count assertions pass.
4. **Manual gate B** on the migrated data (same checklist).
5. Release B: merge Task I-3's commit + `…000800_drop_legacy.sql`; retire `SASHA_SYNC_TOKEN`/`SASHA_MCP_TOKEN` from Vercel. Acceptance criterion 16 holds.
6. Rollback: before step 3 → revert the Vercel deployment; after step 3 and before 5 → `…000710_legacy_backfill_down.sql`; after 5 → restore the release-A backup into a branch, promote, redeploy A.

## Decisions Devin owes before Stage 3 (from the spec's open questions)
1. **SMTP for magic links** — Supabase built-in (rate-limited, fine for one user) or Resend/Postmark now? Default: built-in for Phase 0.
2. **Unresolved legacy units** — gram weights for any row in `docs/migration-unresolved.csv` after the dry run.
3. **Sign-off** on `plan_days`, `user_settings`, `gut_log`, `health_sources.kind='manual'` (already in the spec; confirm).
4. `.ics` subscription and share summary keep reading `lib/store.ts` — they follow the store switch in I-2 with no separate work; confirm no change expected.

## Verification matrix (acceptance criteria → where proven)
| AC | Proof |
|---|---|
| 1 | CI on each lane PR + integration PR |
| 2 | Manual gate A, step 2 |
| 3 | Lane B `lib/supabase/server.test.ts` (two calls → two clients) |
| 4 | Lane A `tests/rls/cross-user.test.ts` + Lane C `tests/sync/cross-user-http.test.ts` + Lane D `tests/export/cross-user.test.ts` + Lane B `tests/mcp/token.test.ts` |
| 5 | Lane A `tests/rls/security-invoker.test.ts` |
| 6 | Lane B `lib/server/admin.test.ts` (tightened in I-3) |
| 7 | Lane B `tests/mcp/token.test.ts` |
| 8, 9, 10 | Lane A `tests/rls/apply-sync-op.test.ts` + Lane C `tests/sync/two-client.test.ts` |
| 11 | Lane D `tests/migrate/rollback.test.ts` |
| 12 | Lane D `lib/export/csv.test.ts` + export route test |
| 13 | Lane D Task 13 + launchd task; I-5 |
| 14 | `pnpm ai:canary` (I-5) |
| 15 | `docs/ai-data-handling.md` (Lane D Task 16) |
| 16 | I-3 + `rg SASHA_SYNC_TOKEN` empty after release B |
