# W122 production-readiness evidence: 2026-10-17

Spec item W122 (sources B147, B152). Everything here was read-only against production: no
migrations, no settings changes, no Supabase branches, no sign-in. Vercel project
`sasha-meal-companion` (`prj_qOr6rQOZ5yfCd5VxB227apmg6pvF`, team `devin-wiggins-projects`);
Supabase project `fivatgdpuenszxxnijpc`. Latest production deployment at capture:
`dpl_3xv6GSCcyKhka9JQWbqgqsCziJJe` (main, `c4ce4ca`).

| W122 "done when" line | Result |
|---|---|
| Next cron runs show 2xx for every cron route | Met. 10 of 10 routes, zero non-2xx (below). |
| Signed-in phone checks pass | Moved to W061 (physical-device acceptance). Not attempted. |
| Lighthouse run stored | Met. Sign-in page, mobile: 77 / 93 / 100 / 60. |
| Advisors triaged | Met. 33 security WARN + 16 INFO, 50 performance INFO, all triaged below. |

## 1. Cron runs

Source: `vercel logs requests` (CDN request records, `httpStatus`), production, window
2026-10-08 to 2026-10-17 08:20 UTC (the 10 000-record cap trimmed the oldest days; the earliest run
seen per route is shown). Every record has user agent `vercel-cron/1.0` and method GET. The earlier
405 history from 2026-09-19 (`04-crons.md`) is gone: the W1 `GET = POST` repair is live.

| Route | Schedule (UTC) | Runs seen | Last run (UTC) | Last status | Non-2xx |
|---|---|---|---|---|---|
| `/api/jobs/media-sweep` | `0 3 * * *` | 8 | 2026-10-17 03:00:35 | 200 | 0 |
| `/api/jobs/oura-pull` | `0 10-12 * * *` | 21 | 2026-10-16 12:00:24 | 200 | 0 |
| `/api/jobs/estimate` | `0 7-9 * * *` | 23 | 2026-10-17 08:00:32 | 200 | 0 |
| `/api/jobs/weekly-proposal` | `0 1-3 * * 1` | 3 | 2026-10-12 03:00:18 | 200 | 0 |
| `/api/jobs/weekly-review` | `30 * * * *` | 177 | 2026-10-17 07:30:10 | 200 | 0 |
| `/api/jobs/backup` | `45 3-6 * * *` | 26 | 2026-10-17 06:45:27 | 200 | 0 |
| `/api/jobs/facet-warm` | `20 4-7 * * *` | 32 | 2026-10-17 07:20:11 | 200 | 0 |
| `/api/jobs/spend-sweep` | `*/15 * * * *` | 710 | 2026-10-17 08:15:34 | 200 | 0 |
| `/api/jobs/signal-purge` | `50 4 * * *` | 8 | 2026-10-17 04:50:48 | 200 | 0 |
| `/api/jobs/onboarding-events-purge` | `55 4 * * *` | 8 | 2026-10-17 04:55:02 | 200 | 0 |

Findings: none. Notes:

- `oura-pull` last ran 2026-10-16 12:00; today's 10:00 run had not fired yet at capture (08:20).
- `weekly-proposal` has one Monday (2026-10-12, three hourly runs) in the window; the next is
  Monday 2026-10-19. Both are 200.
- `weekly-review` is scheduled `30 * * * *` (hourly), not weekly, in the current `vercel.json`. It
  returned 200 every hour, so this is not a failure. If the job is meant to act weekly, it
  must guard itself (it appears to). Worth a look in a later spec item; no evidence of harm.
- `get_runtime_logs` (MCP) only shows console output, not status codes, so the status evidence
  comes from the CLI request records.

## 2. Lighthouse

Lighthouse 12.8.2, mobile form factor and emulation, simulated throttling, headless Chrome, run
2026-10-17 against `https://sasha-meal-companion.vercel.app/sign-in`. The report is
[`lighthouse-sign-in-mobile.json`](lighthouse-sign-in-mobile.json) (515 KB, not compressed).
No sign-in. Other pages (`/`, `/week`, ...) answer 307 to `/sign-in`, so sign-in is the only
public page to measure.

