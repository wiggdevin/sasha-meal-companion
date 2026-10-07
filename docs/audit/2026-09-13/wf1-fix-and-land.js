export const meta = {
  name: 'mc-fix-and-land',
  description: 'Fix every approved audit branch (TDD, worktree per branch), review, then land each via zs-land',
  phases: [
    { title: 'Fix', detail: 'one worktree agent per branch: failing test, fix, targeted tests, lint, tsc, commit, push' },
    { title: 'Review', detail: 'per branch: reviewer, then one repair pass if blockers' },
    { title: 'Land', detail: 'per branch: merge origin/main, targeted tests, zs-land (waits CI, squash-merges)' },
  ],
}

// Usage (from the repo root, ultracode on):
//   Workflow({ scriptPath: 'docs/audit/2026-09-13/wf1-fix-and-land.js',
//              args: { repo: '<abs repo path>', only: [] } })
// args.only: optional list of branch order numbers to run (empty = all 70).
// Resume after a stop: pass resumeFromRunId; finished agents replay from cache.

const REPO = args.repo
const AUDIT = `${REPO}/docs/audit/2026-09-13`
const ONLY = Array.isArray(args.only) && args.only.length ? new Set(args.only) : null

// ---- rulings every agent must obey (see docs/decisions/2026-09-13-audit-rulings.md) ----
const RULES = `Rulings (final, no questions):
R1 All 70 branches are approved. Do not ask for approval.
R2 Never change a calorie or macro number. ../analysis/targets.md owns them. If a fix needs a number, read it from lib/targets.ts or lib/meals.ts SLOT_TARGETS; never edit those values.
R3 DESIGN.md is the contract and is not edited. Finding #72 (branch fix-mealcard-design-contract-drift): apply the existing DESIGN.md meal-card tokens from app/design-tokens.css; do not change DESIGN.md or the token export.
R4 TDD gate: write the failing test first. If after two honest attempts you cannot make a test fail on main for this finding, the finding is no-repro: do not change product code, return status "no-repro" with what you tried. Findings listed in docs/audit/2026-09-13/unreproduced.json are the likely no-repro candidates; treat them the same way.
R5 Never run the full suite (pnpm test) inside a fix agent. Run only the test files you touched, plus pnpm lint and pnpm exec tsc --noEmit. CI runs the full suite once on the PR.
R6 No production Supabase writes. No vercel --prod. No migrations that drop or rewrite data; a new migration must ship with a down file under supabase/migrations/down/.
R7 Keep the four guarded rules green: no apple/gluten/dairy anywhere; Avoid foods never planned; calorie change never moves protein; every date renders a complete day.
R8 Conventional commit, one commit per branch, subject "fix: <what>" (or "test:"/"ci:"/"chore:" when that is what it is). No attribution trailers.
R9 Do not edit docs/audit/**. Do not touch files outside the branch's scope unless the fix requires it, then say so in the result.
R10 Simplicity first. The minimal change that makes the failing test pass and does not break neighbours. No refactors of adjacent code.`

const FIX_SCHEMA = { type: 'object', properties: {
  status: { type: 'string', enum: ['fixed', 'no-repro', 'blocked'] },
  branch: { type: 'string' },
  worktree: { type: 'string' },
  commit: { type: 'string' },
  testFiles: { type: 'array', items: { type: 'string' } },
  filesChanged: { type: 'array', items: { type: 'string' } },
  summary: { type: 'string' },
  notes: { type: 'string', description: 'for no-repro: what you tried; for blocked: the exact blocker' },
}, required: ['status', 'branch', 'summary', 'notes'] }

const REVIEW_SCHEMA = { type: 'object', properties: {
  verdict: { type: 'string', enum: ['ship', 'ship-with-fixes', 'do-not-ship'] },
  blockers: { type: 'array', items: { type: 'string' } },
  nits: { type: 'array', items: { type: 'string' } },
}, required: ['verdict', 'blockers', 'nits'] }

const LAND_SCHEMA = { type: 'object', properties: {
  status: { type: 'string', enum: ['landed', 'pr-open', 'failed'] },
  pr: { type: 'string' },
  notes: { type: 'string' },
}, required: ['status', 'notes'] }

// branches.json is read by each agent; the script only needs the index list.
const ALL = Array.from({ length: 70 }, (_, i) => i + 1)
const TODO = ONLY ? ALL.filter(n => ONLY.has(n)) : ALL
log(`Running ${TODO.length} of 70 branches`)

