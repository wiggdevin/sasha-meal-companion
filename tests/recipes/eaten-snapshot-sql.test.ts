import { describe, expect, it } from "vitest";
import { HAS_BRANCH, HAS_DB, adminClient, runSql, userClient }
  from "@/tests/helpers/supabase";

const LOCAL_DB = HAS_DB && (() => {
  try { return ["127.0.0.1", "localhost"].includes(
    new URL(process.env.SUPABASE_TEST_DB_URL ?? "").hostname); }
  catch { return false; }
})();
const LOCAL_HTTP = HAS_BRANCH && (() => {
  try { return ["127.0.0.1", "localhost"].includes(
    new URL(process.env.SUPABASE_TEST_URL ?? "").hostname); }
  catch { return false; }
})();
const consumed = { baseMealId: "recipe:revision-1", title: "Stew", components: [{
  name: "Stew", qty: 0.25, unit: "whole", role: "free",
  macros: { kcal: 83.2, protein: 5.5, carbs: 9, fat: 2 },
}] };
function valid(value: unknown): boolean {
  const literal = JSON.stringify(value).replaceAll("'", "''");
  return runSql(`select public.plan_day_eaten_slots_valid('${literal}'::jsonb)`) === "t";
}

describe.skipIf(!LOCAL_DB)("applied eaten snapshot SQL validator on a local test database", () => {
  it("accepts legacy marks and a complete recipe snapshot", () => {
    expect(valid({ "meal-3": { eaten_at: null, changed_at: "2026-09-15T13:00:00Z" } })).toBe(true);
    expect(valid({ "meal-3": { eaten_at: "2026-09-15T12:00:00Z",
      changed_at: "2026-09-15T12:00:00Z", consumed } })).toBe(true);
    expect(valid({ "meal-3": { eaten_at: null, changed_at: "2026-09-15T13:00:00Z",
      history_epoch: "11111111-1111-4111-8111-111111111111" } })).toBe(true);
  });
  it("rejects incomplete nutrients, extra fields, bounds, and a consumed tombstone", () => {
    const mark = { eaten_at: "2026-09-15T12:00:00Z", changed_at: "2026-09-15T12:00:00Z" };
    expect(valid({ "meal-3": { ...mark, consumed: { ...consumed,
      components: [{ ...consumed.components[0], macros: { kcal: 83.2 } }] } } })).toBe(false);
    expect(valid({ "meal-3": { ...mark, consumed: { ...consumed,
      components: [{ ...consumed.components[0], macros: {
        kcal: 83.2, protein: 5.5, carbs: 9, sodium: 2,
      } }] } } })).toBe(false);
    expect(valid({ "meal-3": { ...mark, consumed: { ...consumed, added: "forged" } } })).toBe(false);
    expect(valid({ "meal-3": { ...mark, consumed: { ...consumed,
      components: [{ ...consumed.components[0], qty: 21 }] } } })).toBe(false);
    for (const field of ["unit", "role"] as const) {
      expect(valid({ "meal-3": { ...mark, consumed: { ...consumed,
        components: [{ ...consumed.components[0], [field]: null }] } } })).toBe(false);
    }
    expect(valid({ "meal-3": { ...mark, eaten_at: null, consumed } })).toBe(false);
    expect(valid({ "meal-3": { ...mark, history_epoch: "not-a-uuid" } })).toBe(false);
    expect(valid(null)).toBe(false);
    expect(runSql("select public.recipe_consumed_snapshot_valid(null::jsonb)")).toBe("f");
  });

  it.skipIf(!LOCAL_HTTP)("keeps legacy ticks writable but requires the online RPC for consumed history", async () => {
    expect(runSql("select has_function_privilege('anon', 'public.recipe_consumed_snapshot_valid(jsonb)', 'execute') || ',' || has_function_privilege('authenticated', 'public.recipe_consumed_snapshot_valid(jsonb)', 'execute') || ',' || has_function_privilege('service_role', 'public.recipe_consumed_snapshot_valid(jsonb)', 'execute')"))
      .toBe("false,true,true");
    const admin = adminClient();
    const account = { email: `consumed-${crypto.randomUUID()}@meal-companion.test`,
      password: `Local-${crypto.randomUUID()}-1` };
    const created = await admin.auth.admin.createUser({ ...account, email_confirm: true });
    expect(created.error).toBeNull();
    const user = { ...account, id: created.data.user!.id };
    try {
      const client = await userClient(user);
      const mark = { "meal-3": { eaten_at: "2026-09-15T12:00:00Z",
        changed_at: "2026-09-15T12:00:00Z", consumed } };
      const direct = await client.from("plan_days").insert({ user_id: user.id,
        local_date: "2099-04-21", eaten_slots: mark });
      expect(direct.error?.code).toBe("22023");
      const synced = await client.rpc("apply_sync_op", { p_user_id: user.id,
        p_op: { op_id: crypto.randomUUID(), entity: "plan_days", entity_id: "2099-04-22",
          kind: "create", base_rev: null, payload: { eaten_slots: mark },
          client_ts: new Date().toISOString() } });
      expect(synced.error?.code).toBe("22023");
      const legacy = await client.from("plan_days").insert({ user_id: user.id,
        local_date: "2099-04-23", eaten_slots: { "meal-3": {
          eaten_at: "2026-09-15T12:00:00Z", changed_at: "2026-09-15T12:00:00Z",
        } } });
      expect(legacy.error).toBeNull();
    } finally {
      expect((await admin.auth.admin.deleteUser(user.id)).error).toBeNull();
    }
  });
});