| Category | Score |
|---|---|
| Performance | 77 |
| Accessibility | 93 |
| Best practices | 100 |
| SEO | 60 |

Performance detail: FCP 1.2 s, LCP 6.5 s, TBT 70 ms, CLS 0, Speed Index 1.2 s. The LCP element is
the muted helper paragraph under the heading ("Sign in once and stay signed in..."), with TTFB
about 716 ms; the long LCP is a render-delay problem (it is plain text, so fonts or client
rendering gate it), not an image. Failing audits:

| Audit | Verdict |
|---|---|
| `largest-contentful-paint` 6.5 s | Follow-up: find what delays text paint (font swap, hydration). Not a launch blocker for a private installable app. |
| `meta-viewport` (`maximum-scale=1, user-scalable=no`) | Follow-up, real accessibility defect: pinch-zoom is disabled. Remove `maximumScale` and `userScalable` from `viewport` in `app/layout.tsx` (needs a UI owner; touches app behaviour, so not done here). |
| `is-crawlable` (`robots: noindex, nofollow`) | Accept: intentional, this is a private app. This alone explains the SEO 60. |
| `unused-javascript`, render-blocking and network-dependency insights | Informational; fold into the LCP follow-up. |

## 3. Supabase advisors

Fetched 2026-10-17 08:18 UTC through the Supabase MCP `get_advisors` (read-only), plus one
read-only `pg_proc` query to check how each flagged function behaves. Counts differ from the
2026-09-19 sweep (6 INFO / 15 WARN security, 37 INFO performance) because many tables, RPCs and
indexes have shipped since, and the linter now includes lint 0029. There are 0 ERRORs.

| | Count |
|---|---|
| Security WARN | 33 (3 mutable search_path, 2 extensions in public, 28 SECURITY DEFINER callable) |
| Security INFO | 16 (RLS enabled, no policy) |
| Performance WARN | 0 |
| Performance INFO | 50 (34 unindexed FKs, 13 unused indexes, 2 no primary key, 1 Auth connection strategy) |

### Triage buckets

| Bucket | Findings |
|---|---|
| Fix now (proposed, not applied) | 3 function_search_path_mutable |
| Accept with reason | 28 SECURITY DEFINER RPCs, 16 RLS-no-policy, 13 unused indexes, Auth connection strategy |
| Defer to a named spec item | 34 unindexed FKs (W044), 2 extensions in public (W044), 2 no primary key in `catalog_staging` (W146) |

### Fix now: 3 mutable search_path (WARN)

`_sync_assert_key`, `catalog_search_doc` and `compute_item_snapshot` are plain `SECURITY INVOKER`
functions with no `search_path` set. Two of them are executable by `anon`. The risk is low (no
privilege escalation, since they are not definers) but the fix is one migration and cheap. Proposed
migration (apply through the normal W-migration route with a dry run and receipt; do not hand-run):

```sql
alter function public._sync_assert_key(text, text) set search_path = public, pg_temp;
alter function public.catalog_search_doc(text, text, text) set search_path = public, pg_temp;
alter function public.compute_item_snapshot(uuid, numeric) set search_path = public, pg_temp;
```

Check first that none of the three call `unaccent` or `pg_trgm` operators unqualified from a
schema other than `public` (they live in `public` today, so `public` in the path keeps them
working; this order matters if the extensions are moved later, see below).

### Accept with reason

- **28 `authenticated_security_definer_function_executable` (WARN).** The app calls these RPCs
  as the signed-in user on purpose (sync, care ledger, coach undo, recipe, shopping, taste, food
  notes, API-token revoke). The read-only check showed all 28 are `SECURITY DEFINER` with a fixed
  `search_path` (`public`, or empty for the three `recipe_*` RPCs), none is executable by `anon`,
  and every body references `auth.uid()` or `_sync_assert_caller`. Revoking `EXECUTE` would break
  the app; switching to `SECURITY INVOKER` would need RLS rewrites. The `p_user_id` parameters are
  the known pattern here; the cross-user RLS suite (68/68 on 2026-09-19) covers the caller
  assertion. Caveat: the check was a text match, not a proof that every code path asserts the
  caller. A per-function review of the assertion on `p_user_id`/`p_user` arguments is a sensible
  future audit, not a launch blocker.
