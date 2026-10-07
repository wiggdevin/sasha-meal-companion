# 03 — Vercel production environment names

**Outcome:** weak  
**Severity:** low

The comparison used names only from Vercel's production-environment API. No secret value was printed. Assignment-shaped names in `.env.example`, including documented optional and test-only variables, were included.

## Present in both (23)

`AI_DAILY_SPEND_CAP_USD`, `CAPTURE_METHODS`, `COACH_ENABLED`, `CRON_SECRET`, `ESTIMATOR_ENABLED`, `FDC_API_KEY`, `GEMINI_API_KEY`, `GEMINI_BILLING_ATTESTED`, `HEALTH_CONTEXT_PROVIDER`, `NEXT_PUBLIC_CAPTURE_METHODS`, `NEXT_PUBLIC_CATALOG_SEARCH`, `NEXT_PUBLIC_COACH_ENABLED`, `NEXT_PUBLIC_ESTIMATOR_UI`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NOUS_API_KEY`, `NOUS_BASE_URL`, `SASHA_MCP_TOKEN`, `SASHA_SYNC_TOKEN`, `SASHA_USER_ID`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, `TYPESAFE_API_KEY`.

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
