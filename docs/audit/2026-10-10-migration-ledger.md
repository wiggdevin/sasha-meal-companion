# Production migration ledger reconciliation (W003)

Date: 2026-10-10. Read-only. Nothing was applied, repaired, inserted or deleted.

## Method
- Project: `fivatgdpuenszxxnijpc` (org Zerosumsolutions-Projects; `docs/readiness/2026-09-12-production-readiness.md` names it the linked production project).
- Query: `select version, name from supabase_migrations.schema_migrations order by version`, sent to the Management API read-only SQL endpoint with `SUPABASE_ACCESS_TOKEN` (value not printed).
- Compared with `supabase/migrations/*.sql` on `origin/main` at `7405f41f` (the `down/` folder holds rollbacks and is not part of the ledger).
- Compared with every remote and local branch that adds migrations, and with the open PRs.

## Result
| Set | Count |
|---|---|
| Production ledger rows | 157 |
| Repo migration files on main | 157 |
| In repo, not applied | 0 |
| Applied, not in repo | 0 |
| Version matches with a different name | 0 |

Production is fully reconciled with main. Latest applied: `20261229090000_client_timings_plan_chips`.
The items the W003 spec expected to be missing are all applied: `20261126090000`, `20261216090000`..`090400`, `20261217090000`..`090200`, `20261217120300`, `20261227090000`, `20261227090100`, `20261228090000`, `20261229090000`.

### In repo, not applied
None. No "apply before/after merge" action is pending for main.

### Applied, not in repo
None.

### Ordering check on `20261228090000_target_writes_service_role_only`
AGENTS.md says apply it AFTER the code that writes through the service role deploys. `lib/server/target-writes.ts` is on main (commit `3a41e463`, 2026-10-08), so the rule is met.

## Open PRs
Open PRs: #48 (docs), #1, #3, #4 (dependabot). None adds a migration.

## Branches with migrations not on main (not applied, not merged)
| Branch | Migrations | Rule when it lands |
|---|---|---|
| `origin/feat/care-massage-item` | `20261225090600_care_items_massage` | Depends on the sprout-care chain below. |
| `origin/feat/sprout-care-backend-pub` | `20261225090000`, `090010`, `090100`..`090500` (mascot, care points, shop, accolades, messages, log growth) | Timestamps sit BEFORE the applied head (`20261229090000`). Not in the ledger, so they apply out of order; check dependencies with a dry run. Apply before the PR merges unless the PR says otherwise. |
| `origin/feat/p18-w11`, `p18-w12-pantry-photo`, `p18-w13` | `20261227090000_shopping_focus`, `20261226090000_pantry_photo_source`, `20261227090100_food_world_set_at` | Same file names as applied rows for `20261227090000` and `20261227090100`: those branches were squashed into main. `20261226090000_pantry_photo_source` is NOT in the ledger or on main: confirm whether `p18-w12-pantry-photo` is abandoned or still planned. |
| `origin/fix/followups-backend`, `fix/ideas-deterministic`, `fix/onb2-qs-backend` | `20261226090100`/`090200`, `20261229090000_client_timings_plan_chips`, `20261228090000` | Already on main and applied (stale branches). |

### Timestamp collisions
`20261229090000` is already used by the applied `client_timings_plan_chips`. Two parked branches reuse it:
- `wip/2026-10-08-account-deletion` (local `feat/account-deletion`): `20261229090000_delete_account.sql`
- `wip/2026-10-08-voice-retire-account-zone` (local `chore/voice-retire-account-zone`): `20261229090000_voice_ears_cleanup.sql`

Both would be skipped or fail on a ledger-based apply because the version is taken. Renumber each to a unique version above `20261229090000` before it lands (for example `20261230090000` and `20261230090100`).

## Owner steps
1. None needed for main: production matches it. Record this report as the receipt for W003.
2. Before `feat/account-deletion` or `chore/voice-retire-account-zone` opens a PR: rename the migration file to a free timestamp above `20261229090000` and update any test or doc that names the old file.
3. Decide on `20261226090000_pantry_photo_source` and the sprout-care chain (`20261225*`): land or archive. If landed, dry-run the pending list, back up, apply in order, verify, and record a receipt, per AGENTS.md.
4. Caveat: a ledger row proves the migration was recorded, not that its objects exist. A schema-level check (`scripts/audit/data-integrity.ts`, read-only) is a separate step if wanted.
