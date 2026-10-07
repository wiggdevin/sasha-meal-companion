/** L1 production data-integrity sweep. Production is always read-only. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeFoodName } from "@/lib/foods/normalize";
import { uuidV5 } from "@/lib/foods/uuid5";
import { toCanonical } from "@/lib/health/units";
import { TARGET_FORMULA_NAME, deriveTargetRevision } from "@/lib/profile/derive";
import { isProfileComplete } from "@/lib/profile/energy";
import { adminClient } from "@/lib/server/admin";
import { writeDerivedTargets } from "@/lib/server/targets";
import type { Macros, Settings, TargetRevision } from "@/lib/types";
import {
  contradictions, fixContradictions,
} from "@/scripts/food-membership-audit";

const PRODUCTION_REF = "fivatgdpuenszxxnijpc";
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Loop-3 data-integrity finding (2026-10-03): this was hardcoded to
 * `docs/audit/2026-09-19-data-integrity.md`, so every later production run silently overwrote the
 * first day's report instead of leaving a dated trail — the 2026-09-19 report on disk kept
 * showing that day's zero counts long after a later run found real contradictions. The path (and
 * the report's own header) are now stamped from the run clock.
 */
export function reportDate(now: () => number = Date.now): string {
  return new Date(now()).toISOString().slice(0, 10);
}

/** Takes the date `reportDate()` already produced, so a run's header and path can never
 *  disagree with each other over a call that straddles UTC midnight. */
export function reportPath(date: string): string {
  return `docs/audit/${date}-data-integrity.md`;
}
const PAGE_SIZE = 1_000;
const RLS_TABLES = ["user_food_prefs", "food_refs", "user_foods", "user_settings",
  "target_profiles", "plan_days", "health_samples", "water_log"] as const;

type Severity = "high" | "medium" | "low" | "info";
export type FindingName = "membership_contradictions" | "prefs_orphans"
  | "food_refs_dangling" | "food_refs_unused" | "user_foods_without_ref"
  | "targets_consistency" | "profile_ranges" | "plan_slots_on_avoid" | "health_ranges"
  | "rls_smoke";
export type Finding = { name: FindingName; count: number; severity: Severity;
  sampleIds: string[]; fixPath: string };
type ErrorLike = { message: string };
type PageResult<T> = { data: T[] | null; error: ErrorLike | null };
type Contradiction = Awaited<ReturnType<typeof contradictions>>[number];

type PrefRow = { user_id: string; food_ref_id: string; status: "eats" | "avoid";
  updated_at: string };
type RefRow = { id: string; kind: "catalog" | "user"; catalog_food_id: number | null;
  user_food_id: string | null };
type UserFoodRow = { id: string; user_id: string; name: string };
type CatalogRevisionRow = { catalog_food_id: number; description: string };
type SettingsRow = { user_id: string; first_opened_at: string; training_kcal: number | null;
  rest_kcal: number | null; protein_g: number | null; height_cm: number | null;
  birth_year: number | null; sex: "female" | "male" | null; body_fat_pct: number | null;
  weight_kg: number | null; activity_level: Settings["activityLevel"];
  goal: Settings["goal"]; training_weekdays: number[] | null; diet_prefs: unknown;
  onboarded_at: string | null };
type TargetRow = { id: string; user_id: string; effective_from: string; rev: number;
  target_source: TargetRevision["source"] | null; training_macros: unknown; rest_macros: unknown;
  pin_training_kcal: number | null; pin_rest_kcal: number | null; pin_protein_g: number | null;
  input_weight_kg: number | null; input_weight_source: "weigh-in" | "onboarding" | null;
  input_training_weekdays: number[] | null; input_activity_level: Settings["activityLevel"];
  input_goal: Settings["goal"]; formula_name: string | null };
type LegacyTargetRow = Pick<TargetRow, "id" | "user_id" | "effective_from" | "rev">;
type PlanRow = { user_id: string; local_date: string; swaps?: unknown;
  item_overrides?: unknown; components?: unknown; extras?: unknown };
