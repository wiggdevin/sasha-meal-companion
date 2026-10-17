/**
 * One row builder per `seed` id in tests/tenancy/table-ops.json. A builder creates the parent rows
 * it needs with the admin client (owned by `owner`) and returns the row itself NOT inserted, so a
 * caller can either seed it (admin) or try to insert it as a user.
 *
 * `match` identifies the row uniquely and is never changed by `touch`, except where the table's
 * key is all it has (duplicate_group_members). Keys are random, so builders never collide with each
 * other or with rows other suites leave behind.
 */
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { adminClient } from "../helpers/supabase";
import { seedPilotCatalog } from "@/lib/server/recipe-catalog-seed";

export type Row = Record<string, unknown>;
export type Fixture = {
  table: string;
  row: Row;
  match: Row;
  /** Rows to delete before this one is inserted; `match` when absent (singletons). */
  clear?: Row;
  /** A harmless change to make on update; `actor` is the user running it. */
  touch: (actor: string) => Row;
};
type Builder = (owner: string) => Promise<Fixture>;

const admin = () => adminClient();

async function insert(table: string, row: Row): Promise<void> {
  const { error } = await admin().from(table).insert(row);
  if (error) throw new Error(`seed ${table}: ${error.message}`);
}

/** A random date far from the dates other suites use, for tables unique per user and date. */
function randomDate(): string {
  const day = new Date(Date.UTC(2040, 0, 1) + randomInt(0, 20_000) * 86_400_000);
  return day.toISOString().slice(0, 10);
}

const hex = (bytes = 32) => `\\x${randomBytes(bytes).toString("hex")}`;
const withId = (table: string, row: Row, touch: Row): Fixture => {
  const id = randomUUID();
  return { table, row: { id, ...row }, match: { id }, touch: () => touch };
};

async function userFood(owner: string): Promise<string> {
  const id = randomUUID();
  await insert("user_foods", { id, user_id: owner, name: "Tenancy food", kind: "custom" });
  return id;
}

async function foodRef(owner: string): Promise<string> {
  const id = randomUUID();
  await insert("food_refs", { id, kind: "user", user_food_id: await userFood(owner) });
  return id;
}

async function parent(table: string, owner: string, row: Row = {}): Promise<string> {
  const f = await BUILDERS[table](owner);
  await insert(table, { ...f.row, ...row });
  return f.row.id as string;
}

async function healthSource(owner: string): Promise<string> {
  return parent("health_sources", owner);
}

let catalogIds: Promise<{ recipeId: string; revisionId: string }> | undefined;
function catalogRecipe(): Promise<{ recipeId: string; revisionId: string }> {
  catalogIds ??= (async () => {
    await seedPilotCatalog(admin());
    const { data, error } = await admin().from("recipe_catalog")
      .select("id,current_revision_id").eq("slug", "lentil-carrot-tomato-stew").single();
    if (error || !data?.current_revision_id) throw new Error(`seed catalog: ${error?.message}`);
    return { recipeId: data.id, revisionId: data.current_revision_id };
  })();
  return catalogIds;
}

