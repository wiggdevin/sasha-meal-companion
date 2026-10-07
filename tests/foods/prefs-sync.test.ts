/**
 * T1 §1 and §4 against a real branch: the op `lib/foods/prefs-client.ts` emits actually lands, and
 * a fresh constraint profile restricts nothing (PRD R2, D1 §6.1).
 *
 * `lib/foods/prefs-client.ts` runs in the browser and cannot reach a database from vitest's node
 * environment, so what is proved here is the other half of the contract: the payload shape the
 * client builds, replayed through `apply_sync_op` exactly as the outbox would push it.
 *
 * Skips with a printed reason when SUPABASE_TEST_* is unset — see `.env.example` and
 * `scripts/db-branch.sh env`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, resetUser, runSql, userClient,
} from "../helpers/supabase";
import { seedUserFood } from "../log/fixtures";

if (!HAS_BRANCH) {
  console.log(
    "tests/foods/prefs-sync.test.ts: skipped — SUPABASE_TEST_URL / _ANON_KEY / "
    + "_SERVICE_ROLE_KEY are not set (run `bash scripts/db-branch.sh env`).",
  );
}

type Result = Record<string, unknown> & { status: string };

async function op(
  client: SupabaseClient, userId: string, entityId: string,
  kind: "create" | "update", baseRev: number | null, payload: Record<string, unknown>,
): Promise<Result> {
  const { data, error } = await client.rpc("apply_sync_op", {
    p_user_id: userId,
    p_op: {
      op_id: crypto.randomUUID(), entity: "user_food_prefs", entity_id: entityId, kind,
      base_rev: baseRev, payload, client_ts: new Date().toISOString(),
    },
  });
  if (error) throw error;
  return data as Result;
}

/** The exact payload `writePrefOp` builds in lib/foods/prefs-client.ts. */
function payload(foodRefId: string, status: "eats" | "avoid", note: string | null) {
  return { food_ref_id: foodRefId, status, role: "carb", no_cook: false, note };
}

describe.skipIf(!HAS_BRANCH)("user_food_prefs from the phone", () => {
  it("lands an avoid mark with its note, then flips back to eats keeping the note", async () => {
    const user = await ensureUser("a");
    await resetUser(user.id);
    const client = await userClient(user);
    const admin = adminClient();
    const food = await seedUserFood(admin, user.id, {
      name: "Onion", per100g: { energy_kcal: 40 },
    });

    const created = await op(client, user.id, food.foodRefId, "create", null,
      payload(food.foodRefId, "avoid", "hurt on 9/12"));
    expect(created.status).toBe("applied");

    const stored = await client.from("user_food_prefs")
      .select("status, note, role, no_cook, rev").eq("food_ref_id", food.foodRefId).single();
    expect(stored.error).toBeNull();
    expect(stored.data).toMatchObject({ status: "avoid", note: "hurt on 9/12", role: "carb" });

    const updated = await op(client, user.id, food.foodRefId, "update",
      stored.data?.rev as number, payload(food.foodRefId, "eats", "hurt on 9/12"));
    expect(updated.status).toBe("applied");

    const back = await client.from("user_food_prefs")
      .select("status, note").eq("food_ref_id", food.foodRefId).single();
    expect(back.data).toMatchObject({ status: "eats", note: "hurt on 9/12" });
  });

  it("gives a fresh profile no banned categories and no allergens (20261026090100)", async () => {
    const user = await ensureUser("a");
    await resetUser(user.id);
    const admin = adminClient();
    const inserted = await admin.from("constraint_profiles")
      .insert({ user_id: user.id }).select("avoid_allergens, banned_categories").single();
    expect(inserted.error).toBeNull();
    // Rewritten, not dropped: 20261026090100 replaced the old column default — one person's five
    // banned categories and three allergens — with empty arrays, so a new row restricts nothing
    // until the account names it. A test that needs rules must seed them on `constraint_profiles`
    // (tests/helpers/constraint-profile.ts) the way this file's neighbours now do.
    expect(inserted.data?.banned_categories ?? []).toEqual([]);
    expect(inserted.data?.avoid_allergens ?? []).toEqual([]);
  });

  // The three-state rule lives or dies on the column shape: NULL must be reachable, and there must
  // be no default to fill it in. A round trip through a clone of the real table says both at once —
  // a NOT NULL column raises, a defaulted one comes back '{}'.
  it.skipIf(!HAS_DB)("leaves policy_categories NULL when nothing writes it (20261018090000)", () => {
    const written = runSql(`
      create temp table policy_categories_probe
        (like catalog_food_revisions including defaults including constraints);
      insert into policy_categories_probe
        (description, catalog_food_id, catalog_version_id, quality_class, content_hash)
      values ('probe', 1, 1, 'analytical', 'probe');
      select coalesce(policy_categories::text, 'SQL NULL') from policy_categories_probe;`);
    expect(written.trim().split("\n").at(-1)).toBe("SQL NULL");
  });

  it.skipIf(!HAS_DB)("declares the column nullable with no default", () => {
    const shape = runSql(`
      select is_nullable || ' ' || coalesce(column_default, 'no-default')
        from information_schema.columns
       where table_name = 'catalog_food_revisions' and column_name = 'policy_categories';`);
    expect(shape.trim()).toBe("YES no-default");
  });

  it.skipIf(!HAS_BRANCH)("stores NULL for a provider draft that carries no policyCategories", async () => {
    // The deploy window, end to end: the OLD writer's draft shape against the NEW function.
    const user = await ensureUser("a");
    const admin = adminClient();
    const gtin = "00000000000017";
    const { error } = await admin.rpc("catalog_write_provider_revision", {
      p_user_id: user.id, p_source: "off", p_gtin14: gtin,
      p_draft: { description: "Window scan", per100g: { energy_kcal: 100 } },
    });
    expect(error).toBeNull();

    const row = await admin.from("catalog_barcodes").select("catalog_food_id")
      .eq("gtin14", gtin).limit(1).single();
    expect(row.error).toBeNull();
    const revision = await admin.from("catalog_food_revisions").select("policy_categories")
      .eq("catalog_food_id", row.data?.catalog_food_id).eq("is_active", true).single();
    expect(revision.error).toBeNull();
    expect(revision.data?.policy_categories).toBeNull();
  });

  // Asked of the function's own signature, not of a query result: a branch whose catalog happens
  // to be empty would let a row-shape assertion pass while returning nothing at all.
  it.skipIf(!HAS_DB)("catalog_search returns policy_categories (20261018090200)", () => {
    const result = runSql("select pg_get_function_result('public.catalog_search'::regproc)");
    expect(result).toContain("policy_categories text[]");
  });
});