type HealthRow = { id: string; user_id?: string; start_time?: string; value: number; unit: string };
type WaterRow = { user_id: string; local_date: string; cups: number };
type TargetMismatch = { userId: string; settings: SettingsRow; target: TargetRow | null;
  expected: TargetRevision | null; reason: "missing_target" | "settings_drift" | "macro_drift"
    | "u1_columns_unavailable" };
type RepairState = { contradictions: Contradiction[]; orphanPrefs: PrefRow[]; danglingRefs: RefRow[];
  foodsWithoutRef: UserFoodRow[]; targetMismatches: TargetMismatch[] };
type AuditState = { findings: Finding[]; repair: RepairState };

export type Options = { environment: "production" | "branch"; fix: boolean;
  accepted: Set<FindingName>; twice: boolean };

type AvoidIndex = { refs: Set<string>; names: Set<string> };
type RefUseRow = { food_ref_id: string };
type ConstraintRefRow = { avoid_food_ref_ids: string[] | null };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asPage<T>(query: unknown): PromiseLike<PageResult<T>> {
  return query as PromiseLike<PageResult<T>>;
}

async function allRows<T>(
  label: string, page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await page(from, from + PAGE_SIZE - 1);
    if (result.error) throw new Error(`${label}: ${result.error.message}`);
    const batch = result.data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
}

function finding(name: FindingName, severity: Severity, ids: string[], fixPath: string): Finding {
  const stableIds = [...ids].sort();
  return { name, count: stableIds.length, severity, sampleIds: stableIds.slice(0, 5), fixPath };
}

function profileSettings(row: SettingsRow): Settings {
  return {
    trainingKcal: row.training_kcal, restKcal: row.rest_kcal, proteinG: row.protein_g,
    proteinLocked: true, slotTimes: {}, shiftMinutes: 0,
    changedAt: null, heightCm: row.height_cm, birthYear: row.birth_year, sex: row.sex,
    bodyFatPct: row.body_fat_pct, weightKg: row.weight_kg, activityLevel: row.activity_level,
    goal: row.goal, trainingWeekdays: row.training_weekdays,
    dietPrefs: null, onboardedAt: row.onboarded_at,
  };
}

function macro(value: unknown): Macros | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const result = { kcal: Number(row.kcal), protein: Number(row.protein),
    carbs: Number(row.carbs), fat: Number(row.fat) };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

function outsideTolerance(actual: Macros | null, expected: Macros): boolean {
  return !actual || (Object.keys(expected) as Array<keyof Macros>)
    .some((key) => Math.abs(actual[key] - expected[key]) > 1);
}

export function profileRangeIds(rows: SettingsRow[]): string[] {
  return rows.filter((row) => {
    const weekdays = row.training_weekdays;
    return (row.weight_kg !== null && !(row.weight_kg >= 20 && row.weight_kg <= 400))
      || (row.height_cm !== null && !(row.height_cm >= 50 && row.height_cm <= 260))
      || (row.body_fat_pct !== null && !(row.body_fat_pct >= 3 && row.body_fat_pct <= 70))
      || (weekdays !== null && (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
        || new Set(weekdays).size !== weekdays.length))
      || (row.diet_prefs !== null && (typeof row.diet_prefs !== "object"
        || Array.isArray(row.diet_prefs)));
  }).map((row) => row.user_id);
}

function expectedTarget(
  row: SettingsRow, target: TargetRow | null, latestWeighInKg: number | null,
): TargetRevision | null {
  const settings = profileSettings(row);
  if (!isProfileComplete(settings)) return null;
  const date = target?.effective_from ?? row.onboarded_at?.slice(0, 10);
  if (!date) return null;
  const trainingWeekdays = row.training_weekdays ?? [];
  const input = { settings, latestWeighInKg, today: date, trainingWeekdays,
    source: (target?.target_source === "manual" ? "manual" : "derived") as "manual" | "derived" };
  if (!target || target.formula_name === null || target.formula_name === TARGET_FORMULA_NAME) {
    return deriveTargetRevision(input);
  }
  return null; // Proposal/adaptive rows are authoritative, not profile-formula derivations.
}