export const BUILDERS: Record<string, Builder> = {
  // Phase 18 W2b: written only by the rules-clock triggers; the owner reads it.
  account_rules_clock: async (owner) => ({ table: "account_rules_clock", row: { user_id: owner, rules_rev: 1 },
    match: { user_id: owner }, touch: () => ({ rules_rev: 99 }) }),
  ai_calls: async (owner) => withId("ai_calls", { user_id: owner, purpose: "tenancy",
    provider: "test", model_id: "test-model", sdk_version: "1" }, { purpose: "touched" }),
  // Scale S2: written only by the ai_spend_* functions; no client role holds any grant.
  ai_spend_reservations: async (owner) => withId("ai_spend_reservations", { user_id: owner,
    day: "2041-01-01", amount_usd: 0.01, expires_at: new Date(Date.now() + 60_000).toISOString() },
  { amount_usd: 0.02 }),
  ai_spend_user_days: async (owner) => {
    const day = `2041-${String(randomInt(1, 13)).padStart(2, "0")}-${String(randomInt(1, 29)).padStart(2, "0")}`;
    return { table: "ai_spend_user_days", row: { user_id: owner, day, spent_usd: 0.5 },
      match: { user_id: owner, day }, touch: () => ({ spent_usd: 0.75 }) };
  },
  api_tokens: async (owner) => withId("api_tokens", { user_id: owner, label: "tenancy",
    token_hash: hex() }, { label: "touched" }),
  change_log: async (owner) => {
    const seq = randomInt(1_000_000, 2_000_000_000);
    return { table: "change_log", row: { user_id: owner, seq, entity: "water_log",
      entity_key: "tenancy", rev: 1, op: "create" }, match: { user_id: owner, seq },
      touch: () => ({ rev: 2 }) };
  },
  sync_op_receipts: async (owner) => {
    // Written only by the change_log insert trigger; service_role inserts the receipt here as it.
    const opId = randomUUID();
    return { table: "sync_op_receipts", row: { op_id: opId, user_id: owner, outcome: "applied" },
      match: { op_id: opId }, touch: () => ({ at: new Date().toISOString() }) };
  },
  change_seq: async (owner) => ({ table: "change_seq", row: { user_id: owner, next_seq: 5 },
    match: { user_id: owner }, touch: () => ({ next_seq: 99 }) }),
  client_timings: async (owner) => {
    const runId = randomUUID();
    return { table: "client_timings", row: { user_id: owner, run_id: runId, path: "barcode",
      step: "decode", ms: 1 }, match: { run_id: runId }, touch: () => ({ ms: 2 }) };
  },
  coach_action_undos: async (owner) => {
    // Its thread and message are the owner's own; only record_coach_undo writes this table.
    const threadId = await parent("coach_threads", owner, { kind: "plan" });
    const messageId = randomUUID();
    await insert("coach_messages", { id: messageId, user_id: owner, role: "assistant", seq: 1,
      content: "tenancy", thread_id: threadId });
    return withId("coach_action_undos", { user_id: owner, thread_id: threadId,
      message_id: messageId, action_id: randomUUID(), kind: "save_recipe", inverse: {} },
    { kind: "log_water" });
  },
  coach_action_receipts: async (owner) =>
    // Immutable and written only by apply_coach_op; service_role inserts it here as that writer.
    withId("coach_action_receipts", { user_id: owner, action_id: randomUUID(), kind: "log_meal",
      op_id: randomUUID(), entity: "log_entries", entity_id: randomUUID(), source_check: "none",
      applied: {} }, { source_check: "match" }),
  taste_chip_receipts: async (owner) =>
    // Written only by taste_chips_confirm; service_role inserts it here as that writer.
    withId("taste_chip_receipts", { user_id: owner, action_id: randomUUID(), source: "settings",
      requested_dislikes: ["t:soft"], requested_cuisines: [], added_dislikes: ["t:soft"], added_cuisines: [],
      present_dislikes: [], present_cuisines: [], capped_dislikes: [], capped_cuisines: [] },
    { added_dislikes: [] }),
  // Followups #1: written only by taste_dislike_remove; service_role inserts it here as that writer.
  taste_dislike_removals: async (owner) => withId("taste_dislike_removals", { user_id: owner,
    action_id: randomUUID(), key: "t:bitter", removed: true, settings_rev: 1 }, { key: "t:soft" }),
  taste_chip_holds: async (owner) => {
    // Written only by taste_chips_confirm (and ended by its release trigger); service_role inserts
    // the receipt and the hold here as that writer.
    const receipt = randomUUID();
    await insert("taste_chip_receipts", { id: receipt, user_id: owner, action_id: randomUUID(), source: "settings",
      requested_dislikes: ["t:soft"], requested_cuisines: [], added_dislikes: ["t:soft"], added_cuisines: [],
      present_dislikes: [], present_cuisines: [], capped_dislikes: [], capped_cuisines: [] });
    const key = `f:hold ${randomUUID()}`;
    return { table: "taste_chip_holds", row: { user_id: owner, receipt_id: receipt, kind: "dislike", key },
      match: { user_id: owner, kind: "dislike", key }, touch: () => ({ key: `${key} touched` }) };
  },
  coach_intent_events: async (owner) => {
    const latency = randomInt(1_000_000, 2_000_000_000);
    return { table: "coach_intent_events", row: { user_id: owner, fast_path_taken: false,
      fallback_reason: "none", latency_ms: latency }, match: { user_id: owner, latency_ms: latency },
      touch: () => ({ fast_path_taken: true }) };
  },
  coach_messages: async (owner) => withId("coach_messages", { user_id: owner, role: "user", seq: 1,
    content: "tenancy", thread_id: await parent("coach_threads", owner, { kind: "plan" }) },
    { content: "touched" }),
  coach_threads: async (owner) => withId("coach_threads", { user_id: owner, title: "tenancy" },
    { title: "touched" }),
  constraint_profiles: async (owner) => ({ table: "constraint_profiles",
    row: { user_id: owner, notes: "tenancy" }, match: { user_id: owner },
    touch: () => ({ notes: "touched" }) }),
  duplicate_group_members: async (owner) => {
    const [groupId, entryId, other] = await Promise.all([parent("duplicate_groups", owner),
      parent("log_entries", owner), parent("log_entries", owner)]);
    return { table: "duplicate_group_members", row: { group_id: groupId, entry_id: entryId },
      match: { group_id: groupId, entry_id: entryId }, touch: () => ({ entry_id: other }) };
  },
  duplicate_groups: async (owner) => withId("duplicate_groups", { user_id: owner,
    local_date: randomDate(), fingerprint: hex(), slot: "meal-1" }, { slot: "meal-2" }),
  expenditure_estimates: async (owner) => withId("expenditure_estimates", { user_id: owner,
    local_date: randomDate(), engine_version: "tenancy", status: "held" }, { reason: "touched" }),
  favorites_catalog_recipes: async (owner) => {
    const { recipeId } = await catalogRecipe();
    return { table: "favorites_catalog_recipes", row: { user_id: owner, recipe_id: recipeId,
      sort: 0 }, match: { user_id: owner, recipe_id: recipeId }, touch: () => ({ sort: 7 }) };
  },
  favorites_foods: async (owner) => {
    const ref = await foodRef(owner);
    return { table: "favorites_foods", row: { user_id: owner, food_ref_id: ref },
      match: { user_id: owner, food_ref_id: ref }, touch: () => ({ sort: 7 }) };
  },
  favorites_meal_items: async (owner) => {
    const [mealId, ref] = await Promise.all([parent("favorites_meals", owner), foodRef(owner)]);
    return { table: "favorites_meal_items", row: { meal_id: mealId, seq: 1, food_ref_id: ref,
      grams: 100 }, match: { meal_id: mealId, seq: 1 }, touch: () => ({ grams: 50 }) };
  },
  favorites_meals: async (owner) => withId("favorites_meals", { user_id: owner, name: "tenancy" },
    { name: "touched" }),
  favorites_recipes: async (owner) => {
    const recipeId = await parent("recipes", owner);
    return { table: "favorites_recipes", row: { user_id: owner, recipe_id: recipeId },
      match: { user_id: owner, recipe_id: recipeId }, touch: () => ({ sort: 7 }) };
  },
  // Phase 13 §5: a user-food evidence row (catalog rows have no owner and are readable by all).
  food_allergen_evidence: async (owner) => {
    const key = `user_food:${randomUUID()}:1`;
    return { table: "food_allergen_evidence", row: { food_key: key, allergen: "dairy",
      level: "no_evidence", label_complete: false, source: "legacy", user_id: owner },
      match: { food_key: key }, touch: () => ({ level: "listed" }) };
  },
  food_facets: async (owner) => {
    const key = `tenancy-${randomUUID()}`;
    return { table: "food_facets", row: { food_key: key, input_hash: hex(), facet: "tenancy",
      rubric_version: 1, p: 0.5, model: "test", user_id: owner }, match: { food_key: key },
      touch: () => ({ model: "touched" }) };
  },
  food_membership_revisions: async (owner) => {
    const name = `tenancy ${randomUUID()}`;
    return { table: "food_membership_revisions", row: { user_id: owner, name_norm: name, rev: 1,
      status: "eats" }, match: { user_id: owner, name_norm: name },
      touch: () => ({ note: "touched" }) };
  },
  // W029: the membership op ledger (migration 20261231110000), written only by set_food_membership.
  food_membership_ops: async (owner) => {
    const opId = randomUUID();
    return { table: "food_membership_ops", row: { op_id: opId, user_id: owner, name_norm: `tenancy ${opId}`,
      result: { rev: 1, status: "eats" } }, match: { op_id: opId },
      touch: () => ({ name_norm: "touched" }) };
  },
  food_note_authority: async (owner) => {
    const name = `tenancy ${randomUUID()}`;
    return { table: "food_note_authority", row: { user_id: owner, name_norm: name,
      note: "tenancy" }, match: { user_id: owner, name_norm: name },
      touch: () => ({ note: "touched" }) };
  },
  // Phase 18 W6: one tap on an offered food, its slate attached (the food is in the slate).
  food_signal_events: async (owner) => withId("food_signal_events", { user_id: owner,
    client_event_id: randomUUID(), slate_id: randomUUID(), at: new Date().toISOString(),
    local_date: new Date().toISOString().slice(0, 10), surface: "plan_sheet", kind: "not_this",
    occasion: "lunch", chosen_key: "food:tenancy-rice", offered_keys: ["food:tenancy-rice", "catalog:42"],
    ranking_version: "o2.1" }, { kind: "picked" }),
  // Followups #18: written only by the service role since W070 (record_onboarding_events_for);
  // `authenticated` has no operation on it -- see onboarding_events in table-ops.json. A
  // well-shaped step_entered row.
  onboarding_events: async (owner) => withId("onboarding_events", { user_id: owner,
    client_event_id: randomUUID(), at: new Date().toISOString(), flow_version: "onboarding_v2",
    kind: "step_entered", step: "facts" }, { step: "allergy" }),
  // Phase 18 W2b: written only by POST /api/foods/world (service role); the owner reads it.
  food_world_condition_confirmations: async (owner) => ({ table: "food_world_condition_confirmations",
    row: { user_id: owner, condition_key: "tenancy", choice: "no_limit" },
    match: { user_id: owner, condition_key: "tenancy" }, touch: () => ({ choice: "pack" }) }),
  food_refs: async (owner) => withId("food_refs", { kind: "user",
    user_food_id: await userFood(owner) }, { user_food_id: await userFood(owner) }),
  gut_log: async (owner) => withId("gut_log", { user_id: owner, local_date: randomDate(), tz: "UTC",
    state: "good" }, { state: "iffy" }),
  health_samples: async (owner) => withId("health_samples", { user_id: owner,
    source_id: await healthSource(owner), type: "step_count", value: 1, unit: "count",
    start_time: "2040-01-01T12:00:00Z", end_time: "2040-01-01T12:00:00Z", tz: "UTC" }, { value: 2 }),
  health_sources: async (owner) => withId("health_sources", { user_id: owner,
    kind: "health_auto_export", device_label: "tenancy" }, { device_label: "touched" }),
  ingest_events: async (owner) => withId("ingest_events", { user_id: owner, status: "ok",
    source_id: await healthSource(owner), payload_hash: hex() }, { error: "touched" }),
  job_runs: async (owner) => {
    const key = randomUUID();
    return { table: "job_runs", row: { job: "tenancy", run_key: key, user_id: owner, status: "ok" },
      match: { job: "tenancy", run_key: key, user_id: owner }, touch: () => ({ detail: { t: 1 } }) };
  },
  log_entries: async (owner) => withId("log_entries", { user_id: owner,
    eaten_at: "2040-01-01T12:00:00Z", tz: "UTC", local_date: randomDate(), slot: "meal-1",
    method: "search" }, { note: "touched" }),
  log_items: async (owner) => {
    const [entryId, ref] = await Promise.all([parent("log_entries", owner), foodRef(owner)]);
    return withId("log_items", { entry_id: entryId, seq: 1, qty: 1, unit: "g", food_ref_id: ref,
      snapshot: {}, grams: 100 }, { grams: 50 });
  },
  media_objects: async (owner) => {
    const path = `media/${owner}/${randomUUID()}.jpg`; // the owner-path CHECK (W019)
    return { table: "media_objects", row: { path, user_id: owner, kind: "image", bytes: 3 },
      match: { path }, touch: () => ({ bytes: 4 }) };
  },
  oauth_states: async (owner) => {
    const hash = hex();
    return { table: "oauth_states", row: { state_hash: hash, provider: "oura", user_id: owner,
      expires_at: "2040-01-01T00:00:00Z" }, match: { state_hash: hash },
      touch: () => ({ consumed_at: "2040-01-01T00:00:00Z" }) };
  },
  plan_days: async (owner) => {
    const date = randomDate();
    return { table: "plan_days", row: { user_id: owner, local_date: date },
      match: { user_id: owner, local_date: date }, touch: () => ({ floor_day: true }) };
  },
  recipe_consumed_requests: async (owner) => {
    const requestId = randomUUID();
    return { table: "recipe_consumed_requests", row: { user_id: owner,
      request_id: requestId, local_date: randomDate(), slot_id: "meal-1",
      selection_id: randomUUID(), plan_revision: 1, actual_servings: 1,
      snapshot: { baseMealId: `recipe:${randomUUID()}`, title: "Tenancy meal",
        components: [{ name: "Tenancy meal", qty: 1, unit: "whole", role: "free",
          macros: { kcal: 100, protein: 10, carbs: 10, fat: 2 } }] } },
      match: { user_id: owner, request_id: requestId }, touch: () => ({ actual_servings: 2 }) };
  },
  recipe_consumed_slot_state: async (owner) => {
    const date = randomDate();
    const epoch = randomUUID();
    return { table: "recipe_consumed_slot_state",
      row: { user_id: owner, local_date: date, slot_id: "meal-1", history_epoch: epoch,
        mark: { eaten_at: null, changed_at: "2041-01-01T00:00:00Z", history_epoch: epoch } },
      match: { user_id: owner, local_date: date, slot_id: "meal-1" },
      touch: () => ({ mark: { eaten_at: null, changed_at: "2041-01-02T00:00:00Z",
        history_epoch: epoch } }) };
  },
  recipe_consumed_undo_requests: async (owner) => {
    const requestId = randomUUID();
    const epoch = randomUUID();
    return { table: "recipe_consumed_undo_requests",
      row: { user_id: owner, request_id: requestId, local_date: randomDate(),
        slot_id: "meal-1", expected_changed_at: "2041-01-01T00:00:00Z",
        mark: { eaten_at: null, changed_at: "2041-01-02T00:00:00Z", history_epoch: epoch } },
      match: { user_id: owner, request_id: requestId },
      touch: () => ({ mark: { eaten_at: null, changed_at: "2041-01-03T00:00:00Z",
        history_epoch: epoch } }) };
  },
  recipe_plan_previews: async (owner) => withId("recipe_plan_previews", { user_id: owner,
    kind: "recipe", proof: {}, state_rev: 0,
    expires_at: new Date(Date.now() + 600_000).toISOString() }, { proof: { touched: true } }),
  recipe_plan_selections: async (owner) => {
    const [{ recipeId, revisionId }, targetId] = await Promise.all([
      catalogRecipe(), parent("target_profiles", owner),
    ]);
    return withId("recipe_plan_selections", { user_id: owner, local_date: randomDate(),
      slot_id: "meal-1", recipe_id: recipeId, recipe_revision_id: revisionId,
      recipe_name: "Tenancy recipe", serving_fraction: 1, ingredient_snapshot: [],
      nutrition_snapshot: {}, exact_fit_available: true, approximate_fit_available: false,
      evidence_issues: [], target_revision_id: targetId }, { recipe_name: "Touched recipe" });
  },
  recipe_plan_state: async (owner) => ({ table: "recipe_plan_state",
    row: { user_id: owner, rev: 1 }, match: { user_id: owner }, touch: () => ({ rev: 2 }) }),
  recipe_items: async (owner) => {
    const [revisionId, ref] = await Promise.all([parent("recipe_revisions", owner), foodRef(owner)]);
    return { table: "recipe_items", row: { recipe_revision_id: revisionId, seq: 1, qty: 1,
      unit: "g", food_ref_id: ref, grams: 100 }, match: { recipe_revision_id: revisionId, seq: 1 },
      touch: () => ({ grams: 50 }) };
  },
  recipe_revisions: async (owner) => withId("recipe_revisions", {
    recipe_id: await parent("recipes", owner), rev: 1 }, { rev: 2 }),
  recipes: async (owner) => withId("recipes", { user_id: owner, name: "tenancy", servings: 1 },
    { name: "touched" }),
  shopping_lines: async (owner) => withId("shopping_lines", { user_id: owner,
    period_id: await parent("shopping_periods", owner), origin: "manual", name: "Tenancy rice",
    category: "manual", purchase_conversion_status: "unknown" }, { note: "touched" }),
  shopping_pantry: async (owner) => withId("shopping_pantry", { user_id: owner,
    name: `Tenancy rice ${randomUUID()}`, identity: { foodDbId: randomUUID() } },
    { confirmed_grams: 100 }),
  shopping_periods: async (owner) => {
    const date = randomDate();
    return withId("shopping_periods", { user_id: owner,
      start_date: date, end_date: date, timezone: "UTC", people: 1,
      mode: "simple", effort: "minimal", variety: "balanced" }, { people: 2 });
  },
  shopping_purchase_window_edits: async (owner) => {
    const windowId = await parent("shopping_purchase_windows", owner);
    const requestId = randomUUID();
    return { table: "shopping_purchase_window_edits", row: { user_id: owner,
      request_id: requestId, window_id: windowId, submitted: { checked: true } },
      match: { user_id: owner, request_id: requestId }, touch: () => ({ submitted: { checked: false } }) };
  },
  shopping_purchase_windows: async (owner) => {
    const periodId = await parent("shopping_periods", owner);
    const lineId = await parent("shopping_lines", owner, { period_id: periodId, origin: "plan" });
    return withId("shopping_purchase_windows", { user_id: owner, period_id: periodId,
      line_id: lineId, window_start_date: "2041-01-01", window_end_date: "2041-01-02",
      need_grams: 100, buy_grams: 100 }, { note: "touched" });
  },
  target_profiles: async (owner) => withId("target_profiles", { user_id: owner,
    effective_from: randomDate(), kcal_train: 2000, kcal_rest: 1800, authored_by: "user",
    mode: "grams", protein_g_min: 100, protein_g: 100, fat_g: 50, carb_g: 200 }, { kcal_rest: 1700 }),
  target_proposals: async (owner) => {
    const id = randomUUID();
    return { table: "target_proposals", row: { id, user_id: owner, proposed: {},
      week_start: randomDate() }, match: { id },
      // One pending proposal per user (target_proposals_one_pending): clear the owner's first.
      clear: { user_id: owner },
      touch: (actor) => ({ status: "rejected", decided_by: actor,
        decided_at: new Date().toISOString() }) };
  },
  user_food_prefs: async (owner) => {
    const ref = await foodRef(owner);
    return { table: "user_food_prefs", row: { user_id: owner, food_ref_id: ref, status: "eats" },
      match: { user_id: owner, food_ref_id: ref }, touch: () => ({ note: "touched" }) };
  },
  user_foods: async (owner) => withId("user_foods", { user_id: owner, name: "tenancy",
    kind: "custom" }, { name: "touched" }),
  user_settings: async (owner) => ({ table: "user_settings", row: { user_id: owner,
    first_opened_at: "2040-01-01T00:00:00Z" }, match: { user_id: owner },
    touch: () => ({ shift_minutes: 15 }) }),
  user_allergen_checks: async (owner) => {
    // A real, owned user_foods row at its default rev (1) — not a random catalog revision id:
    // 20261118090000_allergen_evidence.sql's user_allergen_checks_validate_food_key trigger now
    // refuses a food_key that names no real, same-owner row at the exact revision it claims.
    const key = `user_food:${await userFood(owner)}:1`;
    return { table: "user_allergen_checks", row: { user_id: owner, food_key: key,
      allergen: "gluten" }, match: { user_id: owner, food_key: key },
      touch: () => ({ checked_at: new Date().toISOString() }) };
  },
  // Phase 13 §4: one confirmed catalog profile per (user, profile). No rule items: the table
  // stores whatever buildProfileInstance produced and the matrix only needs a valid owned row.
  user_dietary_profiles: async (owner) => ({ table: "user_dietary_profiles",
    row: { user_id: owner, profile_id: "vegetarian_lacto_ovo", source: "user_stated",
      confirmed_at: "2040-01-01T00:00:00Z" },
    match: { user_id: owner, profile_id: "vegetarian_lacto_ovo" },
    touch: () => ({ notes: "touched" }) }),
  water_log: async (owner) => {
    const date = randomDate();
    return { table: "water_log", row: { user_id: owner, local_date: date, cups: 1 },
      match: { user_id: owner, local_date: date }, touch: () => ({ cups: 2 }) };
  },
  // UI-NEEDS SPROUT-CARE: care_items/care_accolade_defs are the global, seeded catalogs
  // (20261225090200/090300); every fixture below points at one of their real rows.
  care_points_ledger: async (owner) => withId("care_points_ledger", { user_id: owner,
    event_key: `tenancy:${randomUUID()}`, rule_version: "v1", kind: "day_recorded", delta: 2,
    local_date: randomDate(), zone: "UTC", status: "settled" }, { status: "reversed" }),
  care_inventory: async (owner) => ({ table: "care_inventory",
    row: { user_id: owner, item_id: "leaf-pin", receipt_id: randomUUID() },
    match: { user_id: owner, item_id: "leaf-pin" }, touch: () => ({ receipt_id: randomUUID() }) }),
  care_equipped: async (owner) => ({ table: "care_equipped",
    row: { user_id: owner, equipped: { pin: "leaf-pin" }, rev: 1 },
    match: { user_id: owner }, touch: () => ({ rev: 2 }) }),
  care_purchase_receipts: async (owner) => {
    const actionId = randomUUID();
    return { table: "care_purchase_receipts",
      row: { user_id: owner, action_id: actionId, item_id: "leaf-pin", price: 10 },
      match: { user_id: owner, action_id: actionId }, touch: () => ({ price: 11 }) };
  },
  care_accolades: async (owner) => ({ table: "care_accolades",
    row: { user_id: owner, key: "first-meal", version: 1 },
    match: { user_id: owner, key: "first-meal", version: 1 }, touch: () => ({ seen_at: "2040-01-01T00:00:00Z" }) }),
  care_messages: async (owner) => withId("care_messages", { user_id: owner, type: "observation",
    payload: { text: "tenancy" } }, { read_at: "2040-01-01T00:00:00Z" }),
};