const results = await pipeline(
  TODO,
  // ---- Fix ----
  (order) => agent(`You are fixing one audit branch in ${REPO}. You are inside a fresh git worktree of main; work only here.

Step 1. Read ${AUDIT}/branches.json and find the entry with "order": ${order}. Note its slug, findings (numbers), files and rationale.
Step 2. Read ${AUDIT}/findings-full.json and pull the objects whose "n" is in that list (search for '"n": <number>'). Each has file, line, evidence, scenario, impact, fix, testGap, and the three refuter votes.
Step 3. git checkout -b fix/<slug>.
Step 4. TDD: write the failing test first in the existing test location for that module (lib/*.test.ts beside the source, or tests/<area>/). Run only that file: pnpm exec vitest run <file>. It must fail for the reason the finding describes. Then implement the minimal fix. Run the file again, green. Run pnpm lint and pnpm exec tsc --noEmit.
Step 5. git add the files you changed, one conventional commit. git push -u origin fix/<slug>.
Step 6. Return the result. Include the worktree path (pwd) and commit sha.

${RULES}`, { label: `fix:${order}`, phase: 'Fix', isolation: 'worktree', effort: 'high', schema: FIX_SCHEMA }),

  // ---- Review + one repair pass ----
  async (fix, order) => {
    if (!fix || fix.status !== 'fixed') return { fix, review: null }
    const serverish = /server-auth|sync/.test(await branchArea(order))
    const review = await agent(`Review branch ${fix.branch} in ${REPO} against main. Run: git fetch origin ${fix.branch} && git diff origin/main...origin/${fix.branch}. Read the changed files in full. Judge: does the new test actually fail without the fix (read it, reason about it); does the fix respect the rulings below; does it break neighbours; is it minimal. ${serverish ? 'This branch touches auth, server, or sync: check for token or key exposure, RLS bypass, unbounded input, rate-limit holes, and lost writes.' : ''} Return blockers only for things that must change before merge.

${RULES}`, { label: `review:${order}`, phase: 'Review', schema: REVIEW_SCHEMA, model: 'sonnet', agentType: serverish ? 'security-reviewer' : undefined })
    if (!review || review.verdict === 'ship' || !review.blockers.length) return { fix, review }
    const repair = await agent(`Repair branch ${fix.branch} in ${REPO}. Create your own worktree: git worktree add /tmp/mc-repair-${order} ${fix.branch} && cd /tmp/mc-repair-${order} && git pull origin ${fix.branch}. Address every blocker below, keep the failing-test-first discipline, run the touched test files, pnpm lint, pnpm exec tsc --noEmit, then commit ("fix: address review") and git push. Then cd ${REPO} && git worktree remove /tmp/mc-repair-${order} --force.

Blockers:
- ${review.blockers.join('\n- ')}

${RULES}`, { label: `repair:${order}`, phase: 'Review', effort: 'high', schema: FIX_SCHEMA })
    return { fix: repair && repair.status === 'fixed' ? { ...fix, ...repair } : fix, review, repaired: !!repair }
  },

  // ---- Land ----
  async (r, order) => {
    if (!r || !r.fix || r.fix.status !== 'fixed') return { order, ...(r || {}), land: null }
    const land = await agent(`Land branch ${r.fix.branch} of ${REPO}. Do this in a linked worktree so the main checkout is never switched:
1. cd ${REPO} && git fetch origin && git worktree add /tmp/mc-land-${order} ${r.fix.branch} && cd /tmp/mc-land-${order} && git pull origin ${r.fix.branch}
2. git merge origin/main (a merge, never a rebase, never a force push). If there are conflicts, resolve them keeping both intents; the four guarded rules win any tie. Commit the merge.
3. Run only the test files this branch touched (see below), plus pnpm lint and pnpm exec tsc --noEmit. Fix and commit if red.
4. git push, then run ~/bin/zs-land. It opens the PR, waits for CI, squash-merges, deletes the branch, removes this worktree, and syncs main. If zs-land exits 1 because CI failed: read the failing check with gh, rerun ONLY the failing spec locally, fix, commit, push, run zs-land again. Two attempts maximum. If zs-land exits 3, stop and report exactly what it printed.
5. If the worktree still exists afterwards: cd ${REPO} && git worktree remove /tmp/mc-land-${order} --force.
Test files touched: ${(r.fix.testFiles || []).join(', ') || 'see git diff origin/main...HEAD'}.
Never run the full suite locally; CI is the full run. No ZS_ALLOW_GIT. Return landed, pr-open, or failed with the PR URL.`, { label: `land:${order}`, phase: 'Land', effort: 'medium', schema: LAND_SCHEMA })
    return { order, ...r, land }
  },
)

async function branchArea(order) {
  // cheap lookup without filesystem access: ask nothing, infer from the ordered list in branches.json via a tiny agent is wasteful,
  // so the areas are inlined here (kept in sync with branches.json).
  const AREAS = { 40: 'server-auth', 41: 'server-auth', 67: 'server-auth', 6: 'sync', 7: 'sync', 8: 'sync', 20: 'sync', 21: 'sync', 22: 'sync', 23: 'sync', 42: 'sync', 43: 'sync', 68: 'sync' }
  return AREAS[order] || 'other'
}

const done = results.filter(Boolean)
const landed = done.filter(r => r.land && r.land.status === 'landed').map(r => r.order)
const prOpen = done.filter(r => r.land && r.land.status === 'pr-open').map(r => r.order)
const failed = done.filter(r => r.land && r.land.status === 'failed').map(r => r.order)
const noRepro = done.filter(r => r.fix && r.fix.status === 'no-repro').map(r => ({ order: r.order, notes: r.fix.notes }))
const blocked = done.filter(r => r.fix && r.fix.status === 'blocked').map(r => ({ order: r.order, notes: r.fix.notes }))
log(`landed ${landed.length}, pr-open ${prOpen.length}, failed ${failed.length}, no-repro ${noRepro.length}, blocked ${blocked.length}`)

phase('Record')
await agent(`Write ${AUDIT}/wf1-results.md in ${REPO} (this is the one file you may create; commit it on a branch chore/audit-wf1-results and land it with ~/bin/zs-land). Content: a table of every branch order with slug, fix status, review verdict, land status and PR URL; then a "No-repro" section quoting each agent's notes; then "Blocked" and "Failed" sections with notes. Data: ${JSON.stringify(done.map(r => ({ order: r.order, branch: r.fix && r.fix.branch, fix: r.fix && r.fix.status, review: r.review && r.review.verdict, land: r.land && r.land.status, pr: r.land && r.land.pr, notes: (r.fix && r.fix.status !== 'fixed' ? r.fix.notes : '') || (r.land && r.land.status !== 'landed' ? r.land.notes : '') })))}`, { label: 'record', phase: 'Record', effort: 'low' })

return { landed, prOpen, failed, noRepro, blocked }