function sameWeekdays(left: number[] | null, right: number[] | null): boolean {
  return JSON.stringify([...(left ?? [])].sort((a, b) => a - b))
    === JSON.stringify([...(right ?? [])].sort((a, b) => a - b));
}

function targetMatchesSettings(
  row: SettingsRow, target: TargetRow, latestWeighInKg: number | null,
): boolean {
  const expectedWeight = latestWeighInKg ?? row.weight_kg;
  const expectedSource = latestWeighInKg === null ? "onboarding" : "weigh-in";
  const sameNumber = (left: number | null, right: number | null) => left === null || right === null
    ? left === right : Number(left) === Number(right);
  return sameNumber(target.pin_training_kcal, row.training_kcal)
    && sameNumber(target.pin_rest_kcal, row.rest_kcal)
    && sameNumber(target.pin_protein_g, row.protein_g)
    && sameNumber(target.input_weight_kg, expectedWeight)
    && target.input_weight_source === expectedSource
    && sameWeekdays(target.input_training_weekdays, row.training_weekdays)
    && target.input_activity_level === row.activity_level
    && target.input_goal === row.goal;
}

export function targetMismatches(
  settingsRows: SettingsRow[], targetRows: TargetRow[],
  latestWeights = new Map<string, number>(), u1Available = true,
): TargetMismatch[] {
  const latest = new Map<string, TargetRow>();
  for (const target of targetRows) {
    const prior = latest.get(target.user_id);
    if (!prior || target.effective_from > prior.effective_from
      || (target.effective_from === prior.effective_from && target.rev > prior.rev)) {
      latest.set(target.user_id, target);
    }
  }
  const mismatches: TargetMismatch[] = [];
  for (const row of settingsRows) {
    if (!isProfileComplete(profileSettings(row))) continue;
    if (!u1Available) {
      mismatches.push({ userId: row.user_id, settings: row, target: null, expected: null,
        reason: "u1_columns_unavailable" });
      continue;
    }
    const target = latest.get(row.user_id) ?? null;
    const latestWeighInKg = latestWeights.get(row.user_id) ?? null;
    const expected = expectedTarget(row, target, latestWeighInKg);
    if (!target) {
      mismatches.push({ userId: row.user_id, settings: row, target, expected,
        reason: "missing_target" });
      continue;
    }
    if (!targetMatchesSettings(row, target, latestWeighInKg)) {
      mismatches.push({ userId: row.user_id, settings: row, target, expected,
        reason: "settings_drift" });
      continue;
    }
    if (expected && (outsideTolerance(macro(target.training_macros), expected.training)
      || outsideTolerance(macro(target.rest_macros), expected.rest))) {
      mismatches.push({ userId: row.user_id, settings: row, target, expected,
        reason: "macro_drift" });
    }
  }
  return mismatches;
}

function payloadHasAvoid(value: unknown, avoids: AvoidIndex): boolean {
  if (Array.isArray(value)) return value.some((item) => payloadHasAvoid(item, avoids));
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const ref = typeof row.food_ref_id === "string" ? row.food_ref_id
    : typeof row.foodRefId === "string" ? row.foodRefId : null;
  if (ref !== null && avoids.refs.has(ref)) return true;
  if (ref === null && typeof row.name === "string"
    && avoids.names.has(normalizeFoodName(row.name))) return true;
  return Object.entries(row).some(([key, item]) => !["food_ref_id", "foodRefId", "name"].includes(key)
    && payloadHasAvoid(item, avoids));
}

