# WF3 — Production Verify Results (2026-09-13)

## Gate results

| Check | Result |
|---|---|
| Build | pass |
| Lint | pass |
| Type check (tsc) | pass |
| Test | pass |
| Failing checks | none |

## Deployment state

- URL: https://sasha-meal-companion.vercel.app
- SHA: `4cd75057b8d20391bcb59872d38e1e968c4d72cf`
- State: **UNVERIFIED** — could not confirm production status. The Vercel MCP tools named in the task (list_projects, list_deployments, get_deployment, get_deployment_build_logs, get_runtime_errors) are not available in this session: ToolSearch found no such deferred tools, and the Vercel connector is not installed/connected for this account (`session_connectors_status` does not list it; `set_session_connector_enabled` reports no such connector is available, only Notion and visualize can be toggled). No `vercel` CLI is installed locally (`vercel --version` → command not found), so there is no fallback path to query deployments either. To proceed, connect the Vercel MCP connector for this account or install and authenticate the `vercel` CLI locally.
- Runtime errors: not checked — Vercel tooling unavailable in this session (see state above).

## Smoke test results — 15 features

All 15 features hit the same root blocker on first run: production requires a signed-in Supabase session, and no test/QA account or credential-safe path exists to get past `/sign-in` in this session (entering a real password, using a vault password in browser automation, or creating a new Supabase auth user are all out of scope without explicit user approval or 1Password Agentic Autofill, which was unavailable). Only `sign-in` and `pwa` did not depend on an authenticated session and passed outright.

| Feature | First run | Fix PR | Recheck |
|---|---|---|---|
| sign-in | pass | — | — |
| today | fail (blocked at sign-in) | none — waiting on monitor notification, not re-polled | not rechecked |
| week | fail (blocked at sign-in; no test account) | none — creating a test account needs explicit approval | not rechecked |
| foods | fail (blocked at sign-in) | investigated; confirmed intentional auth-gate behavior, no code fix | not rechecked |
| add-food | fail (blocked at sign-in) | none — stopped at sign-in wall, no changes made | not rechecked |
| build-meal | fail (blocked at sign-in) | none — confirmed intentional auth gate; all 42 tests still pass | not rechecked |
| log-food | fail (blocked at sign-in) | none — failure traced to sign-in prerequisite, not log-food code | not rechecked |
| notes | fail (blocked at sign-in) | **fixed**: `lib/sync/outbox.ts`'s `capByBytes` measured note size with `JSON.stringify(op).length` (UTF-16 code units) instead of actual UTF-8 bytes, undercounting non-ASCII notes (Hiragana, Chinese, emoji) against the outbox byte cap | not rechecked (production still behind auth gate) |
| scan | fail (blocked at sign-in) | none — confirmed intentional auth gate (`middleware.test.ts` already covers the redirect) | not rechecked |
| recipes | fail (blocked at sign-in) | none — confirmed intentional auth gate, no code defect | not rechecked |
| body | fail (blocked at sign-in; 1Password autofill did not complete) | **fixed**: `middleware.ts` redirect-back (`next=`) bug found while tracing the sign-in prerequisite; landed and merged | not rechecked (production still behind auth gate) |
| coach | fail (3 sub-failures: canned "looked things up too many times" error instead of a suggestion card; stale-thread 404 on retry; hard hang with no reply or deflection on an off-plan request) | **fixed** one of three: the tool-call-cap abort on a normal meal-2 request. The stale-thread 404 and the hard hang on an off-plan request look like live-model/production behavior not reproducible from application code with a mocked provider, and were left open | not rechecked |
| settings-export | fail (share button state unconfirmed; test-account creation used ad hoc per the audit's own script) | **fixed**: `components/ShareButton.tsx`'s `handleShare()` silently no-op'd when `generateWeekSummary` had nothing to summarize (fresh account, or Week page still loading), leaving the button state unchanged with no fallback | not rechecked |
| sync-offline | fail (blocked — app is deliberately single-tenant; no second user may be created; dev auth bypass 404s in production) | none — confirmed intentional; a sibling PR (#171) is noted as already addressing related ground; creating a test account was out of scope | not rechecked |
| pwa | pass | — | — |

## Open issues

Everything below is still failing and needs a real path past the production sign-in gate (a documented test account, a safe 1Password Agentic Autofill flow, or explicit approval to create a Supabase test user) before it can be verified end to end. Screenshots are under `docs/screenshots/smoke-2026-09-13/`.

- **today** — never reached past sign-in. `docs/screenshots/smoke-2026-09-13/today-1.png`
- **week** — never reached past sign-in; no test account exists. (no screenshot captured)
- **foods** — never reached past sign-in. `docs/screenshots/smoke-2026-09-13/foods-1.png`
- **add-food** — never reached past sign-in. (no screenshot path recorded)
- **build-meal** — never reached past sign-in. `docs/screenshots/smoke-2026-09-13/build-meal-1.png`
- **log-food** — never reached past sign-in. `docs/screenshots/smoke-2026-09-13/log-food-1.png`
- **notes** — fix landed (outbox UTF-8 byte cap) but the actual production notes flow (tick-to-persist, note edit, gauge refresh) was never exercised live because sign-in still blocks it.
- **scan** — never reached past sign-in. `docs/screenshots/smoke-2026-09-13/scan-1.png`
- **recipes** — never reached past sign-in. `docs/screenshots/smoke-2026-09-13/recipes-1-signin-wall.png`
- **body** — `middleware.ts` redirect fix landed, but the Body page itself (profile fields, weight entry, trend/TDEE, health source sheet, Oura connect) was never exercised live. `docs/screenshots/smoke-2026-09-13/body-1.png`
- **coach** — two of three sub-failures remain open and unexplained against live production: a stale-thread 404 on retrying the same prompt, and a hard hang (3+ minutes, no reply, no error) on an off-plan request. `docs/screenshots/smoke-2026-09-13/coach-1.png`, `coach-2.png`, `coach-3.png`
- **settings-export** — `ShareButton` no-op fix landed, but the live Share button behavior on production (with a populated week) was never confirmed; the browser task space was also taken over by the user mid-check.
- **sync-offline** — never reached past sign-in; the app's single-tenant design means this may need a dedicated, durably-provisioned test account rather than an ad hoc one. (no screenshot captured)
- **Deployment state** — production deployment status, SHA match, and runtime errors are unverified; needs the Vercel MCP connector enabled or the `vercel` CLI installed and authenticated locally.

**Overall recommendation:** before the next wf3 run, provision one durable test/QA Supabase account (documented in the repo, e.g. an env var or a note in this audit folder) and connect Vercel MCP (or install the `vercel` CLI) so smoke tests can get past sign-in and deployment state can be confirmed directly, rather than re-deriving this blocker on every feature.
