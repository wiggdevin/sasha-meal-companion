/**
 * T6's own proof: Devin's three sentences, run against the LOCAL stack with the real model.
 *
 * It seeds a day (four slots with times and items, two logged entries, targets, an Eats list, the
 * gluten/dairy/apple profile), then runs three turns through `runTurn` — the same orchestrator the
 * route calls, with the real Gemini adapter and the real catalog. It prints the action kinds, the
 * grounded items, the flags and the totals it got.
 *
 * Local only. It refuses to run against the production project ref.
 *
 *   pnpm tsx scripts/t6-coach-proof.ts
 */
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/server/admin";
import { runTurn } from "@/lib/server/coach-turn";
import { buildCoachContext, renderCoachContext } from "@/lib/server/coach-context";
import { localDateIn } from "@/lib/server/jobs";
import { generateStructured } from "@/lib/ai/adapter";
import type { CoachAction } from "@/lib/coach/actions";

const PRODUCTION_REF = "fivatgdpuenszxxnijpc";
const TZ = "America/Denver";
const EMAIL = "t6-proof@localhost.test";
const PASSWORD = "t6-proof-local-only";

function admin(): SupabaseClient {
  // The key itself is read in lib/server/admin.ts, the one file allowed to name it.
  const url = process.env.SUPABASE_URL ?? "";
  if (url.includes(PRODUCTION_REF)) throw new Error("refusing to run against production");
  return adminClient();
}

type Db = SupabaseClient;