function slotPayloads(row: PlanRow): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const value of [row.swaps, row.item_overrides]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    entries.push(...Object.entries(value));
  }
  if (row.components !== undefined) entries.push(["components", row.components]);
  if (Array.isArray(row.extras)) {
    row.extras.forEach((extra, index) => {
      const id = extra && typeof extra === "object" && typeof (extra as { id?: unknown }).id === "string"
        ? (extra as { id: string }).id : `extra-${index + 1}`;
      entries.push([id, extra]);
    });
  }
  return entries;
}

export function planAvoidIds(rows: PlanRow[], avoidByUser: Map<string, AvoidIndex>): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const avoids = avoidByUser.get(row.user_id);
    if (!avoids) continue;
    for (const [slot, payload] of slotPayloads(row)) {
      if (payloadHasAvoid(payload, avoids)) ids.push(`${row.user_id}:${row.local_date}:${slot}`);
    }
  }
  return [...new Set(ids)];
}

function foodRefTargetExists(
  ref: RefRow, foodIds: Set<string>, catalogIds: Set<number>,
): boolean {
  return ref.kind === "user"
    ? ref.user_food_id !== null && foodIds.has(ref.user_food_id)
    : ref.catalog_food_id !== null && catalogIds.has(ref.catalog_food_id);
}

export function foodRefDanglingIds(
  refs: RefRow[], foodIds: Set<string>, catalogIds: Set<number>,
): string[] {
  return refs.filter((ref) => !foodRefTargetExists(ref, foodIds, catalogIds))
    .map((ref) => ref.id);
}

export function foodRefUnusedIds(
  refs: RefRow[], foodIds: Set<string>, catalogIds: Set<number>, referencedIds: Set<string>,
): string[] {
  return refs.filter((ref) => foodRefTargetExists(ref, foodIds, catalogIds)
    && !referencedIds.has(ref.id)).map((ref) => ref.id);
}

export function healthRangeIds(health: HealthRow[], water: WaterRow[]): string[] {
  const ids = health.filter((row) => {
    try {
      const kg = toCanonical("body_mass", Number(row.value), row.unit).value;
      return !(kg >= 20 && kg <= 400);
    } catch { return true; }
  }).map((row) => row.id);
  return [...ids, ...water.filter((row) => Number(row.cups) * 240 > 10_000)
    .map((row) => `${row.user_id}:${row.local_date}`)];
}

export function membershipContradictionsFromRows(
  prefs: PrefRow[], nameByRef: Map<string, string>,
): Contradiction[] {
  const groups = new Map<string, PrefRow[]>();
  for (const pref of prefs) {
    const name = nameByRef.get(pref.food_ref_id);
    if (!name) continue;
    const key = `${pref.user_id}\u0000${name}`;
    groups.set(key, [...(groups.get(key) ?? []), pref]);
  }
  const rows: Contradiction[] = [];
  for (const [key, group] of groups) {
    if (new Set(group.map((row) => row.status)).size < 2) continue;
    const [userId, nameNorm] = key.split("\u0000");
    const latest = (status: PrefRow["status"]): string | null => group
      .filter((row) => row.status === status).map((row) => row.updated_at).sort().at(-1) ?? null;
    rows.push({ user_id: userId, name_norm: nameNorm, row_count: group.length,
      ref_ids: group.map((row) => row.food_ref_id).sort(), kind: "conflict",
      eats_updated_at: latest("eats"), avoid_updated_at: latest("avoid") });
  }
  return rows.sort((a, b) => `${a.user_id}:${a.name_norm}`.localeCompare(`${b.user_id}:${b.name_norm}`));
}

function projectRef(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL not set");
  const ref = new URL(url).hostname.split(".")[0];
  if (!/^[a-z0-9]{15,30}$/.test(ref)) throw new Error("could not derive Supabase project ref");
  return ref;
}

