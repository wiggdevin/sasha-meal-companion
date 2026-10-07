# Brand-new account walkthrough

Runs the ten-step 390×844 local walkthrough against two newly created accounts.
It starts and stops Next on port 3000, uses local Mailpit for sign-in, writes screenshots and a
receipt, then deletes only its fixture accounts and verifies their direct user rows are gone.

## Run

From the repository root:

```sh
unset SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_URL \
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY DATABASE_URL
eval "$(bash ~/.claude/goal-state/sasha-new-user/lanes/local-env.sh)"
case "$SUPABASE_TEST_URL" in http://127.0.0.1*) ;; *) exit 90;; esac
node scripts/readiness/new-user-walk.mjs --baseline
```

`--baseline` records every FAIL and continues. With no flag, the harness records the first FAIL,
cleans up, stops the server, and exits. Both modes exit 0 only when all ten steps pass.

The script refuses a non-loopback Supabase URL and an occupied port 3000. It generates
`HEALTH_TOKEN_KEY` and `CRON_SECRET` in memory, forwards the required feature flags, and never
prints their values. It makes at most one coach turn per run.

Local mail currently sends a link without a numeric OTP. The harness records that as finding 1,
then opens an admin-generated magic link in the same Playwright page so the remaining steps run.

Outputs:

- Receipt: `~/.claude/goal-state/sasha-new-user/lanes/W1/baseline.md`
- Screenshots: `~/Inbox/screenshots/sasha-new-user-2026-09-20/baseline/`

The script imports Playwright from the project when installed, or from the machine pnpm store.
If neither exists, prime the store once with `pnpm dlx playwright --version`.
