# Contributing

Rules for working on this repo. Read `../AGENTS.md` first for the project
map and the domain rules tests guard.

## Branches

Name each branch by its type:

- `feat/<short-name>` — new behavior.
- `fix/<short-name>` — bug fix.
- `chore/<short-name>` — cleanup, deps, config.

One feature is one branch. One branch ends in one squashed commit on the
default branch.

## Commits

Use conventional commits: `type: description`.

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Example: `fix: keep avoid foods out of the rotation pool`.

## Tests

Run tests before a PR. Run them once, targeted:

- `pnpm test` runs the full suite locally before you open a PR.
- After that, run only the file you touched, not the full suite again.
- Never run the full suite a second time to double-check. CI is the
  second run.

`pnpm test` must stay green before any deploy.

CI integration tests start a disposable local Supabase Docker stack with the lockfile-pinned CLI,
apply all migrations and test helpers, and require valid loopback connection settings before tests.
No hosted-project secrets are needed. Startup failure fails the job instead of skipping database tests.
`pnpm test:integration` runs only the files that behave differently with a database: those with a
skip construct, or that import a test helper naming the `SUPABASE_TEST_*` settings
(`scripts/ci-integration-files.ts`). The unit run (`pnpm test`, sharded four ways in CI) covers the rest.

For manual integration checks, use an isolated Supabase preview branch. Reset it with
`scripts/db-branch.sh reset <branch-name>` before a release check. The reset applies migrations
and then `supabase/seed/test_helpers.sql`, which restores the hosted `service_role` table and
sequence privileges that the raw database reset does not reproduce. The helper seed remains
disabled in `supabase/config.toml` and must never be applied to production.

## CI is the gate

CI runs lint, tests, and the build on every PR. A PR merges only when CI
is green. Do not deploy around a red check.

## Deploys

Vercel Git integration builds and deploys from `main`. Merge to `main` to
deploy.

`vercel --prod` is retired. Do not run it once Git integration is live.
The command stays denied in `.claude/settings.json` as a guardrail.

### Migrations do not deploy themselves

A deploy ships code, not schema. Vercel's Git integration builds the app and
touches no database, and CI applies migrations only to its disposable local test database. **Merging a migration to `main`
does not put it in production** — somebody applies it by hand.

On 2026-09-14 production was found running four migrations behind `main`
(`20261013090200`, `20261014090000`, `20261014090001`, `20261015000000`), so
`_sync_upsert` and `catalog_write_provider_revision` had been serving their
pre-fix bodies while the repo said otherwise. Nothing reported it. These two
scripts exist so that cannot be silent again:

    # read-only; CI runs this on every push to main
    pnpm exec tsx scripts/check-migration-drift.ts

    # applies what is missing, and records it in the ledger
    python3 scripts/apply-migrations.py            # dry run
    python3 scripts/apply-migrations.py --commit

Both read `SUPABASE_ACCESS_TOKEN` plus `SUPABASE_PROJECT_REF` (or
`SUPABASE_URL`). Applying to production is a human action, not an agent one —
ruling R11a, `docs/decisions/2026-09-13-audit-rulings.md`. Back up first;
`~/Backups/supabase/` is where the 2026-09-14 backup went.

The CI job is a safe no-op until `SUPABASE_ACCESS_TOKEN` and
`SUPABASE_PROJECT_REF` are added to the repo's secrets.

## Run it locally

```bash
pnpm install
pnpm dev
```

The app runs at `http://localhost:3000`.

Other commands:

```bash
pnpm lint
pnpm test
pnpm exec tsc --noEmit
pnpm build
```

## Where things live

- Specs: `docs/specs/`.
- Architecture: `docs/architecture.md`.
- Feature list: `docs/features.md`.
- Project map and domain rules: `../AGENTS.md`.

## Secrets

No secrets in git. Never commit `.env` or `.env.local`. Copy
`.env.example` and fill in real values locally. Production values live in
Vercel project settings.