export async function rlsDisabledIds(
  ref: string, token: string,
  request: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<string[]> {
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN not set for RLS check");
  const names = RLS_TABLES.map((table) => `'${table}'`).join(",");
  const query = `select c.relname as tablename, c.relrowsecurity
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in (${names}) order by c.relname`;
  const response = await request(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`RLS Management API query returned ${response.status}`);
  const rows = await response.json() as Array<{ tablename: string; relrowsecurity: boolean }>;
  const byName = new Map(rows.map((row) => [row.tablename, row]));
  return RLS_TABLES.filter((table) => {
    const row = byName.get(table);
    return !row || !row.relrowsecurity;
  });
}

async function readTargets(
  admin: SupabaseClient,
): Promise<{ rows: TargetRow[]; u1Available: boolean }> {
  try {
    const rows = await allRows<TargetRow>("target_profiles", (from, to) => asPage<TargetRow>(admin
      .from("target_profiles").select("id,user_id,effective_from,rev,target_source,training_macros,"
        + "rest_macros,pin_training_kcal,pin_rest_kcal,pin_protein_g,input_weight_kg,"
        + "input_weight_source,input_training_weekdays,input_activity_level,input_goal,formula_name")
      .range(from, to)));
    return { rows, u1Available: true };
  } catch (error) {
    if (!message(error).includes("target_source")) throw error;
    const legacy = await allRows<LegacyTargetRow>("target_profiles legacy", (from, to) => admin
      .from("target_profiles").select("id,user_id,effective_from,rev").range(from, to));
    return { u1Available: false, rows: legacy.map((row) => ({ ...row,
      target_source: null, training_macros: null,
      rest_macros: null, pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null,
      input_weight_kg: null, input_weight_source: null, input_training_weekdays: null,
      input_activity_level: null, input_goal: null, formula_name: null })) };
  }
}

function latestWeights(health: HealthRow[]): Map<string, number> {
  const latest = new Map<string, { date: string; kg: number }>();
  for (const row of health) {
    if (!row.user_id || !row.start_time) continue;
    try {
      const kg = toCanonical("body_mass", Number(row.value), row.unit).value;
      const prior = latest.get(row.user_id);
      if (!prior || row.start_time > prior.date) latest.set(row.user_id, { date: row.start_time, kg });
    } catch { /* health_ranges reports the malformed source row */ }
  }
  return new Map([...latest].map(([userId, row]) => [userId, row.kg]));
}

async function referencedFoodRefIds(admin: SupabaseClient, prefs: PrefRow[]): Promise<Set<string>> {
  const tables = ["recipe_items", "favorites_foods", "favorites_meal_items", "log_items"];
  const ids = new Set(prefs.map((row) => row.food_ref_id));
  for (const table of tables) {
    const rows = await allRows<RefUseRow>(table, (from, to) => admin.from(table)
      .select("food_ref_id").range(from, to));
    rows.forEach((row) => ids.add(row.food_ref_id));
  }
  const constraints = await allRows<ConstraintRefRow>("constraint_profiles", (from, to) => admin
    .from("constraint_profiles").select("avoid_food_ref_ids").range(from, to));
  constraints.forEach((row) => row.avoid_food_ref_ids?.forEach((id) => ids.add(id)));
  return ids;
}

function addPayloadRefIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => addPayloadRefIds(item, ids));
    return;
  }
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  const ref = typeof row.food_ref_id === "string" ? row.food_ref_id
    : typeof row.foodRefId === "string" ? row.foodRefId : null;
  if (ref) ids.add(ref);
  Object.values(row).forEach((item) => addPayloadRefIds(item, ids));
}

