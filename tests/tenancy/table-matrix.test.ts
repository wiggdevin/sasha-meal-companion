/**
 * Spec 3.2 (Phase 9 slice 3): for every declared table, user A with a real JWT runs every
 * operation against a row she owns and against a row user B owns. A declared operation must work
 * on her own row, an undeclared one must not, and nothing she runs may reach B's row. The effect is
 * measured with the admin client (row returned, inserted, changed or gone), never from what the
 * user client reports.
 *
 * `overgrants` lists operations the database allows on the user's own row that the spec does not
 * declare (review r1 finding 7: spec 3.2 gives `plan_days` select, insert and update, but the
 * grant and the `for all` policy also allow delete). Such a case is a plain `it` named OVERGRANT
 * that proves the operation still succeeds (row reached, no error), so CI does not declare it; when
 * the grant is narrowed it turns red: remove the overgrant, and the "is refused" case takes over.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, adminClient, ensureUser, userClient, type TestUser,
} from "../helpers/supabase";
import { dropCatalogFoods, seedCatalogFood } from "../log/fixtures";
import manifest from "./table-ops.json";
import { OPS, probe, purge, type Op } from "./seed";

type Entry = { ops: string[]; seed: string; overgrants?: string[] };
const entries = Object.entries(manifest as Record<string, Entry>);
const OVERGRANT = " (OVERGRANT: the database allows it, the spec does not declare it)";

describe.skipIf(!HAS_BRANCH)("declared operations matrix (spec 3.2)", () => {
  let a: TestUser;
  let b: TestUser;
  let asA: SupabaseClient;

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await purge([a.id, b.id]);
    asA = await userClient(a);
  });

  afterAll(async () => {
    await purge([a.id, b.id]);
    await dropCatalogFoods(adminClient(), "tenancy-shared-");
  });

  it("food_refs: a shared catalog ref stays readable to A (control for user refs)", async () => {
    const food = await seedCatalogFood(adminClient(), b.id, {
      sourceId: `tenancy-shared-${crypto.randomUUID()}`, description: "Tenancy shared food",
      per100g: { protein: 1 } });
    const { data, error } = await asA.from("food_refs").select("id").eq("id", food.foodRefId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: food.foodRefId }]);
  });

  for (const [table, entry] of entries) {
    for (const op of OPS) {
      const declared = entry.ops.includes(op);
      const overgrant = entry.overgrants?.includes(op) ?? false;
      if (overgrant) {
        it(`${table}: ${op} on A's own row works today${OVERGRANT}`, async () => {
          const r = await probe(asA, entry.seed, op as Op, a.id, a.id);
          expect({ affected: r.affected, error: r.error }).toEqual({ affected: 1, error: null });
        });
      } else {
        it(`${table}: ${op} on A's own row ${declared ? "works" : "is refused"}`, async () => {
          const r = await probe(asA, entry.seed, op as Op, a.id, a.id);
          expect({ affected: r.affected > 0, error: r.error })
            .toMatchObject({ affected: declared });
        });
      }

      it(`${table}: ${op} on B's row reaches nothing`, async () => {
        const r = await probe(asA, entry.seed, op as Op, b.id, a.id);
        expect(r.affected).toBe(0);
      });
    }
  }
});