- **16 `rls_enabled_no_policy` (INFO).** Tables: `ai_spend_global_days`, `ai_spend_reservations`,
  `ai_spend_user_days`, `backup_runs`, `coach_intent_events`, `food_membership_ops`,
  `food_note_authority`, `job_cursors`, `legacy_backfill_rows`, `oauth_states`, `rate_limits`,
  `recipe_catalog_seals`, `recipe_consumed_requests`, `recipe_consumed_slot_state`,
  `recipe_consumed_undo_requests`, `taste_chip_holds`. These are server-only tables: RLS on with no
  policy means deny-all to `anon` and `authenticated`, and the service role bypasses RLS. That is
  the intended lock-down. Adding policies would loosen it.
- **13 `unused_index` (INFO).** The database has had little real traffic, so "never used" is not
  evidence the index is useless. Do not drop any until the W049 soak produces real query
  statistics.
- **1 `auth_db_connections_absolute` (INFO).** Auth is capped at 10 connections. This only
  matters if the compute instance is resized. It is a dashboard setting (Auth, connection
  strategy: percentage); change it together with any compute upgrade. Owner-only, no action now.

### Defer to a named spec item

- **34 `unindexed_foreign_keys` (INFO) to W044 (Scale step 4: indexes and retention).** Tables
  affected: `care_accolades`, `care_inventory`, `care_purchase_receipts`, `catalog_barcodes`,
  `coach_action_undos` (2), `coach_messages`, `duplicate_group_members`, `duplicate_groups`,
  `favorites_catalog_recipes`, `favorites_foods`, `favorites_meal_items`, `favorites_recipes`,
  `health_samples` (2), `log_items` (3), `media_objects`, `recipe_catalog`,
  `recipe_catalog_items` (2), `recipe_items` (2), `recipe_plan_selections` (4),
  `shopping_lines`, `shopping_purchase_window_edits`, `shopping_purchase_windows`,
  `target_proposals`, `user_food_prefs`, `user_foods`. Priority order for the W044 migration:
  `log_items`, `health_samples`, `coach_messages`, `media_objects`, `recipe_plan_selections`
  (hot or large), then the rest. Use `create index concurrently if not exists` per FK column set.
  Several also back `ON DELETE` cascades from user deletion, so they matter before any
  account-deletion sweep.
- **2 `extension_in_public` (WARN): `pg_trgm`, `unaccent` to W044.** Moving them to an
  `extensions` schema rewrites operator class references used by trigram indexes
  (`catalog_food_revisions_trgm_brand` and others) and by `catalog_search_doc`. Do it as one
  migration with the index rebuild and `search_path` updates, tested on a local stack first.
  Proposed: `create schema if not exists extensions; alter extension pg_trgm set schema extensions;
  alter extension unaccent set schema extensions;`, then add `extensions` to the search_path of every
  function that uses them. Not safe to do alongside the 3-function fix above without a test run.
- **2 `no_primary_key` (INFO): `catalog_staging.food_portion`, `catalog_staging.food_nutrient`
  to W146 (Quarterly catalog refresh job).** They are staging tables for the catalog load. The
  refresh job should either add keys or drop the staging schema after a load.

## 4. Signed-in phone checks

Moved to W061 (Owner: physical-device acceptance). It needs a person with a phone and Sasha's
magic link. Not attempted. Update W122's "done when" to drop that line.

## 5. Mutation ledger

Production writes, migrations, setting changes, deploys, Supabase branches and sign-ins: none.
Reads used: Vercel request records (CLI, token from ZS Vault, never printed), Vercel MCP
deployments list, Supabase MCP advisors, one `SELECT` on `pg_proc` metadata, Lighthouse against a
public page.