async function collect(admin: SupabaseClient): Promise<AuditState> {
  const prefs = await allRows<PrefRow>("user_food_prefs", (from, to) => admin
    .from("user_food_prefs").select("user_id,food_ref_id,status,updated_at").range(from, to));
  const refs = await allRows<RefRow>("food_refs", (from, to) => admin.from("food_refs")
    .select("id,kind,catalog_food_id,user_food_id").range(from, to));
  const foods = await allRows<UserFoodRow>("user_foods", (from, to) => admin.from("user_foods")
    .select("id,user_id,name").range(from, to));
  const revisions = await allRows<CatalogRevisionRow>("catalog_food_revisions", (from, to) => admin
    .from("catalog_food_revisions").select("catalog_food_id,description")
    .eq("is_active", true).range(from, to));
  const refById = new Map(refs.map((row) => [row.id, row]));
  const foodById = new Map(foods.map((row) => [row.id, row]));
  const revisionByFood = new Map(revisions.map((row) => [row.catalog_food_id, row]));
  const nameByRef = new Map<string, string>();
  for (const ref of refs) {
    const name = ref.kind === "user" && ref.user_food_id ? foodById.get(ref.user_food_id)?.name
      : ref.catalog_food_id === null ? undefined : revisionByFood.get(ref.catalog_food_id)?.description;
    if (name) nameByRef.set(ref.id, normalizeFoodName(name));
  }
  let contradictionRows: Contradiction[];
  try {
    contradictionRows = await contradictions(admin);
  } catch (error) {
    if (!message(error).includes("food_membership_contradictions")) throw error;
    contradictionRows = membershipContradictionsFromRows(prefs, nameByRef);
  }
  const orphanPrefs = prefs.filter((pref) => {
    const ref = refById.get(pref.food_ref_id);
    return !ref || (ref.kind === "user" && (!ref.user_food_id || !foodById.has(ref.user_food_id)))
      || (ref.kind === "catalog" && (ref.catalog_food_id === null
        || !revisionByFood.has(ref.catalog_food_id)));
  });
  const referencedFoods = new Set(refs.filter((row) => row.kind === "user" && row.user_food_id)
    .map((row) => row.user_food_id as string));
  const foodsWithoutRef = foods.filter((row) => !referencedFoods.has(row.id));
  const usedRefIds = await referencedFoodRefIds(admin, prefs);

  const settings = await allRows<SettingsRow>("user_settings", (from, to) => asPage<SettingsRow>(admin
    .from("user_settings").select("user_id,first_opened_at,training_kcal,rest_kcal,protein_g,"
      + "height_cm,birth_year,sex,body_fat_pct,weight_kg,activity_level,goal,training_weekdays,"
      + "diet_prefs,onboarded_at").range(from, to)));
  const targets = await readTargets(admin);

  const avoidByUser = new Map<string, AvoidIndex>();
  for (const pref of prefs.filter((row) => row.status === "avoid")) {
    const name = nameByRef.get(pref.food_ref_id);
    const index = avoidByUser.get(pref.user_id)
      ?? { refs: new Set<string>(), names: new Set<string>() };
    index.refs.add(pref.food_ref_id);
    if (name) index.names.add(name);
    avoidByUser.set(pref.user_id, index);
  }
  const plans = await allRows<PlanRow>("plan_days", (from, to) => admin.from("plan_days")
    .select("user_id,local_date,swaps,item_overrides").range(from, to));
  plans.forEach((row) => addPayloadRefIds(row, usedRefIds));
  const foodIds = new Set(foods.map((row) => row.id));
  const catalogIds = new Set(revisions.map((row) => row.catalog_food_id));
  const danglingRefIds = foodRefDanglingIds(refs, foodIds, catalogIds);
  const danglingRefIdSet = new Set(danglingRefIds);
  const danglingRefs = refs.filter((row) => danglingRefIdSet.has(row.id));
  const unusedRefIds = foodRefUnusedIds(refs, foodIds, catalogIds, usedRefIds);
  const planIds = planAvoidIds(plans, avoidByUser);
  const health = await allRows<HealthRow>("health_samples", (from, to) => admin
    .from("health_samples").select("id,user_id,start_time,value,unit")
    .eq("type", "body_mass").range(from, to));
  const mismatches = targetMismatches(settings, targets.rows, latestWeights(health),
    targets.u1Available);
  const water = await allRows<WaterRow>("water_log", (from, to) => admin.from("water_log")
    .select("user_id,local_date,cups").range(from, to));

  const findings: Finding[] = [
    finding("membership_contradictions", "high", contradictionRows.map((row) => row.user_id),
      "scripts/food-membership-audit.ts --fix (branch; production needs --fix --production)"),
    finding("prefs_orphans", "medium", orphanPrefs.map((row) => row.food_ref_id),
      "delete orphan prefs (--branch --fix only)"),
    finding("food_refs_dangling", "medium", danglingRefIds,
      "delete dangling ref (--branch --fix only; production requires owner step)"),
    finding("food_refs_unused", "info", unusedRefIds,
      "none; informational only"),
    finding("user_foods_without_ref", "low", foodsWithoutRef.map((row) => row.id),
      "mint deterministic UUID v5 ref (--branch --fix only)"),
    finding("targets_consistency", "high", mismatches.map((row) => row.reason
      === "u1_columns_unavailable" ? `${row.userId}: U1 columns unavailable` : row.userId),
    mismatches.some((row) => row.reason === "u1_columns_unavailable")
      ? "apply the U1 target-authority migration before claiming consistency"
      : "scripts/recompute-target.ts --user-id <id> --fix (production needs --fix --production)"),
    finding("profile_ranges", "medium", profileRangeIds(settings),
      "owner step: correct the stored profile input"),
    finding("plan_slots_on_avoid", "high", planIds,
      "owner step: review the stored slot; rotation rules guard new days"),
    finding("health_ranges", "low", healthRangeIds(health, water),
      "owner step: review and correct the source record"),
    finding("rls_smoke", "high", await rlsDisabledIds(projectRef(),
      process.env.SUPABASE_ACCESS_TOKEN ?? ""),
      "owner step: enable RLS and restore the table policy"),
  ];
  return { findings, repair: { contradictions: contradictionRows, orphanPrefs, danglingRefs,
    foodsWithoutRef, targetMismatches: mismatches } };
}

