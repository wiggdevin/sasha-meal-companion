# W006 and W008 migrations — production receipt (2026-10-11)


Backup taken first: `~/Backups/supabase/meal-companion/2026-10-11T160226Z-7b78d8e8.sql`
(23,757,287 B, sha256 `f871cc373633bc372b4926ec29e2d70b88959465165616e0ac6c7731a52211a2`).
Pre-check for W008: 0 of 70 `target_profiles` rows held `kcal_min_source = 'account_minimum'`.

| Migration | PR | sha256 of the applied file |
|---|---|---|
| `20261231130000_w006_account_day_approval_marks` | #80 (W006) | `9ffd6695620b3291e8bc6a4f77e9452cd3b1702203ea25dffde1676db64d5e9c` |
| `20261231150000_drop_account_minimum` | #86 (W008) | `76e8d518e3f98d3da8d7c1c9bc178710d43ca6f9194e0ef4acb9632a79fbb669` |
| `20261231150001_drop_account_minimum_validate` | #86 (W008) | `447575a13b9fa38ebcf41e0fb9519229e3ef53d28553e485f2c5af06202e8eff` |

Verification: `target_profiles_kcal_min_source_check` is validated and allows only
`macro_minimum` and `legacy_default`. `approve_target_proposal` stays service_role only.
`_account_local_date` is service_role only; its two callers (`approve_target_proposal`,
`plan_days_record_first_mark`) are SECURITY DEFINER, so a signed-in day mark still runs.
Ledger after: `20261231130000`, `20261231150000`, `20261231150001`.
