/**
 * W13 (D14), Sol round 4 BLOCK, on the real migrated schema (SUPABASE_TEST_DB_URL; migration
 * 20261227090100_food_world_set_at). The starter-seed decision is the server's
 * (lib/server/food-world.ts `readFoodWorldState`), so the two markers it reads must be stamped
 * and guarded by the database itself:
 *
 * - `food_world_default_due_at` is stamped in the SAME write that first sets `onboarded_at`, on
 *   every writer (the phone's sync op, a direct write), and a later re-onboarding keeps the first
 *   stamp. A legacy row whose `onboarded_at` was set before the migration has none.
 * - Neither marker can be written by the signed-in user; the server (service_role) can.
 */
import "../tenancy/local-only";
import { afterAll, describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";
import { account, asUser, dropAccounts } from "../helpers/world-db";

const markers = (user: string) => runSql(`select coalesce(onboarded_at::text, '-') || '|'
  || coalesce(food_world_default_due_at::text, '-') || '|' || coalesce(food_world_set_at::text, '-')
  from public.user_settings where user_id = '${user}'`).split("|");

describe.skipIf(!HAS_DB)("food world markers on the migrated schema (W13)", () => {
  afterAll(dropAccounts);

  it("the phone's onboarding sync op stamps the default as due in the same write", () => {
    const a = account();
    expect(markers(a)).toEqual(["-", "-", "-"]);
    const rev = runSql(`select rev from public.user_settings where user_id = '${a}'`);
    asUser(a, `select public.apply_sync_op('${a}', jsonb_build_object('op_id', gen_random_uuid(),
      'entity', 'user_settings', 'entity_id', 'settings', 'kind', 'update', 'base_rev', ${rev},
      'payload', jsonb_build_object('onboarded_at', now()), 'client_ts', now()))`);
    const [onboarded, due, set] = markers(a);
    expect(onboarded).not.toBe("-");
    expect(due).not.toBe("-");
    expect(set).toBe("-");
  });

  it("a re-onboarding keeps the first stamp, and a never-onboarded row has none", () => {
    const a = account();
    asUser(a, `update public.user_settings set onboarded_at = now() where user_id = '${a}'`);
    const first = markers(a)[1];
    runSql(`update public.user_settings set onboarded_at = null where user_id = '${a}'`);
    runSql(`update public.user_settings set onboarded_at = now() + interval '1 day' where user_id = '${a}'`);
    expect(markers(a)[1]).toBe(first);
    const b = account();
    runSql(`update public.user_settings set meals_per_day = 4 where user_id = '${b}'`);
    expect(markers(b)[1]).toBe("-");
  });

  it("the signed-in user can write neither marker; the server can", () => {
    const a = account();
    expect(() => asUser(a, `update public.user_settings set food_world_set_at = now() where user_id = '${a}'`))
      .toThrow(/food world markers are server-written/);
    expect(() => asUser(a, `update public.user_settings set food_world_default_due_at = now()
      where user_id = '${a}'`)).toThrow(/food world markers are server-written/);
    asUser(a, `update public.user_settings set onboarded_at = now() where user_id = '${a}'`);
    expect(() => asUser(a, `update public.user_settings set food_world_default_due_at = null
      where user_id = '${a}'`)).toThrow(/food world markers are server-written/);
    runSql(`begin; set local role service_role;
      update public.user_settings set food_world_set_at = now() where user_id = '${a}'; commit;`);
    expect(markers(a)[2]).not.toBe("-");
  });
});
