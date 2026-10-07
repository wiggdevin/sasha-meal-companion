export const meta = {
  name: 'mc-gap-round',
  description: 'Fifth audit round over the six areas the critic found unread, verified 3-lens, then fixed and landed the same way as wf1',
  phases: [
    { title: 'Find', detail: 'six gap finders, read-only' },
    { title: 'Verify', detail: 'three refuters per finding, xhigh' },
    { title: 'Fix', detail: 'one worktree agent per confirmed finding' },
    { title: 'Land', detail: 'merge main, targeted tests, zs-land' },
  ],
}

// Usage: Workflow({ scriptPath: 'docs/audit/2026-09-13/wf2-gap-round.js', args: { repo: '<abs repo path>' } })
// Run AFTER wf1 has landed. Reads docs/audit/2026-09-13/gaps.json for the six areas.

const REPO = args.repo
const AUDIT = `${REPO}/docs/audit/2026-09-13`

const READ_ONLY = `You are auditing ${REPO} on main. READ-ONLY: no edits, no state-changing git, no full test suite, no production Supabase writes. Every finding needs file:line evidence, a concrete failure scenario, why it matters for Sasha (one person, phone-first PWA, ulcerative colitis, no gluten/dairy/apple), and a minimal fix. No style nits. Severity: critical (data loss, safety rule broken, auth bypass), high (wrong numbers, sync loss, silent failure on a main path), medium, low.`

const RULES = `Rulings (final): all confirmed findings here are approved to fix. Never change a calorie or macro number (../analysis/targets.md owns them). DESIGN.md is not edited. TDD gate: failing test first; if you cannot make a test fail on main after two honest attempts, return status "no-repro" and change no product code. Run only the touched test files plus pnpm lint and pnpm exec tsc --noEmit; never pnpm test. No production Supabase writes, no vercel --prod, new migrations ship with a down file. Keep the four guarded rules green. One conventional commit per branch, no attribution trailers. Minimal change, no adjacent refactors.`

const FINDINGS_SCHEMA = { type: 'object', properties: {
  findings: { type: 'array', items: { type: 'object', properties: {
    title: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    file: { type: 'string' }, line: { type: 'integer' }, evidence: { type: 'string' }, scenario: { type: 'string' },
    impact: { type: 'string' }, fix: { type: 'string' }, testGap: { type: 'string' },
  }, required: ['title', 'severity', 'file', 'line', 'evidence', 'scenario', 'impact', 'fix'] } },
  coverageNotes: { type: 'string' },
}, required: ['findings', 'coverageNotes'] }

