/**
 * The server `ComposePorts.pool`/`openWorld` pair for a direct `compose_meal` wish (Phase 18 W9),
 * split out of `lib/server/coach-ports.ts` to keep that file under the project's file-size
 * budget. A closed account's own Eats, filtered to CURRENTLY eligible rows only (the same
 * evidence/policy gate every other generating surface reads, `eligibleFoods` -- a raw Eats mark
 * can be stale: added before a rule that would now block it); an open account's caller runs the
 * SAME fresh admission read (D11) through `openWorldInputs` (W8) instead of building it twice.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComposePorts } from "@/lib/coach/compose";

export function composePoolPorts(
  client: SupabaseClient, admin: SupabaseClient, now?: string,
): Pick<ComposePorts, "pool" | "poolRefs" | "openWorld"> {
  return {
    pool: async (uid) => {
      const { foodsFor } = await import("@/lib/server/day-context");
      const { eligibleFoods } = await import("@/lib/server/eligible-foods");
      const [foods, eligible] = await Promise.all([foodsFor(admin, uid), eligibleFoods(client, uid)]);
      const admitted = new Set(eligible.eligibleFoodIds);
      return Object.fromEntries(Object.entries(foods).filter(([id]) => admitted.has(id)));
    },
    poolRefs: async (uid) => {
      const { userFoodRefIds } = await import("@/lib/server/day-context");
      return userFoodRefIds(admin, uid);
    },
    openWorld: async (uid) => {
      const { mealSnapshotV3 } = await import("@/lib/server/meal-snapshot-v3");
      const snapshot = await mealSnapshotV3(client, uid, now ? new Date(now) : new Date());
      if (!("world" in snapshot) || snapshot.world !== "open") return null;
      const { openWorldInputs } = await import("@/lib/meals/open-world");
      const { foodsFor } = await import("@/lib/server/day-context");
      return openWorldInputs(snapshot, await foodsFor(admin, uid));
    },
  };
}
