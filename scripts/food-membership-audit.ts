/**
 * Audit and repair same-name Eats/Avoid contradictions (U3 / K3).
 *
 *   (no flag)              read-only report, any project
 *   --fix                  repair on a branch or local database
 *   --fix --production     repair on production: a deliberate, owner-approved step, never a default
 *   --branch-check         seed, repair and verify on a branch; refuses production
 *
 * `--fix` used to run against whatever SUPABASE_URL named, production included, with no guard
 * (unlike scripts/audit/data-integrity.ts). It now refuses production unless --production is
 * passed, and refuses outright when the project cannot be identified from SUPABASE_URL.
 */
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeFoodName } from "@/lib/foods/normalize";
import { adminClient } from "@/lib/server/admin";

const PRODUCTION_REF = "fivatgdpuenszxxnijpc";

type Contradiction = {
  user_id: string;
  name_norm: string;
  row_count: number;
  ref_ids: string[];
  kind: "conflict" | "partial";
  eats_updated_at: string | null;
  avoid_updated_at: string | null;
};

/**
 * The Supabase project ref from SUPABASE_URL's hostname, "local" for a loopback stack
 * (`supabase start`, http://127.0.0.1:54321), or null when it cannot be derived.
 */
export function projectRef(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") return "local";
    const ref = host.split(".")[0];
    return /^[a-z0-9]{15,30}$/.test(ref) ? ref : null;
  } catch {
    return null;
  }
}