const VERDICT_SCHEMA = { type: 'object', properties: {
  refuted: { type: 'boolean' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, reason: { type: 'string' },
  correctedSeverity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, evidence: { type: 'string' },
}, required: ['refuted', 'confidence', 'reason', 'correctedSeverity', 'evidence'] }

const FIX_SCHEMA = { type: 'object', properties: {
  status: { type: 'string', enum: ['fixed', 'no-repro', 'blocked'] }, branch: { type: 'string' }, commit: { type: 'string' },
  testFiles: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' }, notes: { type: 'string' },
}, required: ['status', 'branch', 'summary', 'notes'] }

const LAND_SCHEMA = { type: 'object', properties: {
  status: { type: 'string', enum: ['landed', 'pr-open', 'failed'] }, pr: { type: 'string' }, notes: { type: 'string' },
}, required: ['status', 'notes'] }

const GAPS = [
  { key: 'auth-code', brief: 'Read lib/server/auth.ts, lib/supabase/client.ts and server.ts, app/auth/callback/route.ts, app/sign-in/{page,code,password}.ts, components/AuthGate.tsx, PasswordSignInForm.tsx, SignInCodeForm.tsx, middleware.ts, app/api/dev/sign-in. Hunt for session fixation, open redirects, dev sign-in reachable in production, code brute force without rate limit, cookies without secure/httpOnly/sameSite, gate bypass on client routes, and error paths that leave her signed out without a message.' },
  { key: 'privileged-boundary', brief: 'Read line by line lib/server/privileged.ts, tokens.ts, health-tokens.ts, admin.ts, crypto.ts, ratelimit.ts, http.ts, and the migrations 20260911000400_privileged and 20261003000000_phase7_token_scopes. Hunt for service-role use on user paths, token scope escalation, weak crypto or IV reuse, secrets in logs, rate limiter keyed on spoofable input, and privileged routes callable without the right secret.' },
  { key: 'recipes-build-meal', brief: 'Read components/BuildMealSheet.tsx, RecipeSheet.tsx, RecipeDraftList.tsx, RecipeFoodRow.tsx, RecipeFoodSearch.tsx, RecipeIngredientPicker.tsx, RecipeItemRow.tsx, lib/recipes/*, lib/foods/adopt-client.ts, lib/scaling.ts as used by them. Hunt for portion sizing that moves protein, per-serving math errors, banned foods reachable through recipe ingredient search, Avoid foods offered, and saves that lose data.' },
  { key: 'body-dashboard', brief: 'Read components/BodyDashboard.tsx, BodyDataCard.tsx, BodyProfileFields.tsx, BodyTodayCard*.tsx, HealthMetricCard.tsx, WeightTrend.tsx, Sparkline.tsx, lib/health/capability.ts, contract.ts, replay.ts, today-card.ts, units.ts. Hunt for wrong units shown, stale or mismatched data rendered as current, NaN or undefined rendered, timezone shifts on the day boundary, and loading states that show zeros as facts.' },
  { key: 'barcode-core', brief: 'Read lib/barcode/quorum.ts, gtin.ts, scan-cache.ts, worker.ts, lib/catalog/off.ts, fdc.ts, fdc-map.ts. Hunt for quorum votes that accept a wrong decode, GTIN check-digit errors, cache serving a stale or other-product verdict, source mappers that drop allergen or ingredient fields, and worker errors swallowed.' },
  { key: 'coach-core', brief: 'Read lib/coach/turn.ts, dispatch.ts, policy.ts, deflect.ts, registry.ts, prompt.ts, weekly-review.ts and app/api/coach/*. Hunt for a turn that can bypass policy checks, tool calls that write without her confirmation, category or allergen fields hardcoded null, prompt injection from food names or notes, and coach actions that could change a targets.md-owned number.' },
]

const key = f => `${f.file}::${f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`
const seen = new Set()
const LENSES = ['correctness', 'reproduction', 'impact']

const confirmed = (await pipeline(
  GAPS,
  g => agent(`${READ_ONLY}\n\nDimension: ${g.key}. ${g.brief}\n\nReturn every distinct finding with evidence.`, { label: `find:${g.key}`, phase: 'Find', schema: FINDINGS_SCHEMA, model: 'sonnet', effort: 'high' }),
  async (res, g) => {
    if (!res) return []
    const fresh = res.findings.filter(f => !seen.has(key(f)))
    fresh.forEach(f => seen.add(key(f)))
    const judged = await parallel(fresh.map((f, i) => async () => {
      const votes = (await parallel(LENSES.map(lens => () => agent(`${READ_ONLY}\n\nYou are an adversarial refuter. REFUTE this finding; default refuted=true if you cannot confirm it with evidence. Lens: ${lens}${lens === 'reproduction' ? ' (construct the scenario; run a single vitest file or a tsx snippet in the scratchpad if that proves or disproves it)' : ''}.\n\n${JSON.stringify(f)}`, { label: `verify:${lens}:${g.key}-${i}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'xhigh' })))).filter(Boolean)
      const keep = votes.filter(v => !v.refuted)
      return keep.length >= 2 ? { ...f, gap: g.key, severity: keep.map(v => v.correctedSeverity).sort((a, b) => ['low', 'medium', 'high', 'critical'].indexOf(b) - ['low', 'medium', 'high', 'critical'].indexOf(a))[0] } : null
    }))
    return judged.filter(Boolean)
  },
)).filter(Boolean).flat()

log(`Gap round: ${confirmed.length} confirmed finding(s) across ${GAPS.length} areas`)

const landed = await pipeline(
  confirmed.map((f, i) => ({ ...f, i: i + 1, slug: `gap-${f.gap}-${i + 1}` })),
  f => agent(`You are fixing one confirmed audit finding in ${REPO}, inside a fresh worktree of main.\n\nFinding: ${JSON.stringify(f)}\n\ngit checkout -b fix/${f.slug}. TDD: failing test first, minimal fix, touched test files green, pnpm lint, pnpm exec tsc --noEmit. One conventional commit. git push -u origin fix/${f.slug}.\n\n${RULES}`, { label: `fix:${f.slug}`, phase: 'Fix', isolation: 'worktree', effort: 'high', schema: FIX_SCHEMA }),
  async (fix, f) => {
    if (!fix || fix.status !== 'fixed') return { f, fix, land: null }
    const land = await agent(`Land branch ${fix.branch} of ${REPO} from a linked worktree: git fetch origin && git worktree add /tmp/mc-land-${f.slug} ${fix.branch} && cd /tmp/mc-land-${f.slug} && git pull origin ${fix.branch} && git merge origin/main (resolve conflicts, guarded rules win) → run only the touched test files (${(fix.testFiles || []).join(', ')}), pnpm lint, pnpm exec tsc --noEmit → git push → ~/bin/zs-land. On CI failure: rerun only the failing spec locally, fix, push, zs-land again, two attempts max. Never the full suite locally, never a force push, no ZS_ALLOW_GIT. Remove the worktree if zs-land left it.`, { label: `land:${f.slug}`, phase: 'Land', effort: 'medium', schema: LAND_SCHEMA })
    return { f, fix, land }
  },
)

const out = landed.filter(Boolean)
await agent(`Write ${AUDIT}/wf2-results.md in ${REPO} (only file you may create; commit on chore/audit-wf2-results and land with ~/bin/zs-land): a table of gap findings with title, file:line, severity, fix status, land status, PR; then No-repro and Failed sections with notes. Data: ${JSON.stringify(out.map(r => ({ title: r.f.title, file: `${r.f.file}:${r.f.line}`, severity: r.f.severity, fix: r.fix && r.fix.status, land: r.land && r.land.status, pr: r.land && r.land.pr, notes: (r.fix && r.fix.notes) || (r.land && r.land.notes) || '' })))}`, { label: 'record', phase: 'Land', effort: 'low' })

return { confirmed: confirmed.length, landed: out.filter(r => r.land && r.land.status === 'landed').length, results: out.map(r => ({ title: r.f.title, fix: r.fix && r.fix.status, land: r.land && r.land.status })) }
