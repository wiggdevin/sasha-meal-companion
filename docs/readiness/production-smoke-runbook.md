# Production smoke runbook

Every gated route — `/`, `/week`, `/foods`, `/coach`, and every feature `docs/audit/2026-09-13/wf3-verify-production.js`
drives, build-meal included — redirects an anonymous request to `/sign-in` (`middleware.ts`). There
is no production auth bypass to reach around that with: `app/api/dev/sign-in` (the local-only
magic-link shortcut) answers 404 whenever `NODE_ENV=production` or a Vercel environment is set, by
design (`devSignInAllowed` in `app/api/dev/sign-in/route.ts`). A smoke agent hits this wall on
every signed-in feature, not only build-meal, until it authenticates the same way a person would.

## The handoff

Signing in on production needs a real account. Provisioning one is the owner's step, not an
agent's:

- The agent never creates a production Supabase account or user — no `supabase auth admin
  createUser` / `generateLink` / SQL insert against the production project, from this runbook or
  any smoke run. (Contrast `SEARCH_EVAL_EMAIL`/`SEARCH_EVAL_PASSWORD` in `.env.example`, which are
  a Supabase *test branch* login for `scripts/search-eval.ts` — a different project, not
  production, and not usable here.)
- Devin (the owner) provisions a standing test account in the production Supabase project once,
  out of band, and stores its credential in ZS Vault as `sasha-meal-companion-smoke`.
- A smoke agent looks up that vault entry and signs in at `/sign-in` through EGO Lite's 1Password
  Agentic Autofill. It never types the password itself and never handles it in plain text (per
  `~/.claude/CLAUDE.md`'s browser-identity and credential rules).
- If `sasha-meal-companion-smoke` is not in ZS Vault, the agent stops and reports the gap in
  `docs/audit/2026-09-13/wf3-results.md`'s "Open issues" instead of creating an account, entering a
  password itself, or leaving the feature unexplained.

## After sign-in

Once signed in, every feature in `docs/audit/2026-09-13/wf3-verify-production.js`'s `FEATURES` list
runs as written, build-meal (`components/BuildMealSheet.tsx`) included — the steps there do not
change; only the missing first step (authenticate via the vault-stored test account, not a
freshly created one) was undocumented.
