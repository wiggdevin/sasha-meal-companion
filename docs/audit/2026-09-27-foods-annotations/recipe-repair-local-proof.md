# Original pilot recipe identity: local repair proof

This is a **local test-database receipt**, not a production apply or a claim that the recipes are kitchen tested. The original 12 published pilot recipes had 62 ingredient rows without catalog references. Their bundled FoodDB descriptions were compared with the original USDA SR Legacy `food.csv`; all 29 distinct pilot foods had one reviewed FDC source ID. The application now resolves `(source='fdc_sr_legacy', source_id)` and checks the active revision description against that reviewed row. A matching name in Foundation or FNDDS cannot supply identity.

## Source and target

- Original public USDA CSV: `/Users/zero-suminc./Backups/usda/sr_legacy/food.csv`, SHA-256 `de8b0390058db4f102368c9fbdfde144790b480ff4cb0507c0e060ef99805dee`.
- Public 29-food fixture: `/Users/zero-suminc./Documents/Codex/2026-09-26/hey/work/foods-public-pilot-fixture.json`, SHA-256 `53aa15c935bfd67030007892cf676d376f17426d90a439b70f63ea56586ce0ec`. It has 29 foods, 29 revisions, 111 portions, and **zero catalog ingredient-list rows**. No account data is in this fixture.
- Reviewed local import SQL: `/Users/zero-suminc./Documents/Codex/2026-09-26/hey/work/import-public-pilot-fixture.sql`, SHA-256 `a9d9f5d025e2ce467393c0841932abba98c8362e59e4d6be3373e9e35791c3e3`. Root applied it to local Postgres and verified a second application inserted zero rows.
- Code at this proof: `lib/recipe-catalog/pilot-sr-legacy.ts` SHA-256 `0a5ff508e22ce0aaeb046f4f2cfea73b6b914b82cca5e436ea9cab6d8b644fa8`; `scripts/repair-recipe-food-mapping.ts` `ab1503290e180bd55ab73d31214332d4e65b90fdfffea5c09d3507378608a749`; `scripts/warm-pilot-recipe-facets.ts` `85f09ca8b9c11c9d50c1226ce9e49abc590dac8e14c3a901d79c2a6eb49f83a3`.
- Target was the existing local `supabase_db_meal-companion` container, verified as host port **54322**. The local backup `/Users/zero-suminc./Backups/supabase/meal-companion-local/2026-09-27T185350Z-before-recipes-shopping.dump` has SHA-256 `c4e5474eeaa9119749d6dd1b165793a310164f2303f8cd992d73d7e27393f15b`; container `pg_restore -l` read its 1,216-entry custom archive. The shell's older `pg_restore` cannot read dump format 1.16, so use the container tool if restoration is ever needed.

Every application command below ran through `~/.claude/goal-state/sasha-phase-15-codex/local-run.py`, which checks that configured Supabase URLs are loopback and injects the local TEST credentials without printing them. The repair CLI itself requires a loopback `SUPABASE_TEST_URL`; a production target requires an explicit exact project-ref confirmation. No production command was run.

## Append-only repair

| Check | Before | After |
|---|---:|---:|
| Published original pilot roots | 12 | 12 |
| Current revision | rev 1 for all 12 | sealed rev 2 for all 12 |
| Current ingredient rows with matching catalog ref and revision | 0 of 62 | 62 of 62 |
| Current ingredient rows from `fdc_sr_legacy` | 0 of 62 | 62 of 62 |
| Conflicting catalog food IDs between ref and revision | — | 0 |
| Original rev 1 seals / items / steps | 12 / 62 / 36 | 12 / 62 / 36 |

The read-only preflight (`mise exec -- pnpm exec tsx scripts/repair-recipe-food-mapping.ts --dry-run`) exited 0: `checked=62`, `repairableRecipes=12`, `repairableItems=62`, `missingCatalog=[]`, `missingRefs=0`, `writes=0`. After root authorized the **local-only** mutation, `--write` exited 0: `updatedRecipes=12`, `createdRefs=0`. The script appended a revision and copied items and steps before a compare-and-swap root switch; it never updates a sealed row. Its repair plan accepts only one exact, unsealed `rev+1` after a partial PostgREST failure and resumes missing whole inserts. An inconsistent or sealed pending revision stops for review.

The repeat dry run exited 0 with `repairableRecipes=0`, `repairableItems=0`, `alreadyMapped=62`, `writes=0`. Its `checked=124` includes both historical and current items; the current set is still 62. The original rev 1 item MD5 was `4706ad14635002eb0b23a15258cc1c39` before and after; the step MD5 was `5774a6359ed7ae9541445ab51069a9f9` before and after. Counts and hashes came from direct read-only SQL against the local container. A sealed prior selection's historical snapshot and revision were not altered.

An independent subscription Opus read-only review found no trigger or target-guard blocker and flagged a partial-append retry gap plus a source-description guard. Both were fixed before the local write. The reviewed algorithm still uses separate PostgREST statements; the exact resume path makes a partial failure recoverable without mutating or deleting the old revision. This was a local run with a backup, not a production transaction guarantee.

## Targeted facet warm

The first `mise exec -- pnpm exec tsx scripts/warm-pilot-recipe-facets.ts --dry-run` exited 0: 29 exact mapped revisions, 725 missing facet judgments, five planned batches, zero errors and writes. After root authorized the **local-only** warm, `--commit --user-id=091df4e2-6de9-4524-9875-d13ed1c4e430` used the existing facet lifecycle and synthetic accounting user. It exited 0 with 725 judgments written, zero remaining unknowns and errors, and 319 allergen-evidence rows written. A repeat dry run skipped all 725 cached judgments and made zero writes.

Direct local SQL counted **34 `listed`, 285 `no_evidence`, zero `not_listed`, and zero complete-label records** for these 29 revisions. Because the public fixture has no ingredient-list rows, the warm does not prove an allergen absent; missing composite subingredients stay unverified under active rules. The warm log's `coverage=1` is vacuous for the synthetic account's empty fixed-allergen Avoid list. The stored facet judgments are model outputs from the existing provider path, not invented values; neither they nor the original estimated nutrition prove taste, kitchen testing, or label safety.

Focused verification: six recipe/facet files, 48/48 tests pass; `tsc --noEmit` and changed-file ESLint exit 0. The focused tests include duplicate-description source mapping, an active-description mismatch refusal, exact partial-repair resumption, a peanut-in-sauce positive rule match, and missing composite ingredient text staying unknown. No full suite was run in this worker.
