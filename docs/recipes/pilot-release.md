# Original recipe pilot seed release

The seed publishes only the 24 authored `original-pilot-v1` recipes listed in
[`pilot-source-rights.md`](pilot-source-rights.md). It checks 119 ingredient lines, 30 distinct
FoodDB IDs, the source and rights fields, and estimated nutrition provenance before any database
request. The methods are not kitchen tested. This release path does not certify cooking yield,
food safety, or prepared-dish nutrition.

The release owner handles database migrations, production seeding, and deployment. Verify
`20261127090000_recipe_catalog_shopping` before preflight or seed; the catalog tables must exist.

## Release sequence

Pilot source merged to `main` in PR #282. A read-only production ledger check on 2026-09-27
recorded all six feature migrations below ([receipt](../audit/2026-09-27-foods-annotations/production-schema-before.md)).
The integrated release then merged in PR #284. Production seed preflight reported 0 recipes to
create and 12 existing. PR #286 deployed main SHA `2dcceea`; one approved QA account was added to
the production allowlist, and an authenticated 390 px Foods → Shopping smoke passed. See the
[rollout receipt](../audit/2026-09-27-foods-annotations/pilot-rollout.md). On 2026-10-17 the read-only production preflight reported 0 to create and 24 existing, covering all
24 recipes ([W084 receipt](../audit/2026-10-17-w084-pilot-seed-and-deploy.md)). Recheck drift before any
release operation; in an environment missing these migrations, apply them in this order:

1. `20261127090000_recipe_catalog_shopping` — shared catalog and account shopping data.
2. `20261128090000_recipe_plan_accept` — server preview and accepted selection authority.
3. `20261129090000_recipe_eaten_snapshots` — validated consumed marks and slot intent.
4. `20261130090000_recipe_consumed_cas` — atomic online selection-bound eaten write.
5. `20261201090000_recipe_consumed_sync` — consumed-history sync feed, replay guard and online undo.
6. `20261202090000_scope_recipe_food_ref_clock` — owner-scoped food-ref invalidation for concurrent account writes.

The C4 route and RPC are in `main`. Focused local database tests exercised
the stale-selection rejection, same-request replay and duplicate/post-undo refusal. An independent
whole-branch review then found that C4 did not feed other devices and generic offline conflicts
could erase actual history. C5 adds the source changes for those cases. Focused loopback two-client feed and
offline-replay tests passed, and an independent database proof passed on 2026-10-04
([receipt](../audit/2026-10-04-c5-db-proof.md)). The bounded QA rollout passed seed, CI, deploy-SHA and signed-in
release checks. Back up and inspect migration drift as described in [Contributing](../CONTRIBUTING.md).
Before any application deploy to an environment without this schema, apply its complete reviewed
migration set. The seed preflight and write require the catalog schema; verify published rights
and visibility before enabling the pilot. The custom-rule and note-sync SQL is production-applied;
the 12 pilot recipes have appended identity repairs and their 29 public foods have warmed dietary
evidence. Receipts: [schema](../audit/2026-09-27-foods-annotations/production-migrations-applied.md)
and [recipe repair](../audit/2026-09-27-foods-annotations/production-recipe-repair.md). These do not
by themselves prove app deployment.

`RECIPE_PLANNING_USER_IDS` is the comma-separated account UUID allowlist for app recipe and
shopping workflows. Production is closed when it is unset; an explicit `*` enables all accounts.
Keep any additional production account off until schema, seed, CI and signed-in smoke checks pass. Shared
published original recipe content remains readable through authenticated publication RLS;
the flag is a workflow rollout control, not a confidential-content boundary. Verify account
isolation for private favorites, accepted plans, pantry and shopping records. Check a restricted
account's current rules and Avoid list, a new account with no inherited Favorites, a no-cook
plan, a weekly plan and a monthly plan with separate purchase windows. Verify manual lines,
bought checks and notes across reload and replan. Unknown package sizes and prices must remain
unknown in the UI; no budget guarantee is provided. Rollback must account for stored eaten
snapshots: the third down migration refuses to discard them, and the fifth refuses to remove
history or replay protection while consumed slot state, undo receipts or history markers remain.
Do not assume a down migration is safe after pilot use.

## Commands

Run from the repo root with the existing Supabase environment configured. Keep credentials out of
shell command arguments and saved reports.

```sh
# Offline manifest check: no client and no database request.
pnpm exec tsx scripts/seed-recipe-catalog.ts

# Read-only local stack check. Requires loopback SUPABASE_TEST_URL and test service key.
pnpm exec tsx scripts/seed-recipe-catalog.ts --preflight

# Local write, after a clean preflight. Uses only the loopback test environment.
pnpm exec tsx scripts/seed-recipe-catalog.ts --write
```

For production, configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`SUPABASE_PROJECT_REF` through the existing secret lane. The production URL must be the bare HTTPS
origin `https://<project-ref>.supabase.co`. Enter the exact configured ref in both commands; the
script rejects a missing, duplicate, or mismatched confirmation before creating a client. The
read-only command makes no writes. Only the root release owner runs the write command.

```sh
pnpm exec tsx scripts/seed-recipe-catalog.ts --production --preflight --confirm-project-ref="$EXPECTED_PROJECT_REF"
pnpm exec tsx scripts/seed-recipe-catalog.ts --production --write --confirm-project-ref="$EXPECTED_PROJECT_REF"
```

Preflight reports how many catalog slugs are absent and how many already exist. It skips existing
published, withdrawn, and superseded roots without updating their content or publication state.
A draft with a pilot slug stops preflight and reports whether its provenance matches plus its
revision, item, and step counts. A prior failed write can leave such a draft because the insert
sequence is not one transaction. Do not rerun `--write` until that diagnosis is reviewed: catalog
revisions, items, and steps are immutable, so this tool does not delete or repair partial data.
The root owner should inspect the exact slug and arrange a bounded recovery or a new approved
revision path. The script never deletes arbitrary catalog rows or revives withdrawn content.

After a successful write, run the read-only preflight again. It should report 0 to create and 24
existing. A repeated write is safe and should report 0 created and 24 skipped. Verify catalog
visibility and rights in the release owner's database review before pilot enablement. Rights
corrections after publication use the recorded withdrawal path, never a seed replay.
