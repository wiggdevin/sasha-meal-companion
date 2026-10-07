import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUsers, HAS_BRANCH, resetUser } from "../helpers/supabase";
import { dropCatalogFixture, exec, fixtureVersion, fixtureToken, fixtureRevisionIds, HAS_DB, seedCatalogFixture, sql } from "./fixtures";

const RUN = HAS_BRANCH && HAS_DB;
const TAG = "crossuser";

type Row = { revision_id: number; description: string; score: number; f_prior: number; f_eats: number };

describe.skipIf(!RUN)("catalog_search is the caller's own view", () => {
  let a: SupabaseClient;
  let b: SupabaseClient;
  let chickenBreastFoodId: string;
  let userAId: string;

  beforeAll(async () => {
    seedCatalogFixture(TAG);
    const users = await createTestUsers();
    // The log_items seed below attaches to EVERY log_entries row user A owns, so entries left by
    // an earlier suite in the same run would inflate f_prior: start both users from nothing.
    await Promise.all([resetUser(users.a.userId), resetUser(users.b.userId)]);
    userAId = users.a.userId;
    a = users.a.client;
    b = users.b.client;
    chickenBreastFoodId = sql(`
      select cf.id::text from catalog_foods cf
        where cf.source = 'off' and cf.source_id = 'test-crossuser-1'`);

    // User A: one food_ref, Eats on the roasted breast, five logs inside 90 days.
    exec(`
      insert into food_refs (kind, catalog_food_id) values ('catalog', ${chickenBreastFoodId})
        on conflict do nothing;
      insert into user_food_prefs (user_id, food_ref_id, status)
        select '${users.a.userId}', fr.id, 'eats' from food_refs fr
         where fr.catalog_food_id = ${chickenBreastFoodId}
        on conflict (user_id, food_ref_id) do update set status = 'eats';
      insert into user_food_prefs (user_id, food_ref_id, status)
        select '${users.b.userId}', fr.id, 'avoid' from food_refs fr
         where fr.catalog_food_id = ${chickenBreastFoodId}
        on conflict (user_id, food_ref_id) do update set status = 'avoid';
      insert into log_entries (id, user_id, eaten_at, tz, local_date, slot, method)
        select gen_random_uuid(), '${users.a.userId}', now(), 'America/New_York',
               current_date - g, 'meal1', 'search'
          from generate_series(1, 5) g;
      insert into log_items (id, entry_id, seq, qty, unit, food_ref_id, grams, snapshot)
        select gen_random_uuid(), le.id, 1, 1, 'g', fr.id, 100, '{}'::jsonb
          from log_entries le
          cross join food_refs fr
         where le.user_id = '${users.a.userId}' and fr.catalog_food_id = ${chickenBreastFoodId};
    `);
  });

  afterAll(() => {
    exec(`
      delete from log_items li using log_entries le
        where le.id = li.entry_id and le.user_id = '${userAId}';
      delete from log_entries where user_id = '${userAId}';
      delete from user_food_prefs where food_ref_id in
        (select id from food_refs where catalog_food_id = ${chickenBreastFoodId});
      delete from food_refs where catalog_food_id = ${chickenBreastFoodId};
    `);
    dropCatalogFixture(TAG);
  });

  async function search(client: SupabaseClient): Promise<Row[]> {
    const { data, error } = await client.rpc("catalog_search", {
      p_q: `${fixtureToken(TAG)} chicken`, p_brand: null, p_prep: null, p_limit: 25,
    });
    expect(error).toBeNull();
    const ids = fixtureRevisionIds(TAG);
    return ((data ?? []) as Row[]).filter((row) => ids.has(row.revision_id));
  }

  it("gives user A her own prior and Eats status", async () => {
    const row = (await search(a)).find((r) => r.description.includes("breast, meat only"));
    expect(Number(row?.f_eats)).toBe(1);
    expect(Number(row?.f_prior)).toBeCloseTo(Math.log(6) / Math.log(21), 4);
  });

  it("never leaks A's log count or Eats status into B's search", async () => {
    const row = (await search(b)).find((r) => r.description.includes("breast, meat only"));
    expect(Number(row?.f_prior)).toBe(0);
    expect(Number(row?.f_eats)).toBe(0);      // B has it on Avoid, not A's Eats
  });

  it("ranks an Avoid row below the same row without a preference", async () => {
    const forB = await search(b);
    const avoided = forB.find((r) => r.description.includes("breast, meat only"));
    const neutral = forB.find((r) => r.description.includes("thigh, meat only"));
    expect(Number(avoided?.f_eats)).toBeLessThan(Number(neutral?.f_eats));
  });

  it("returns only active revisions of the active version", async () => {
    exec(`update catalog_versions set is_active = false where version_label = '${fixtureVersion(TAG)}';`);
    expect((await search(a)).length).toBe(0);
    exec(`update catalog_versions set is_active = true where version_label = '${fixtureVersion(TAG)}';`);
    expect((await search(a)).length).toBeGreaterThan(0);
  });
});
