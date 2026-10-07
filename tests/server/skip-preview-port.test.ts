/**
 * The preview_skip tool on the server: it reads the named date's plan and logs and writes nothing,
 * and the suggestion build can read a named slot's planned clock time (lib/coach/meal-type.ts).
 */
import { describe, expect, it } from "vitest";
import { defaultPorts, skipPreview } from "@/lib/server/coach-ports";
import { makeExecutors } from "@/lib/coach/executors";
import { lookupTool } from "@/lib/coach/registry";
import { seeded } from "../coach/context-fixtures";

const TUESDAY = "2026-09-15";

describe("preview_skip", () => {
  it("previews a skip on the named date from its own plan and logs", async () => {
    // seeded(): Meal 1 eaten, a 198 kcal log under Meal 2; the 15th is a 1800 kcal rest day.
    const preview = await skipPreview(seeded(), "u1", TUESDAY, "meal-3");
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.freedKcal).toBeGreaterThan(0);
    expect(preview.rows.find((row) => row.slot === "meal-1")?.state).toBe("eaten");
    expect(preview.absorbedBy.length).toBeGreaterThan(0);
    expect(await skipPreview(seeded(), "u1", TUESDAY, "meal-1")).toMatchObject({ ok: false });
  });

  it("is a read tool limited to meal slots, wired through the executor", async () => {
    const tool = lookupTool("preview_skip")!;
    expect(tool.effect).toBe("read");
    expect(tool.input.safeParse({ date: TUESDAY, slot: "meal-2" }).success).toBe(true);
    expect(tool.input.safeParse({ date: TUESDAY, slot: "coffee" }).success).toBe(false);
    const executors = makeExecutors(defaultPorts(seeded(), seeded(), () => "id",
      { tz: "America/Denver", date: TUESDAY }));
    expect(await executors.preview_skip("u1", { date: TUESDAY, slot: "meal-3" }))
      .toMatchObject({ ok: true, slot: "meal-3" });
  });

  it("answers plainly where no preview port is wired", async () => {
    const executors = makeExecutors({} as never);
    expect(await executors.preview_skip("u1", { date: TUESDAY, slot: "meal-3" }))
      .toMatchObject({ ok: false });
  });
});
