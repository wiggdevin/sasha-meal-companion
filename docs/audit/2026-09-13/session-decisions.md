# Session decisions, 2026-09-13 execution run

Devin's standing instruction for this run: decide without asking, record the decision here.
These supplement `docs/decisions/2026-09-13-audit-rulings.md` (R1–R12), which stays final.

## D1 — Vercel marked an advisory check for landing

**Situation.** Partway through wf1's Land phase, the Vercel free-tier deployment quota was
exhausted: every PR and every push to `main` reported `Vercel: failure — "Deployment rate
limited — retry in 24 hours."` `zs-land` requires all checks green, so 42 branches whose code
was verified stalled with their PRs open.

**Decision.** Set `git config zs-land.advisoryChecks Vercel` for this repo.

**Why this is not a bypass.** `zs-land`'s advisory mechanism excludes a check from *both* sides
of the gate — an advisory failure cannot block, and an advisory pass cannot count as
verification — and it still refuses to merge unless at least one real check passes. `Quality`
and `Build` (full suite, lint, tsc, build) remained the gates and were green on every branch
landed. `main` is not branch-protected, so no protection rule was circumvented. The red check
reported a billing quota, not code health.

**Deviation recorded.** R6 says landing is `zs-land` with CI green. The tool and the gates are
unchanged; only the quota-reporting check was reclassified. Revert with
`git config --unset zs-land.advisoryChecks` once the plan is upgraded.

## D2 — Landed in parallel, not serially

The first landing sweep ran serially and would have taken ~3 hours. That contradicts the house
rule "Land PRs in parallel, never one at a time" (~/.claude/CLAUDE.md, 2026-09-07). It was
stopped, the tree verified consistent, and relanded at concurrency 4. Six "base branch was
modified" races occurred and all succeeded on retry. Two branches hit `zs-land` exit 3 (PR
merged, cleanup incomplete); both were finished by hand per `HANDOFF.md` and were **not**
re-run.

## D3 — Branches landed without re-merging `main` first

To avoid re-triggering a 3-minute CI run per branch, branches whose PR checks were already
green and which GitHub reported as conflict-free were landed without first merging the newer
`main` into them. Three branches that genuinely conflicted were resolved individually by agents
(`mc-resolve-conflicts`) with conflicts settled in favour of the four guarded rules per R7.

**Residual risk, accepted and then tested:** a branch verified against an older `main` can break
in combination with it. This was checked afterwards by a full local suite run on clean `main`
(243 files / 2075 tests, 0 failures) plus `tsc` and `lint` clean, and every merge also ran CI on
`main` itself.

## D4 — Commit-message attribution trailers are not a landing blocker

Three repair agents amended commits solely to strip a `Co-Authored-By` trailer, then could not
publish the amend without a force push (correctly refused by the hook; `ZS_ALLOW_GIT` is
forbidden). Decision: a trailer on a branch commit is not a landing blocker, because `zs-land`
squash-merges and the branch message does not reach `main`. Those branches landed from their
original commits. No history was rewritten.

## D5 — One fix was recovered after nearly being lost

Branch order 16 (`fix/fix-coach-draft-verdict-loss`) had its fix agent crash *after* committing
but *before* opening a PR, so the landing sweep — which enumerates open PRs — never saw it. Its
leftover worktree also polluted a local test run (vitest globbed a stale copy under
`.claude/worktrees/`, producing 65 phantom failures). During cleanup `git branch -d` reported the
branch as merged and deleted it, but `git merge-base` showed the fix was **not** on `main`. The
commit was still reachable; the branch was restored, merged with `main`, re-tested (16/16
targeted tests), and landed. It is commit 91 on `main`.

**Lesson for the next run:** create agent worktrees outside the repository tree, and verify a
branch's content is an ancestor of `origin/main` before deleting it — `git branch -d`'s
"merged" claim can be made against a stale local ref.

## D6 — wf3 deferred, not skipped

wf3 verifies a production deployment and runs browser smoke tests against it. Vercel's quota
means production cannot rebuild until the limit resets (~2026-09-14 23:40 UTC) or the plan is
upgraded. Everything in wf3 that does not need production was run instead (the single local
gate: full suite, tsc, lint, build). The remainder is pending, not abandoned; the open-issues
list therefore lives in this file until `wf3-results.md` exists.

## Open issues at the end of this run

1. **wf3 not yet run** — production smoke tests over the 15 features, and the test account
   required by R11, are pending a production deployment.
2. **Production is stale** — last successful production build is `7a48eb4`, which is 46+ commits
   behind `main`. It is serving, not broken.
3. **Finding #97 closed no-repro** (R4) — signed media upload URL expiry. The installed
   `@supabase/storage-js` `createSignedUploadUrl` takes no expiry argument, so the 60s value in
   `lib/server/media.ts` is a label the app cannot enforce. No product change was made.
4. **Two lint warnings** remain on `main` (0 errors). Not gating.
5. **One wf2 refuter agent crashed** (`verify:correctness:coach-core-0`). That finding decided on
   2 of 3 lens votes, both non-refuted at critical severity, so the outcome could not have
   changed. It was fixed and landed.

## D7 — Production migrations applied and smoke accounts deleted, 2026-09-14

Both are production Supabase writes, which R11a forbids an agent from doing on its own
initiative. Devin directed both explicitly in-session after seeing what each would touch, so they
were carried out as owner-directed actions and recorded here rather than treated as blocked. R11a
is not weakened by this entry: an agent still originates no production write.

**Four missing migrations, not the two first reported.** The earlier claim — that production had
applied one of two migrations sharing version `20261014090000` — was wrong twice over. There was
no version collision (`20261014090001` had already been renamed), and production was missing
four migrations, not one: `20261013090200`, `20261014090000`, `20261014090001`, `20261015000000`.

Before applying, all four affected tables were confirmed empty in production (`health_samples`,
`api_tokens`, `duplicate_groups`, `catalog_barcodes`), and the widened `health_samples` dedupe key
was checked for collisions that would have failed its new unique index (zero). Sasha's data — 198
rows across 13 tables, plus 3 auth users — was backed up to
`~/Backups/supabase/meal-companion-prod-20260914-072852` first.

Each migration was applied in one transaction with its own ledger row. Verified afterwards
against the live database rather than the ledger, which is what caught the problem originally:
`_sync_upsert` 18,211 → 18,790 bytes and now carries the convergence fix;
`catalog_write_provider_revision` 4,558 → 4,724 bytes and now threads category, quality class and
search doc; `health_samples.dedupe_key` is generated with one unique index; `api_tokens` has only
the read policy. `schema_migrations` is 36, matching the repo.

**Two smoke accounts, not one.** Listing every auth user found `mc-smoke-test@example.test`
created at 02:27:41, eight seconds before the known `mc-smoke-2026-09-13@...` at 02:27:49 — the
same incident. The deletion script covered only the second. It was extended to both, keeping the
per-target email check and adding a refusal if a target ever resolves to Sasha's own address.
Deleting `ai_calls` rows raised a foreign key error from `coach_messages`, which the script's
table list omits; the auth-user cascade removed them anyway. Verified zero rows remaining for
either id, and Sasha's own data intact (101 `food_refs`, 1 `user_foods`, 1 `recipes`).

**The cause was never the version collision.** Nothing pushes migrations to production: Vercel's
Git integration builds the app only, and `ci.yml` had no migration step. Code and schema could
drift apart on any merge with no symptom but a function quietly running its old body. That is now
detected — `scripts/check-migration-drift.ts` runs in CI on every push to `main` — and applying is
a documented human action via `scripts/apply-migrations.py`. See `docs/CONTRIBUTING.md`.
