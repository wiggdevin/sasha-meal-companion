# Sasha's Meal Companion

A phone-first, multi-user PWA; Sasha is user 1. It tells each person what
to eat and when, lets them tick meals off, and builds meals from the foods
they can eat right now.

Live: https://sasha-meal-companion.vercel.app

## Stack

- Next.js 16.3.4, React 19, TypeScript
- Tailwind 4
- Supabase (project `fivatgdpuenszxxnijpc`) for sync and the MCP server
- Vitest for tests
- pnpm 11.25.0, Node 22
- Deployed on Vercel (project `sasha-meal-companion`)

## Quick start

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000.

Copy `.env.example` to `.env.local` and fill in real values for local
Supabase sync. The app runs without them; sync stays off until they are
set.

Profile onboarding derives each user's targets, and the coach can manipulate schedule, body-log,
profile, target and Eats/Avoid cards with Undo. Recipe and shopping pilot source merged to `main`
in PR #282, and its six migrations are recorded in the production ledger. The pilot exposes
original recipes, account-aware discovery, portion previews, accepted meal selections and dated
shopping lists to enabled accounts after the remaining release checks in
[`docs/recipes/pilot-release.md`](docs/recipes/pilot-release.md).
The C4 online eaten write has focused local database proof; the C5 sync and history fix is in
`main` with focused loopback two-client tests passed; final independent database verification is pending.
The migration ledger does not by itself prove production deployment, seed or pilot enablement.
AI routes use `GEMINI_API_KEY`; optional Jev routing, ranking and verification uses the server-only
`TYPESAFE_API_KEY` and falls through when unavailable. Set `RECIPE_PLANNING_USER_IDS` to a
comma-separated list of account UUIDs for the pilot; it is closed by default in production.
An explicit `*` enables all accounts. Local loopback Supabase enables the pilot when the variable
is absent. This flag gates app workflows, not access to published shared recipe content through
Supabase. Private plans, favorites, and shopping data remain account scoped.

## Commands

```sh
pnpm dev                    # local dev server
pnpm lint                   # eslint
pnpm test                   # vitest, must stay green before any deploy
pnpm exec tsc --noEmit      # type check
pnpm build                  # production build
```

## Project layout

| Path | What |
|---|---|
| `app/` | Next.js routes, including `app/api/sync/`, `app/api/mcp/`, `app/api/recipes/` and `app/api/shopping/` |
| `components/` | UI: Today screen, Foods tabs, recipe discovery, shopping, Build Meal and Log Food sheets |
| `lib/` | Food data, meal rules, recipe catalog and selection, shopping planner, scaling, store and server-only Supabase layer |
| `docs/` | Architecture, features, specs, contributing |
| `scripts/` | One-off build scripts, e.g. `scripts/build-food-db.py` |

See `AGENTS.md` for the path-by-path map and domain rules. Recipe eligibility uses each
account's current rules and Avoid list; there are no hardcoded personal food exclusions.
A calorie change never moves the protein portion.

## Docs

- [`docs/architecture.md`](docs/architecture.md) — system architecture.
- [`docs/features.md`](docs/features.md) — feature list and pilot behavior.
- [`docs/recipes/pilot-release.md`](docs/recipes/pilot-release.md) — pilot release sequence and seed operation.
- [`docs/recipes/pilot-source-rights.md`](docs/recipes/pilot-source-rights.md) — original recipe provenance and nutrition limits.
- [`docs/specs/`](docs/specs/) — phase specs.
- [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) — branch, commit, test,
  and deploy rules.
- [`lib/profile/energy.ts`](lib/profile/energy.ts) — complete-profile target derivation;
  historical first-client numbers are not defaults.
