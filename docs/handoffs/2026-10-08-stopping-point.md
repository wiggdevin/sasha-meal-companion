# Stopping point — 2026-10-08

The Sasha orchestrator's handoff at the owner-requested stop. It records what landed on `main` today, where every unfinished lane is parked, prod state, and how to resume.

## Landed on main today

| PR | What |
|---|---|
| #21 | test(cards): inventory build-budget check behind `PERF=1` |
| #22 | fix(deps): 3 high-severity advisories |
| #23, #26, #27 | UI defect audits (Foods/Coach; Today/Body/Settings; Plan/Log/Scan/Week) |
| #24 | Blu, Button and Pod wear the shop's items |
| #25 | a superseded membership write settles quietly |
| #28, #33 | follow-ups batches A and B |
| #29 | W13 Favored rename, star merge, account move-over |
| #30 | W11 shopping focus + W10b |
| #31 | no account inherits the first client's Wednesday fasted 7am day type; target writers go through the service role |
| #32 | onboarding v2 question set (typed answers, pace chips, holds, delivery-gated save) |
| #34, #35 | meal cards v2 and v3 |
| #36 | onboarding: typed age/height/weight, slower food pile with "Just pick from the list", practices / foods-to-skip / cuisines questions |
| #37 | first-run "How Sasha works" tour from Sprout and Settings |
| #38 | PWA install: real Android Install, iOS Share guide, inline slot, never over meal cards |
| #39 | plan preview variety (starter deck by plate part), cuisine ranking, Today filled right after onboarding (null catalog link fix) |
| #41 | open world: no Eats allow-list gate for universe items, or for catalog foods when the account has no allergen rule or condition; universe food refs; Favorites copy; `OPEN_WORLD_USER_IDS` staged release |
| #42 | favorite meals backend (heart saves the plate and favors its foods) |
| #40 | Plan-sheet idea chips answered in code (`POST /api/plan/ideas`), no Gemini; Jev ranking with formula fallback |
| #43 | docs reconciliation: audit §3 doc fixes, dead GroundVideo/IcsSubscribe removed, `NEXT_PUBLIC_CHAT_ONBOARDING` documented, onboarding-as-built, rollout tracker |
| #44 | meal-card heart wired on Today (`useMealFavorites`) |
| #45 | Week link in Today's header, close control on Week, "Scanning isn't available yet" notice (dock updates, audit §2) |
| #46 | this handoff |

## Prod state

