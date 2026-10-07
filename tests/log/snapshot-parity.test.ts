/**
 * Acceptance 1 and 2: the stored snapshot equals compute_item_snapshot, and the TypeScript mirror
 * agrees with it to 4 dp for catalog rows and for one of her own foods. [needs branch]
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeSnapshot, snapshotsEqual, type Snapshot } from "@/lib/nutrients/snapshot";
import type { NutrientCode } from "@/lib/nutrients/codes";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { dropCatalogFoods, seedCatalogFood, seedUserFood, type Fixture } from "./fixtures";

const run = HAS_BRANCH ? describe : describe.skip;

const SHAPES: { sourceId: string; description: string;
  per100g: Record<string, number | null> }[] = Array.from({ length: 20 }, (_, i) => ({
    sourceId: `parity-${i}`,
    description: `Parity fixture ${i}`,
    per100g: { energy_kcal: 50 + i * 7.3, protein: 1.1 + i * 0.37,
      carbohydrate: i % 3 === 0 ? 0 : 4.55 + i, fat_total: 0.25 * i,
      fiber_total: i % 4 === 0 ? null : 1.2 + i * 0.11,
      iron: i % 5 === 0 ? null : 0.33 + i * 0.017, sodium: i * 13 },
  }));

run("server snapshot equals the client snapshot", () => {
  let admin: Awaited<ReturnType<typeof createTestUsers>>["admin"];
  let userId = "";
  const fixtures: Fixture[] = [];

  beforeAll(async () => {
    const users = await createTestUsers();
    admin = users.admin;
    userId = users.a.userId;
    for (const shape of SHAPES) fixtures.push(await seedCatalogFood(admin, userId, shape));
    fixtures.push(await seedUserFood(admin, userId, { name: "Her bone broth",
      per100g: { energy_kcal: 12, protein: 2.4, sodium: 330, iron: null } }));
    fixtures.push(await seedUserFood(admin, userId, { name: "Her rice porridge",
      per100g: { energy_kcal: 71.5, protein: 1.35, carbohydrate: 15.9 } }));
    fixtures.push(await seedUserFood(admin, userId, { name: "Her collagen scoop",
      per100g: { protein: 90, energy_kcal: 360, calcium: 0 } }));
  }, 120_000); // 23 fixtures × ~6 round-trips each; the 10 s default hook timeout is too short on a remote branch

  afterAll(async () => {
    await dropCatalogFoods(admin, "parity-");
  }, 60_000);

  it("agrees for every fixture at three gram weights", async () => {
    for (const fixture of fixtures) {
      for (const grams of [37, 140, 212.5]) {
        const { data, error } = await admin.rpc("compute_item_snapshot",
          { p_food_ref_id: fixture.foodRefId, p_grams: grams });
        expect(error).toBeNull();
        const server = data as Snapshot;
        const client = computeSnapshot(
          fixture.per100g as Record<NutrientCode, number | null>, grams,
          { source: fixture.source, source_version: fixture.versionLabel,
            revision_id: fixture.revisionId || null });
        expect(snapshotsEqual(server, client, 1e-4),
          `${fixture.description} @ ${grams} g`).toBe(true);
      }
    }
  }, 120_000); // 23 fixtures × 3 gram weights, one RPC each

  it("carries the source and source version the export must report", async () => {
    const fixture = fixtures[0];
    const { data } = await admin.rpc("compute_item_snapshot",
      { p_food_ref_id: fixture.foodRefId, p_grams: 100 });
    expect((data as Snapshot).protein).toMatchObject({ basis: "per_100g",
      source: fixture.source, source_version: fixture.versionLabel,
      revision_id: fixture.revisionId });
  });
});