/** Throws when the flags would write somewhere they should not. Pure; reads only its inputs. */
export function assertWriteTarget(argv: readonly string[], url: string | undefined): void {
  const ref = projectRef(url);
  const production = ref === PRODUCTION_REF;
  const fix = argv.includes("--fix");
  const optIn = argv.includes("--production");
  if (argv.includes("--branch-check") && (production || (url ?? "").includes(PRODUCTION_REF))) {
    throw new Error(`--branch-check refuses production project ${PRODUCTION_REF}`);
  }
  if (optIn && !fix) throw new Error("--production only applies together with --fix");
  if (optIn && !production) {
    throw new Error(`--production given, but SUPABASE_URL is not production project ${PRODUCTION_REF}`);
  }
  if (!fix) return;
  if (ref === null) {
    throw new Error("--fix refuses: cannot identify the Supabase project from SUPABASE_URL");
  }
  if (production && !optIn) {
    throw new Error(`--fix refuses production project ${PRODUCTION_REF} without --production; `
      + "run --branch-check on a branch first, then repeat with --fix --production as a deliberate step");
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function contradictions(admin: SupabaseClient): Promise<Contradiction[]> {
  const { data, error } = await admin.rpc("food_membership_contradictions", { p_user: null });
  if (error) throw new Error(`membership audit failed: ${error.message}`);
  return (data ?? []) as Contradiction[];
}

function winner(row: Contradiction): "eats" | "avoid" {
  const eats = row.eats_updated_at ? Date.parse(row.eats_updated_at) : -Infinity;
  const avoid = row.avoid_updated_at ? Date.parse(row.avoid_updated_at) : -Infinity;
  return avoid >= eats ? "avoid" : "eats";
}

export async function fixContradictions(
  admin: SupabaseClient, rows: Contradiction[], now: () => number = Date.now,
): Promise<void> {
  const base = now();
  for (const [index, row] of rows.entries()) {
    const { error } = await admin.rpc("set_food_membership", {
      p_user: row.user_id,
      p_name_norm: normalizeFoodName(row.name_norm),
      p_status: winner(row),
      p_note: null,
      p_rev: base + index,
    });
    if (error) throw new Error(`membership repair failed for ${row.user_id}/${row.name_norm}: ${error.message}`);
  }
}

function printRows(rows: Contradiction[]): void {
  if (rows.length === 0) {
    console.log("food membership contradictions: 0");
    return;
  }
  for (const row of rows) {
    console.log(JSON.stringify({
      userId: row.user_id,
      name: row.name_norm,
      count: row.row_count,
      kind: row.kind,
      refIds: row.ref_ids,
      latest: { eats: row.eats_updated_at, avoid: row.avoid_updated_at },
    }));
  }
  console.log(`food membership contradictions: ${rows.length}`);
}

async function seedContradictions(admin: SupabaseClient, userId: string): Promise<void> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const names = [
    `membership audit alpha ${suffix}`,
    `membership audit alpha ${suffix}, raw`,
    `membership audit beta ${suffix}`,
    `membership audit beta ${suffix}, cooked`,
    `membership audit gamma ${suffix}`,
    `membership audit gamma ${suffix}, raw`,
  ];
  const foods = names.map((name) => ({
    id: crypto.randomUUID(), user_id: userId, name, kind: "custom", per_100g: {}, allergen_tags: [],
  }));
  const insertedFoods = await admin.from("user_foods").insert(foods).select("id");
  if (insertedFoods.error) throw new Error(insertedFoods.error.message);
  const refs = foods.map((food) => ({ id: crypto.randomUUID(), kind: "user", user_food_id: food.id }));
  const insertedRefs = await admin.from("food_refs").insert(refs).select("id");
  if (insertedRefs.error) throw new Error(insertedRefs.error.message);
  const old = "2026-01-01T00:00:00.000Z";
  const recent = "2026-01-02T00:00:00.000Z";
  const prefs = [
    { user_id: userId, food_ref_id: refs[0].id, status: "eats", updated_at: old },
    { user_id: userId, food_ref_id: refs[1].id, status: "avoid", updated_at: recent },
    { user_id: userId, food_ref_id: refs[2].id, status: "eats", updated_at: recent },
    { user_id: userId, food_ref_id: refs[3].id, status: "avoid", updated_at: old },
    { user_id: userId, food_ref_id: refs[4].id, status: "eats", updated_at: recent },
  ];
  const insertedPrefs = await admin.from("user_food_prefs").insert(prefs);
  if (insertedPrefs.error) throw new Error(insertedPrefs.error.message);
}

async function branchCheck(admin: SupabaseClient): Promise<void> {
  const url = process.env.SUPABASE_URL ?? "";
  if (url.includes(PRODUCTION_REF)) {
    throw new Error(`--branch-check refuses production project ${PRODUCTION_REF}`);
  }
  if (!url) throw new Error("--branch-check needs SUPABASE_URL pointed at the current branch");
  const created = await admin.auth.admin.createUser({
    email: `food-membership-${crypto.randomUUID()}@example.invalid`,
    password: crypto.randomUUID(),
    email_confirm: true,
  });
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? "test user missing");
  const userId = created.data.user.id;
  try {
    await seedContradictions(admin, userId);
    const seeded = (await contradictions(admin)).filter((row) => row.user_id === userId);
    if (seeded.length !== 3) throw new Error(`expected 3 seeded contradictions, found ${seeded.length}`);
    await fixContradictions(admin, seeded);
    const remaining = (await contradictions(admin)).filter((row) => row.user_id === userId);
    if (remaining.length !== 0) throw new Error(`expected 0 contradictions after --fix, found ${remaining.length}`);
    console.log("food membership --branch-check: 3 seeded, 3 fixed, 0 remain");
  } finally {
    const removed = await admin.auth.admin.deleteUser(userId);
    if (removed.error) console.warn(`food membership branch-check cleanup failed: ${removed.error.message}`);
  }
}

export async function main(argv: string[]): Promise<void> {
  const allowed = new Set(["--fix", "--branch-check", "--production"]);
  const unknown = argv.filter((arg) => !allowed.has(arg));
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown.join(", ")}`);
  // Before any client exists: a refused run opens no connection at all.
  assertWriteTarget(argv, process.env.SUPABASE_URL);
  const admin = adminClient();
  if (argv.includes("--branch-check")) return branchCheck(admin);
  const rows = await contradictions(admin);
  printRows(rows);
  if (!argv.includes("--fix") || rows.length === 0) return;
  await fixContradictions(admin, rows);
  const remaining = await contradictions(admin);
  printRows(remaining);
  if (remaining.length > 0) throw new Error(`${remaining.length} food membership contradictions remain`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(message(error));
    process.exitCode = 1;
  });
}