async function repair(admin: SupabaseClient, state: RepairState): Promise<void> {
  await fixContradictions(admin, state.contradictions);
  for (const pref of state.orphanPrefs) {
    const result = await admin.from("user_food_prefs").delete()
      .eq("user_id", pref.user_id).eq("food_ref_id", pref.food_ref_id);
    if (result.error) throw new Error(`delete orphan pref: ${result.error.message}`);
  }
  for (const ref of state.danglingRefs) {
    const result = await admin.from("food_refs").delete().eq("id", ref.id);
    if (result.error) throw new Error(`delete dangling food ref ${ref.id}: ${result.error.message}`);
  }
  for (const food of state.foodsWithoutRef) {
    const id = await uuidV5(UUID_NAMESPACE, `food-ref:user:${food.id}`);
    const result = await admin.from("food_refs").insert({ id, kind: "user", user_food_id: food.id });
    if (result.error && result.error.code !== "23505") {
      throw new Error(`mint food ref ${food.id}: ${result.error.message}`);
    }
  }
  for (const mismatch of state.targetMismatches) {
    const target = mismatch.target;
    if (!mismatch.expected) continue;
    const settings = profileSettings(mismatch.settings);
    const today = target?.effective_from ?? mismatch.expected.effectiveFrom;
    const trainingWeekdays = mismatch.settings.training_weekdays ?? [];
    const latestWeighInKg = mismatch.expected.inputs.weightSource === "weigh-in"
      ? mismatch.expected.inputs.weightKg : null;
    const input = { settings, latestWeighInKg, today, trainingWeekdays,
      source: target?.target_source === "manual" ? "manual" as const : "derived" as const };
    await writeDerivedTargets(admin, mismatch.userId, input);
  }
}

function escapeCell(value: string): string { return value.replaceAll("|", "\\|"); }

