/**
 * Phase 18 W2b food-world behaviour on the real migrated schema (SUPABASE_TEST_DB_URL: the CI
 * Integration job's local Supabase, which applies every migration; migrations 20261213090000 to
 * 20261213091200). The admission-input clocks are tests/migrations/food-world-clocks-db.test.ts.
 *
 * - The switch is server-written only.
 * - Acceptance 10 (the database half): a condition added to an open account from a second client
 *   closes it and sets the review marker in the same write; the marker cannot be cleared and the
 *   account cannot reopen until the condition is confirmed.
 * - Removing a condition deletes its confirmation, so adding it again needs review again.
 * - A closed account's conditions pause nothing.
 */
import "../tenancy/local-only";
import { afterAll, describe, expect, it } from "vitest";
import { HAS_DB, runSql } from "../helpers/supabase";
import { account, asUser, dropAccounts, marker, world } from "../helpers/world-db";

describe.skipIf(!HAS_DB)("food world on the migrated schema (W2b)", () => {
  afterAll(dropAccounts);

  it("only the server writes food_world", () => {
    const a = account();
    expect(() => asUser(a, `update public.user_settings set food_world = 'open' where user_id = '${a}'`))
      .toThrow(/food_world is server-written/);
    expect(world(a)).toBe("closed");
  });

  it("a condition added to an open account from a second client closes it until confirmed (acceptance 10)", () => {
    const a = account();
    runSql(`update public.user_settings set food_world = 'open' where user_id = '${a}'`);
    // The second client: Settings or the coach writes the constraint row under the user's session.
    asUser(a, `update public.constraint_profiles set conditions = '{"Celiac  disease"}', rev = rev + 1
      where user_id = '${a}'`);
    expect([world(a), marker(a)]).toEqual(["closed", "t"]);
    // No writer can clear the review or reopen before the user confirms.
    runSql(`update public.constraint_profiles set condition_review_required = false where user_id = '${a}'`);
    expect(marker(a)).toBe("t");
    expect(() => runSql(`update public.user_settings set food_world = 'open' where user_id = '${a}'`))
      .toThrow(/condition_review/);
    runSql(`insert into public.food_world_condition_confirmations (user_id, condition_key, choice)
      values ('${a}', 'celiac disease', 'pack')`);
    runSql(`update public.constraint_profiles set condition_review_required = false where user_id = '${a}'`);
    runSql(`update public.user_settings set food_world = 'open' where user_id = '${a}'`);
    expect([world(a), marker(a)]).toEqual(["open", "f"]);
  });

  it("removing a condition deletes its confirmation, so adding it again needs review again (Sol r1 BLOCK 4)", () => {
    const a = account();
    asUser(a, `update public.constraint_profiles set conditions = '{Celiac}', rev = rev + 1 where user_id = '${a}'`);
    runSql(`insert into public.food_world_condition_confirmations (user_id, condition_key, choice)
      values ('${a}', 'celiac', 'pack')`);
    runSql(`update public.user_settings set food_world = 'open' where user_id = '${a}'`);
    expect([world(a), marker(a)]).toEqual(["open", "f"]);
    asUser(a, `update public.constraint_profiles set conditions = '{}', rev = rev + 1 where user_id = '${a}'`);
    expect(runSql(`select count(*) from public.food_world_condition_confirmations where user_id = '${a}'`)).toBe("0");
    expect([world(a), marker(a)]).toEqual(["open", "f"]);
    asUser(a, `update public.constraint_profiles set conditions = '{celiac}', rev = rev + 1 where user_id = '${a}'`);
    expect([world(a), marker(a)]).toEqual(["closed", "t"]);
  });

  it("a closed account's conditions pause nothing (acceptance 6's database half)", () => {
    const a = account();
    asUser(a, `update public.constraint_profiles set conditions = '{celiac}', rev = rev + 1 where user_id = '${a}'`);
    expect([world(a), marker(a)]).toEqual(["closed", "f"]);
  });
});
