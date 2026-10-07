/**
 * Seeds for the cron-job tenancy cases (tests/tenancy/admin-jobs.test.ts): enough per-user history
 * that the jobs reach their consequential writes (review r2 finding 4), with a distinct value per
 * user so a row written for one user can be traced to whose data it came from.
 */
import { adminClient } from "../helpers/supabase";
import { sealOauth } from "@/lib/server/crypto";

const DAY_MS = 86_400_000;
// exp-3.1.0 suggests no change before ~6 weeks of weigh-ins (`cycleCheckable`, 38 days).
const HISTORY_DAYS = 45;

async function insert(table: string, rows: Record<string, unknown> | Record<string, unknown>[]) {
  const { data, error } = await adminClient().from(table).insert(rows).select("*");
  if (error) throw new Error(`seed ${table}: ${error.message}`);
  return data as Record<string, unknown>[];
}

/**
 * One Eats-marked custom food for the facet-warm job canary: a plain `user_foods` row, so its
 * allergen-evidence row (lib/server/allergen-evidence.ts) carries this real user's id — never the
 * `null` a shared catalog food's evidence row would, which the write-scoping check below cannot
 * trace to either fixture user.
 */
export async function seedEatsUserFood(
  userId: string, name: string,
): Promise<{ foodId: string; refId: string }> {
  const [food] = await insert("user_foods", { user_id: userId, name, kind: "custom" });
  const [ref] = await insert("food_refs", { kind: "user", user_food_id: food.id });
  await insert("user_food_prefs", { user_id: userId, food_ref_id: ref.id, status: "eats" });
  return { foodId: String(food.id), refId: String(ref.id) };
}

const dayBefore = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

/**
 * A complete profile, an active target profile, 45 days of logged intake at `kcal` and 45 daily
 * weigh-ins at `kg`: the estimator reaches `estimating` and the weekly job writes a proposal.
 */
export async function seedEstimatorHistory(userId: string, kcal: number, kg: number) {
  await insert("user_settings", { user_id: userId, first_opened_at: "2026-01-01T00:00:00Z",
    time_zone: "UTC", sex: "female", birth_year: 1990, height_cm: 165, weight_kg: kg,
    activity_level: "moderate", goal: "maintain" });
  // Targets 500 kcal under the intake, so the learned estimate is clearly above them and the
  // weekly proposal clears its 75 kcal/day minimum move (ruling R4) for both users.
  const target = kcal - 500;
  await insert("target_profiles", { user_id: userId, effective_from: dayBefore(60),
    kcal_train: target, kcal_rest: target, authored_by: "user", mode: "grams",
    protein_g: 120, fat_g: 70, carb_g: Math.round((target - 120 * 4 - 70 * 9) / 4),
    // The weekly proposal weights its average by the revision's own schedule; a row without one
    // gets no proposal (lib/proposal.ts `trainingDaysPerWeek`).
    protein_g_min: 120, input_training_weekdays: [1, 3, 5] });
  const [food] = await insert("user_foods", { user_id: userId, name: "tenancy job food",
    kind: "custom" });
  const [ref] = await insert("food_refs", { kind: "user", user_food_id: food.id });
  const source = (await insert("health_sources", { user_id: userId, kind: "health_auto_export",
    device_label: "tenancy job" }))[0].id;
  const days = Array.from({ length: HISTORY_DAYS }, (_, i) => dayBefore(i + 1));
  await seedIntake(userId, String(ref.id), kcal, days);
  await insert("health_samples", days.map((d, i) => ({ user_id: userId, source_id: source,
    type: "body_mass", value: kg, unit: "kg", start_time: `${d}T08:00:00Z`,
    end_time: `${d}T08:00:00Z`, tz: "UTC", vendor_sample_id: `tenancy-job-${i}` })));
}

/** One logged entry of `kcal` on each of `days`, against the user's food ref `refId`. */
export async function seedIntake(userId: string, refId: string, kcal: number, days: string[]) {
  if (days.length === 0) return;
  const entries = await insert("log_entries", days.map((d) => ({ id: crypto.randomUUID(),
    user_id: userId, eaten_at: `${d}T12:00:00Z`, tz: "UTC", local_date: d, slot: "meal-1",
    method: "search" })));
  await insert("log_items", entries.map((e) => ({ id: crypto.randomUUID(), entry_id: e.id,
    seq: 1, qty: 1, unit: "g", grams: 100, food_ref_id: refId,
    snapshot: { energy_kcal: { amount: kcal, unit: "kcal", basis: "per_100g", source: "user" } },
  })));
}

/**
 * The days of the reviewed week (the route's own `weekStartOf`, a Monday) that the 28-day history
 * does not cover: today and every later day of that week. Seeding them makes each day of the
 * reviewed week carry the user's intake on whatever weekday CI runs (review r5 finding 1).
 */
export function uncoveredReviewDays(weekStart: string): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const start = Date.parse(`${weekStart}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, i) => new Date(start + i * DAY_MS).toISOString()
    .slice(0, 10)).filter((d) => d >= today);
}

/** An Oura source whose sealed token is valid until 2099; `accessToken` identifies the user. */
export async function seedOuraSource(userId: string, accessToken: string): Promise<string> {
  const oauth = sealOauth({ access_token: accessToken, refresh_token: `r-${accessToken}`,
    expires_at: "2099-01-01T00:00:00Z", scope: "daily personal" });
  return String((await insert("health_sources", { user_id: userId, kind: "oura",
    device_label: "Oura", oauth }))[0].id);
}

/**
 * A fetch that answers the Oura API per access token (steps = the value mapped to that token) and
 * passes every other request, including Supabase's, to the real fetch.
 */
export function ouraFetch(stepsByToken: Record<string, number>, real: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://api.ouraring.com/")) return real(input, init);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const steps = stepsByToken[auth.replace(/^Bearer /, "")];
    if (steps === undefined) return new Response("{}", { status: 401 });
    const day = dayBefore(1);
    const body = url.includes("daily_activity")
      ? { data: [{ id: `a-${steps}`, day, steps, active_calories: 300 }] }
      : { data: [] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}
