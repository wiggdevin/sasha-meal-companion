# 03 — Vercel production environment names

**Outcome:** weak  
**Severity:** low

The comparison used names only from Vercel's production-environment API. No secret value was printed. Assignment-shaped names in `.env.example`, including documented optional and test-only variables, were included.

## Present in both (23)

`AI_DAILY_SPEND_CAP_USD`, `CAPTURE_METHODS`, `COACH_ENABLED`, `CRON_SECRET`, `ESTIMATOR_ENABLED`, `FDC_API_KEY`, `GEMINI_API_KEY`, `GEMINI_BILLING_ATTESTED`, `HEALTH_CONTEXT_PROVIDER`, `NEXT_PUBLIC_CAPTURE_METHODS`, `NEXT_PUBLIC_CATALOG_SEARCH`, `NEXT_PUBLIC_COACH_ENABLED`, `NEXT_PUBLIC_ESTIMATOR_UI`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NOUS_API_KEY`, `NOUS_BASE_URL`, `SASHA_MCP_TOKEN`, `SASHA_SYNC_TOKEN`, `SASHA_USER_ID`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TYPESAFE_API_KEY`.

**Stale as of 2026-10-08: all `NOUS_*` names were removed from Vercel production on 2026-10-08.**
This table is a point-in-time snapshot from the 2026-09-19 sweep; the Nous Portal transport itself
was removed from the codebase on 2026-10-01 (`docs/ai-data-handling.md`), and the matching env vars
have now been deleted from production to match. `NOUS_API_KEY` and `NOUS_BASE_URL` above, and
`NOUS_COACH_MODEL_ID`/`NOUS_REVIEW_MODEL_ID` below, no longer apply; a fresh env-name sweep would
no longer find them in either column.

## In `.env.example`, absent from Vercel production (18)

| Names | Reason / assessment |
|---|---|
| `CATALOG_IMPORT_DB_URL`, `DEV_SIGN_IN_EMAIL`, `SEARCH_EVAL_EMAIL`, `SEARCH_EVAL_PASSWORD`, `SUPABASE_TEST_ANON_KEY`, `SUPABASE_TEST_DB_URL`, `SUPABASE_TEST_SERVICE_ROLE_KEY`, `SUPABASE_TEST_URL`, `SUPABASE_TEST_USER_ID` | Local, evaluation, import, or test-only; they should not be copied into production. |
| `CAPTURE_DAILY_HARD_CAP`, `CAPTURE_DAILY_SOFT_CAP` | Optional caps with code defaults; absent by choice rather than a missing required secret. |
| `HEALTH_INGEST_ENABLED`, `NEXT_PUBLIC_FEATURE_SCAN` | Feature flags are absent/off. |
| `HEALTH_TOKEN_KEY`, `HEALTH_TZ`, `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET`, `OURA_REDIRECT_URI` | Oura/health ingestion is disabled; the corresponding route probes returned 503. |

## In Vercel production, absent from `.env.example` (3)

`HEALTH_INGEST_TOKEN`, `NOUS_COACH_MODEL_ID`, `NOUS_REVIEW_MODEL_ID`.

## Assessment and owner step

The deployed feature set has its functional variables, and test-only credentials are correctly absent. The environment contract is nevertheless weak because three live names are undocumented. The owner should either document those names in `.env.example` (without values) or remove them if obsolete, then rerun this exact name comparison.

## Rollout tracker — dark feature flags (added 2026-10-08)

Every flag that gates a whole feature dark until an explicit release, with its current state as
read from `.env.example` and the gating code. `NEXT_PUBLIC_CHAT_ONBOARDING`, `OPEN_WORLD_ENABLED`
and `TASTE_CHIPS_ENABLED` were already the owner's named list (`docs/specs/onboarding-as-built.md`,
`docs/specs/phase-18-open-world-foods.md`); these three were found gated but missing from that
list (audit finding `dark-flags-beyond-named-three`):

| Flag | What turns it on | Prod value |
|---|---|---|
| `CONDITION_PACKS_ENABLED` | Set to exactly `1` (`lib/policy/profiles/condition-packs.ts`). Ships unset until the owner reviews the pack wording on a Preview. [Phase 13] | Not verified here — unset by `.env.example` default; no record found of a production override. Owner to confirm. |
| `RECIPE_PLANNING_USER_IDS` | Comma-separated account UUIDs, or `*` for every account (`lib/server/recipe-access.ts`). Unset or empty keeps production closed; a rollout control, not a content boundary. | Not verified here — unset/empty by `.env.example` default; no record found of a production override. Owner to confirm. |
| `REBALANCE_PANEL_USER_IDS` | Comma-separated account UUIDs (`lib/server/rebalance-access.ts`). Unset or empty is off everywhere, including development; set only after the D6 clinical sign-off is recorded in `docs/decisions/`. | Not verified here — unset/empty by `.env.example` default; no record found of a production override. Owner to confirm. |
