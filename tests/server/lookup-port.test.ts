/**
 * Phase 13 slice 6, review r1 (sol BLOCK): the coach's `lookup` port hands the D0 gate every stored
 * profile term it has — conditions as well as allergens — and the turn's abort signal, so a
 * lookup still in flight when the tool batch stops waiting is cancelled rather than left running
 * past the reply deadline.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const runLookup = vi.hoisted(() => vi.fn(async () => ({ ok: false, subject: "x", refusal: "unresolved" })));
vi.mock("@/lib/server/lookup-lane", () => ({ runLookup }));
vi.mock("@/lib/server/constraints", () => ({
  getProfile: vi.fn(async () => ({
    profile: { avoid_allergens: ["peanut"], avoid_food_ref_ids: [], banned_categories: [],
      conditions: ["chronic kidney disease"], notes: null },
    rev: 1,
  })),
}));

const { defaultPorts } = await import("@/lib/server/coach-ports");

describe("the lookup port", () => {
  it("passes stored conditions and allergens to the subject gate, and the turn's signal", async () => {
    const turn = new AbortController();
    const ports = defaultPorts({} as SupabaseClient, {} as SupabaseClient, () => "id-1",
      { tz: "America/Denver", date: "2026-09-20" }, { signal: turn.signal });
    await ports.lookup("u1", "Wheat Thins");
    expect(runLookup).toHaveBeenCalledTimes(1);
    const [, userId, subject, , ctx, opts] = runLookup.mock.calls[0] as unknown as unknown[];
    expect(userId).toBe("u1");
    expect(subject).toBe("Wheat Thins");
    expect(ctx).toEqual({ allergens: ["peanut"], conditions: ["chronic kidney disease"] });
    expect(opts).toEqual({ signal: turn.signal });
  });
});
