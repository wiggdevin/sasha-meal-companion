# Local public recipe ingredient fixture proof

2026-09-27 root applied the reviewed transaction to Docker `supabase_db_meal-companion`, verified bound port54322. Working database backup is `~/Backups/sasha/local-foods-annotations-20260927/pre-custom-rules.dump`.

- Test database `sasha_recipe_release_verify_1520`: first run exit0, inserted29 foods,29 revisions,111 portions,29 shared refs.
- Same test database repeat: exit0, all INSERT counts0; final receipt29/29/111/29.
- Working local `postgres`: exit0, inserted29/29/111/29. Active version `local-public-usda-pilot-29-v1`.
- SQL source: root workspace `work/import-public-pilot-fixture.sql`; embedded public fixture SHA256 `53aa15c935bfd67030007892cf676d376f17426d90a439b70f63ea56586ce0ec`.
- Opus review: `opus-pilot-import-review.md`, no blockers.

Scope: local public USDA identities only. No owner rows, production data, nutrient rows or ingredient labels written. Direct catalog nutrition for these partial fixture rows remains unavailable; recipe tests use stored recipe macro snapshots. This is not evidence of production deployment or complete catalog import.