async function testUser(db: Db): Promise<string> {
  const { data: list } = await db.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === EMAIL);
  if (found) {
    await db.auth.admin.updateUserById(found.id, { password: PASSWORD });
    return found.id;
  }
  const { data, error } = await db.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create the test user: ${error?.message}`);
  return data.user.id;
}

/**
 * The RLS-scoped client the route hands runTurn. It matters: `loadUserProfile` scopes her
 * constraint profile by RLS alone, so a service-role client there reads every user's row and the
 * search tool fails with "Your food rules could not be read".
 */
async function userClient(): Promise<Db> {
  const url = process.env.SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!key) throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set");
  const anon = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword(
    { email: EMAIL, password: PASSWORD });
  if (error || !data.session) throw new Error(`could not sign the test user in: ${error?.message}`);
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
  });
}

async function refFor(
  db: Db, userId: string, query: string,
): Promise<{ refId: string; name: string } | null> {
  const { data, error } = await db.rpc("catalog_search", { p_q: query, p_limit: 1 });
  if (error) throw new Error(`catalog_search ${query}: ${error.message}`);
  const hit = (data as { catalog_food_id: number; description: string }[] | null)?.[0];
  if (!hit) { console.warn(`  (no catalog hit for "${query}")`); return null; }
  const { data: refId, error: refError } = await db.rpc("get_or_create_food_ref", {
    p_user_id: userId, p_kind: "catalog",
    p_catalog_food_id: hit.catalog_food_id, p_user_food_id: null,
  });
  if (refError) throw new Error(`get_or_create_food_ref: ${refError.message}`);
  return typeof refId === "string" ? { refId, name: hit.description } : null;
}

function must(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function seed(db: Db, userId: string, date: string): Promise<void> {
  must("constraint_profiles", (await db.from("constraint_profiles").upsert({
    user_id: userId, conditions: ["ulcerative colitis"], notes: "flares on raw onion",
    avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [],
    banned_categories: ["simple_sugars"], rev: 1,
  })).error);
  must("user_settings", (await db.from("user_settings").upsert({
    user_id: userId, first_opened_at: "2026-08-01T00:00:00.000Z", slot_times: {},
    shift_minutes: 0, protein_locked: true, rev: 1,
  })).error);
  must("plan_days", (await db.from("plan_days").upsert({
    user_id: userId, local_date: date, floor_day: false, swaps: {}, slot_notes: {},
    item_overrides: {}, rev: 1,
  })).error);

  // Two logged entries, and an Eats list the compose step can build from.
  const eats = ["chicken breast", "banana", "rice", "avocado", "corn tortilla", "beef jerky"];
  for (const name of eats) {
    const hit = await refFor(db, userId, name);
    if (hit) {
      must("user_food_prefs", (await db.from("user_food_prefs").upsert({
        user_id: userId, food_ref_id: hit.refId, status: "eats", rev: 1,
      })).error);
    }
  }

  await db.from("log_entries").delete().eq("user_id", userId).eq("local_date", date);
  const eggs = await refFor(db, userId, "egg whole raw");
  const rice = await refFor(db, userId, "rice white cooked");
  const rows = [
    { at: `${date}T13:00:00.000Z`, slot: "meal-1", ref: eggs, grams: 150 },
    { at: `${date}T18:00:00.000Z`, slot: "meal-2", ref: rice, grams: 200 },
  ];
  for (const row of rows) {
    if (!row.ref) continue;
    const entryId = randomUUID();
    must("log_entries", (await db.from("log_entries").insert({
      id: entryId, user_id: userId, eaten_at: row.at, tz: TZ, local_date: date,
      slot: row.slot, method: "text", rev: 1,
    })).error);
    must("log_items", (await db.from("log_items").insert({
      id: randomUUID(), entry_id: entryId, seq: 1, food_ref_id: row.ref.refId,
      grams: row.grams, qty: row.grams, unit: "g",
      snapshot: { energy_kcal: { amount: (row.grams * 1.5) }, protein: { amount: row.grams * 0.1 },
        carbohydrate: { amount: row.grams * 0.2 }, fat: { amount: row.grams * 0.05 } },
    })).error);
  }
}

/** With T6_DEBUG=1, print what the model actually replied before the union judges it. */
const debugGenerate: typeof generateStructured = async (args, deps) =>
  generateStructured(args, { ...deps, onProviderText: (model, text) => {
    console.log(`  [raw ${model}] ${text.replace(/\s+/g, " ").slice(0, 900)}`);
  } });

function describeAction(action: CoachAction): string {
  const items = "items" in action ? action.items
    : "item" in action ? [action.item] : [];
  const named = items.length > 0
    ? items.map((i) => `${i.name} ${i.grams} g (ref ${i.foodRefId.slice(0, 8)}, ${i.verdict})`)
      .join("; ")
    : "name" in action ? `${action.name}` : "";
  const flags = action.flagged.length ? ` FLAGGED: ${action.flagged.join(", ")}` : "";
  return `  ${action.kind}${"slot" in action ? ` [${action.slot}]` : ""} -> ${named}${flags}`;
}

async function main(): Promise<void> {
  const db = admin();
  const userId = await testUser(db);
  const client = await userClient();
  const now = new Date();
  const date = localDateIn(TZ, now);
  await seed(db, userId, date);

  const context = await buildCoachContext(db, client, userId,
    { now: now.toISOString(), tz: TZ, date });
  const block = renderCoachContext(context);
  console.log(`user ${userId} · date ${date} · tz ${TZ}`);
  console.log(`context block: ${block.length} chars, ~${Math.ceil(block.length / 4)} tokens`);
  console.log(`  slots: ${context.day.slots.map((s) => `${s.time} ${s.slot}`).join(", ")}`);
  console.log(`  entries: ${context.day.entries.map((e) => `${e.at} ${e.name}`).join(", ") || "none"}`);
  console.log(`  targets ${JSON.stringify(context.day.targets)}`);
  console.log(`  still to eat ${JSON.stringify(context.day.remaining)}`);
  console.log(`  eats: ${context.lists.eats.join(", ") || "none"}`);
  console.log("");

  const sentences = (process.env.T6_SENTENCES ?? [
    "Add watermelon to my avoid list",
    "Change my 4th meal to beef jerky and a Chobani yogurt",
    "Give me a recipe for a chicken wrap that fits my daily macros",
  ].join("|")).split("|");

  const runs = Number(process.env.T6_RUNS ?? 1);
  const hits: Record<string, { ok: number; n: number; ms: number[]; models: string[] }> = {};
  let threadId: string | null = null;
  for (let run = 0; run < runs; run += 1) {
  if (runs > 1) {
    threadId = null;
    // The circuit breaker counts failures per PROVIDER over ten minutes, and repeated runs of the
    // same three sentences trip it — which measures the breaker, not the turn. Local test rows
    // only, and only this user's.
    await db.from("coach_messages").delete().eq("user_id", userId);
    await db.from("coach_threads").delete().eq("user_id", userId);
    await db.from("ai_calls").delete().eq("user_id", userId);
    console.log(`--- run ${run + 1} of ${runs}`);
  }
  for (const text of sentences) {
    hits[text] ??= { ok: 0, n: 0, ms: [], models: [] };
    const started = Date.now();
    console.log(`SASHA: ${text}`);
    try {
      const res = await runTurn(client, db, userId,
        { threadId, messageId: randomUUID(), text, now: new Date().toISOString(), tz: TZ },
        process.env.T6_DEBUG ? { generate: debugGenerate } : {});
      threadId = res.threadId;
      console.log(`COACH (${res.model.modelId}, ${Date.now() - started} ms): ` +
        `${res.messages.at(-1)?.content ?? ""}`);
      console.log(`  tools: ${res.toolsUsed.join(", ") || "none"}`);
      console.log(`  actions: ${res.actions.length}`);
      for (const action of res.actions) console.log(describeAction(action));
      for (const composed of res.composed ?? []) {
        console.log(`  composed: ${composed.items.map((item) =>
          `${item.name} ${item.grams} g`).join("; ")}`);
        console.log(`    totals ${JSON.stringify(composed.totals)} ` +
          `target ${JSON.stringify(composed.target)} fits=${composed.fitsTarget} ` +
          `flagged=${composed.flagged.join(", ") || "none"}`);
      }
      const { data: thread } = await db.from("coach_threads")
        .select("summary").eq("id", res.threadId).maybeSingle();
      const summary = (thread as { summary?: string | null } | null)?.summary ?? null;
      console.log(`  memory (${summary?.length ?? 0} chars): ${summary ?? "(none)"}`);
      hits[text].n += 1;
      hits[text].ms.push(Date.now() - started);
      hits[text].models.push(res.model.modelId
        + (res.model.fellBackBecause ? ` (${res.model.fellBackBecause})` : ""));
      if (res.actions.length > 0 || (res.composed?.length ?? 0) > 0) hits[text].ok += 1;
    } catch (e) {
      hits[text].n += 1;
      hits[text].ms.push(Date.now() - started);
      console.log(`  FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log("");
  }
  }
  if (runs > 1) {
    console.log("=== hit rate (a card, not prose) ===");
    for (const [text, h] of Object.entries(hits)) {
      const p50 = [...h.ms].sort((a, b) => a - b)[Math.floor(h.ms.length / 2)] ?? 0;
      console.log(`${h.ok}/${h.n}  p50 ${p50} ms  models ${h.models.join(", ")}  |  ${text}`);
    }
  }
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
