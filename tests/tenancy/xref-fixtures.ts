/**
 * Shared fixtures for the same-owner reference suites (migration 20261103090100): one row of every
 * table another account-owned row can reference, all owned by one user.
 */
import { adminClient, type TestUser } from "../helpers/supabase";
import { seedUserFood } from "../log/fixtures";

export type Owned = {
  userFood: string; foodRef: string; entry: string; recipe: string; revision: string;
  group: string; meal: string; thread: string; aiCall: string; source: string; event: string;
  estimate: string;
};

export const admin = () => adminClient();

export async function must<T>(p: PromiseLike<{ data: T; error: unknown }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data;
}

/** `must` for a `.single()` read or insert: the row has to be there. */
export async function one<T>(p: PromiseLike<{ data: T; error: unknown }>,
  what: string): Promise<NonNullable<T>> {
  const data = await must(p, what);
  if (data === null || data === undefined) throw new Error(`${what}: no row`);
  return data;
}

export const hex = () => `\\x${Buffer.from(crypto.randomUUID()).toString("hex")}`;

/** A health source owned by `userId`, plus one ingest event recorded against it. */
export async function seedSource(userId: string): Promise<{ source: string; event: string }> {
  const a = admin();
  const source = await one(a.from("health_sources").insert({ user_id: userId, kind: "health_auto_export" })
    .select("id").single(), "source");
  const event = await one(a.from("ingest_events").insert({ user_id: userId, status: "applied",
    source_id: source.id, payload_hash: hex() }).select("id").single(), "event");
  return { source: source.id, event: event.id };
}

let day = 0;
/** A fresh date per call, for tables keyed on (user_id, local_date). */
export function nextDate(): string {
  day += 1;
  return new Date(Date.UTC(2025, 0, day)).toISOString().slice(0, 10);
}

export async function seedOwned(u: TestUser, tag: string): Promise<Owned> {
  const a = admin();
  const food = await seedUserFood(a, u.id, { name: `xref ${tag}`, per100g: { energy_kcal: 100 } });
  const userFood = await one(a.from("food_refs").select("user_food_id").eq("id", food.foodRefId)
    .single(), "user food");
  const entry = crypto.randomUUID();
  await must(a.from("log_entries").insert({ id: entry, user_id: u.id,
    eaten_at: new Date().toISOString(), tz: "UTC", local_date: "2026-11-03", slot: "meal1",
    method: "search" }), "entry");
  const recipe = await one(a.from("recipes").insert({ user_id: u.id, name: `r ${tag}`, servings: 1 })
    .select("id").single(), "recipe");
  const revision = await one(a.from("recipe_revisions").insert({ recipe_id: recipe.id, rev: 1 })
    .select("id").single(), "revision");
  const group = await one(a.from("duplicate_groups").insert({ user_id: u.id, fingerprint: hex(),
    local_date: "2026-11-03", slot: "meal1" }).select("id").single(), "group");
  const meal = await one(a.from("favorites_meals").insert({ user_id: u.id, name: `m ${tag}` })
    .select("id").single(), "meal");
  const thread = await one(a.from("coach_threads").insert({ user_id: u.id }).select("id").single(),
    "thread");
  const aiCall = await one(a.from("ai_calls").insert({ user_id: u.id, purpose: "coach",
    provider: "test", model_id: "test", sdk_version: "test" }).select("id").single(), "ai call");
  const { source, event } = await seedSource(u.id);
  const estimate = await one(a.from("expenditure_estimates").insert({ user_id: u.id,
    local_date: nextDate(),
    engine_version: "test", status: "held" }).select("id").single(), "estimate");
  return { userFood: userFood.user_food_id as string, foodRef: food.foodRefId, entry,
    recipe: recipe.id, revision: revision.id, group: group.id, meal: meal.id, thread: thread.id,
    aiCall: aiCall.id, source, event, estimate: estimate.id };
}