- **Onboarding flag:** `NEXT_PUBLIC_CHAT_ONBOARDING=0` in production. Prod serves the old 6-step onboarding. **Do not flip it** until the owner re-tests the onb3 rework (#36, #37, #39) on a phone.
- `TASTE_CHIPS_ENABLED=1`. `OPEN_WORLD_ENABLED` unset. With #41, releasing open world needs **both** `OPEN_WORLD_ENABLED=1` and `OPEN_WORLD_USER_IDS` (an id list, or `*` for everyone).
- `NOUS_API_KEY`, `NOUS_BASE_URL`, `NOUS_COACH_MODEL_ID`, `NOUS_REVIEW_MODEL_ID` were removed from Vercel production on 2026-10-08 (no code reads them).
- **Migrations applied today:**
  - `20261226090100`, `20261226090200` (fu-backend)
  - `20261227090100` (W13)
  - `20261227090000` (W11)
  - `20261228090000_target_writes_service_role_only`, applied 2026-10-08 23:52Z with a backup first; grants verified: authenticated=f, anon=f, service_role=t

  Receipts: `~/.claude/goal-state/sasha-phase18/proof/migrations.txt`.
- **Pending migration on main:** `20261229090000_client_timings_plan_chips` (from #40). It is safe on either side of the deploy; until it is applied, chip timing rows are rejected and nothing else breaks.
- **Migrations parked on wip branches, never applied:**
  - `20261229090000_delete_account` (`wip/2026-10-08-account-deletion`)
  - `20261229090000_voice_ears_cleanup` (`wip/2026-10-08-voice-retire-account-zone`)
  - **Both reuse the timestamp `20261229090000`**, which the idea-chips migration also uses. Renumber them before either lands.

## Unfinished lanes (all pushed, none merged)

| Branch | State | Next step |
|---|---|---|
| `wip/2026-10-08-duplicate-card` | "Logged twice? Keep both / Merge" card. Stopped mid guard-run, unreviewed. | Finish the guard suite, one Sol review, match the v4 card family (ivory shell, `--radius-lg`, text links). |
| `wip/2026-10-08-account-deletion` | Settings delete flow, `/api/account/delete`, `delete_account()` migration, behind `ACCOUNT_DELETION_ENABLED` (default off). Stopped mid-build, unreviewed. | Finish, review, renumber the migration. Apply the migration to prod before turning the flag on. |
| `wip/2026-10-08-voice-retire-account-zone` | Phase-14 retirement note, `voice_ears` cleanup migration, account-zone precedence and the two `it.todo` tests. Stopped in tests, unreviewed. | Finish, review, renumber the migration. |
| `wip/2026-10-08-app-hardening` | Security headers, `app/error.tsx` + `global-error.tsx`, vendor-free `/api/client-errors`, ExportCard copy, shopping-apply account-switch fix. **Sol BLOCK.** | **BLOCK:** crash reports can still carry free-text PII. Move to an allowlist of error codes and route patterns. **WARN:** the 4 KB cap is checked after the body is read. **WARN:** a partial shopping add has no Undo. |
| `wip/2026-10-08-down-migrations` | Down files for `20261023092000`, `20261126090000`, `20261210090100`. **Sol BLOCK.** | All three destroy data (they delete plan threads with their transcripts, delete `attach` timings, and break role-only writes). Redesign them to preserve data. |
| `feat/cards-redesign-v4` | Meal Cards lane: pass 1 of 4, unreviewed. **Do not merge.** | See `~/Inbox/notes/handoffs/2026-10-08-sasha-meal-cards.md`. |
| `wip/2026-10-08-onb2-p0-{chat,save,ui}`, `wip/2026-10-08-onb2-voice` | Older local onboarding-v2 branches, backed up only; most of their work has since landed. | Compare with main before reusing; delete if empty. |

## Owner items still open

1. Re-test the new onboarding on a phone, then say go. The orchestrator then sets `NEXT_PUBLIC_CHAT_ONBOARDING=1` and redeploys.
2. Open-world plate labels: regenerate the sheet as `docs/eval/universe-plates/sheet-1.1.0.csv` (`scripts/eval/universe-plates-sheet.ts`) now that cuisines shape plates (#39). The owner then marks each plate `y`/`n`, and the scorer checks ≥ 85 % per cuisine. Sheet 1.0.0 was withdrawn because all 12 cuisines produced identical plates.
3. Review the curated `CUISINE_STAPLES` table in `lib/meals/data/cuisine.ts` (hand-written in #39).
4. Rotate the secrets that an onboarding subagent printed into its own session output (the Supabase access token and other projects' DB URLs). They went to no file, commit or log.

## Reconciliation audit

The report is `~/Inbox/notes/2026-10-08-sasha-reconciliation-audit.md`. Its §3 doc fixes are in the docs-reconciliation PR, and the owner approved §2 on 2026-10-08. The owner's scope cut at stop kept only the Week entry and back/close, plus the scan notice.

Deferred:
- duplicate card, account deletion, voice retirement, timezone tests and app hardening (wip branches above);
- Coach Undo receipt restart with a server-minted write identity (not started);
- Phase 12 checked-writer RPC cutover (now unblocked by `20261228090000`);
- extending `test_reset_user` for the ~19 newer tables;
- the concurrent sign-up load test (#22, OPEN);
- the widget-save failure notice (#7, OPEN);
- Lighthouse / bundle-size CI;
- a full `script-src` CSP;
- the scan notice for accounts with coach disabled (#45 covers coach-enabled accounts).

## Resume

```sh
cd ~/projects/clients/Sasha/meal-companion
git fetch && git status -sb                      # main, clean, fast-forwarded
gh pr list --state open                          # anything still open from the stop
tail -20 ~/.claude/goal-state/sasha-orchestrator/landq.log
curl -s https://sasha-meal-companion.vercel.app/api/health
```

Rules:
- Run checks through `~/.claude/goal-state/sasha-orchestrator/bin/sasha-check` only (one vitest or tsc at a time; `--maxWorkers=2`).
- Never reset the shared local Supabase stack.
- No reviews or QA in EGO Lite; use headless Playwright.
- Push worktree branches with an explicit refspec (`git push origin B:B`).