export function markdown(findings: Finding[], accepted: Set<FindingName>, countsOnly = false): string {
  const header = "| name | count | severity | sample ids (≤ 5) | fix path |\n"
    + "|---|---:|---|---|---|";
  const rows = findings.map((row) => {
    const samples = countsOnly ? "withheld (production counts only)"
      : row.sampleIds.length > 0 ? row.sampleIds.join(", ") : "—";
    const fix = accepted.has(row.name) && row.count > 0
      ? `${row.fixPath}; accepted owner step` : row.fixPath;
    return `| ${row.name} | ${row.count} | ${row.severity} | ${escapeCell(samples)} | ${escapeCell(fix)} |`;
  });
  return [header, ...rows].join("\n");
}

export function reportChecksum(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function parseArgs(argv: string[]): Options {
  let environment: Options["environment"] | null = null;
  let fix = false;
  let requestedFix = false;
  let twice = false;
  const accepted = new Set<FindingName>();
  const names = new Set<FindingName>(["membership_contradictions", "prefs_orphans",
    "food_refs_dangling", "food_refs_unused", "user_foods_without_ref", "targets_consistency",
    "profile_ranges", "plan_slots_on_avoid", "health_ranges", "rls_smoke"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--production") environment = "production";
    else if (arg === "--branch") environment = "branch";
    else if (arg === "--read-only") fix = false;
    else if (arg === "--fix") { fix = true; requestedFix = true; }
    else if (arg === "--twice") twice = true;
    else if (arg === "--accept" || arg.startsWith("--accept=")) {
      const value = arg === "--accept" ? argv[++index] : arg.slice("--accept=".length);
      if (!value) throw new Error("--accept needs a comma-separated finding list");
      for (const name of value.split(",")) {
        if (!names.has(name as FindingName)) throw new Error(`unknown --accept finding: ${name}`);
        accepted.add(name as FindingName);
      }
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!environment) throw new Error("choose --production or --branch");
  if (environment === "production" && requestedFix) {
    throw new Error("--fix is forbidden on production");
  }
  if (environment === "production" && projectRef() !== PRODUCTION_REF) {
    throw new Error(`--production requires project ${PRODUCTION_REF}`);
  }
  if (environment === "branch" && projectRef() === PRODUCTION_REF) {
    throw new Error(`--branch refuses production project ${PRODUCTION_REF}`);
  }
  return { environment, fix, accepted, twice };
}

export function exitCode(findings: Finding[], accepted: Set<FindingName>): number {
  return findings.some((row) => row.severity !== "info" && row.count > 0
    && !accepted.has(row.name)) ? 1 : 0;
}

export async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const admin = adminClient();
  let state = await collect(admin);
  if (options.fix) {
    await repair(admin, state.repair);
    state = await collect(admin);
  }
  const body = markdown(state.findings, options.accepted);
  const checksum = reportChecksum(body);
  if (options.twice) {
    const repeated = await collect(admin);
    const repeatedChecksum = reportChecksum(markdown(repeated.findings, options.accepted));
    if (repeatedChecksum !== checksum) {
      throw new Error(`--twice checksum mismatch: ${checksum} != ${repeatedChecksum}`);
    }
  }
  console.log(`${body}\n\nsha256: ${checksum}`
    + (options.twice ? `\ntwice: matched ${checksum}` : ""));
  if (options.environment === "production") {
    const date = reportDate();
    const productionBody = markdown(state.findings, options.accepted, true);
    const productionChecksum = reportChecksum(productionBody);
    const report = `# Production data-integrity audit — ${date}\n\n`
      + "Production run is read-only. Personal row contents and sample identifiers are omitted here.\n\n"
      + productionBody + `\n\nsha256: ${productionChecksum}\n`
      + (options.twice ? "\nTwo consecutive read-only runs produced the same finding-table checksum.\n" : "");
    await writeFile(reportPath(date), report, "utf8");
  }
  process.exitCode = exitCode(state.findings, options.accepted);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
