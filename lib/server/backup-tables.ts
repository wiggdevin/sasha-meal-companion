/**
 * What the nightly JSON backup (`app/api/jobs/backup/route.ts`) dumps, and what it leaves out.
 *
 * Every table the migrations create is in exactly one of the two lists below.
 * `tests/export/backup-tables.test.ts` reads `supabase/migrations/` and fails when a table is in
 * neither (a new table must be classified before it can merge), in both, or no longer exists, and
 * when a backed-up table's `key` is not its primary key, column for column. The key is what the
 * dump pages by (`key > last`), so it must be unique and complete.
 *
 * Order is restore order: a table comes after every backed-up table it has a foreign key to, so
 * replaying the JSON table by table into an empty schema never meets a missing parent. The test
 * reads every `references` clause in the migrations and checks it. A reference to a table that is
 * not backed up (the shared catalog, `auth.users`) needs that table restored first by its own means.
 */

export type BackupTable = {
  readonly name: string;
  /** The primary key, in its declared column order. */
  readonly key: readonly string[];
};

const table = (name: string, ...key: string[]): BackupTable => ({ name, key: key.length ? key : ["id"] });

/** Every table that holds an account's own rows. */
export const BACKUP_TABLES: readonly BackupTable[] = [
  // Owner tables (user_id column), from the first RLS migration.
  // food_refs is shared, but holds user rows (kind = 'user'); it references user_foods, and the
  // preference, favourite, log and recipe item tables reference it.
  table("user_foods"), table("food_refs"),
  table("user_food_prefs", "user_id", "food_ref_id"), table("log_entries"),
  table("water_log", "user_id", "local_date"), table("plan_days", "user_id", "local_date"),
  table("user_settings", "user_id"), table("gut_log"), table("recipes"),
  table("favorites_foods", "user_id", "food_ref_id"), table("favorites_recipes", "user_id", "recipe_id"),
  table("favorites_meals"), table("target_profiles"), table("expenditure_estimates"),
  table("target_proposals"), table("constraint_profiles", "user_id"), table("coach_threads"),
  table("ai_calls"), table("api_tokens"), table("health_sources"), table("ingest_events"),
  table("health_samples"), table("change_seq", "user_id"), table("change_log", "user_id", "seq"),
  // W048: one row per applied sync op id, so a replay after a restore stays a duplicate. The
  // change_log insert trigger writes them too: a table-by-table replay must insert these with
  // ON CONFLICT DO NOTHING (or disable change_log_op_receipt while it loads change_log).
  table("sync_op_receipts", "op_id"),
  table("duplicate_groups"), table("media_objects", "path"),
  // Child tables reached through their parent.
  table("log_items"), table("duplicate_group_members", "group_id", "entry_id"),
  table("recipe_revisions"), table("recipe_items", "recipe_revision_id", "seq"),
  table("favorites_meal_items", "meal_id", "seq"), table("coach_messages"),
  // Food rules and evidence: dietary profiles, allergen checks, membership and notes.
  table("user_dietary_profiles", "user_id", "profile_id"),
  table("user_allergen_checks", "user_id", "food_key", "allergen"),
  table("food_allergen_evidence", "food_key", "allergen"),
  table("food_membership_revisions", "user_id", "name_norm"),
  // W029: each applied membership op's answer, so a replay after a restore is not applied twice.
  table("food_membership_ops", "op_id"),
  table("food_note_authority", "user_id", "name_norm"),
  table("food_world_condition_confirmations", "user_id", "condition_key"),
  table("account_rules_clock", "user_id"),
  // Shopping.
  table("shopping_periods"), table("shopping_lines"), table("shopping_pantry"),
  table("shopping_purchase_windows"), table("shopping_purchase_window_edits", "user_id", "request_id"),
  // Recipe plans, accepted selections and eaten recipes.
  table("favorites_catalog_recipes", "user_id", "recipe_id"), table("recipe_plan_previews"),
  table("recipe_plan_selections"), table("recipe_plan_state", "user_id"),
  table("recipe_consumed_requests", "user_id", "request_id"),
  table("recipe_consumed_slot_state", "user_id", "local_date", "slot_id"),
  table("recipe_consumed_undo_requests", "user_id", "request_id"),
  // Coach Undo records and receipts, taste chips.
  table("coach_action_undos"), table("coach_action_receipts"),
  table("taste_chip_receipts"), table("taste_chip_holds", "user_id", "kind", "key"),
  table("taste_dislike_removals"),
  // Care (pet) points, items and messages.
  table("care_points_ledger"), table("care_purchase_receipts", "user_id", "action_id"),
  table("care_inventory", "user_id", "item_id"), table("care_equipped", "user_id"),
  table("care_accolades", "user_id", "key", "version"), table("care_messages"),
  // Account events and history.
  table("food_signal_events"), table("onboarding_events"), table("coach_intent_events"),
  table("client_timings"),
];

/** Tables the dump leaves out on purpose, each with the reason. */
export const NOT_BACKED_UP: Readonly<Record<string, string>> = {
  catalog_barcode_lookups: "shared catalog: rebuilt by the importer",
  catalog_barcodes: "shared catalog: rebuilt by the importer",
  catalog_dri: "shared catalog: rebuilt by the importer",
  catalog_food_inputs: "shared catalog: rebuilt by scripts/import-fndds-inputs.ts",
  catalog_food_nutrients: "shared catalog: rebuilt by the importer",
  catalog_food_revisions: "shared catalog: rebuilt by the importer",
  catalog_foods: "shared catalog: rebuilt by the importer",
  catalog_ingredients: "shared catalog: rebuilt by the importer",
  catalog_nutrients: "shared catalog: rebuilt by the importer",
  catalog_portions: "shared catalog: rebuilt by the importer",
  catalog_synonyms: "shared catalog: rebuilt by the importer",
  catalog_versions: "shared catalog: rebuilt by the importer",
  recipe_catalog: "shared recipe catalog: reseeded by scripts/seed-recipe-catalog.ts",
  recipe_catalog_items: "shared recipe catalog: reseeded by scripts/seed-recipe-catalog.ts",
  recipe_catalog_revisions: "shared recipe catalog: reseeded by scripts/seed-recipe-catalog.ts",
  recipe_catalog_seals: "shared recipe catalog: reseeded by scripts/seed-recipe-catalog.ts",
  recipe_catalog_steps: "shared recipe catalog: reseeded by scripts/seed-recipe-catalog.ts",
  care_items: "shared definitions seeded by migration 20261225090200",
  care_accolade_defs: "shared definitions seeded by migration 20261225090300",
  food_facets: "derived model cache: facet-warm computes it again",
  evidence_clock: "one global counter, not account-owned",
  backup_runs: "this job's own bookkeeping",
  job_cursors: "background-job bookkeeping",
  job_runs: "background-job bookkeeping: per-account run locks",
  rate_limits: "rate-limit windows, a few minutes long",
  ai_spend_global_days: "spend-cap accounting: holds expire, days are pruned after 40 days",
  ai_spend_user_days: "spend-cap accounting: holds expire, days are pruned after 40 days",
  ai_spend_reservations: "spend-cap accounting: holds expire, days are pruned after 40 days",
  oauth_states: "short-lived OAuth handshake state",
  legacy_backfill_rows: "one-time legacy import ledger",
};
