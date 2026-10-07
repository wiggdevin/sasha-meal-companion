// The macros_today chart says when the day's consumed figures are a lower bound (#21), so the
// coach's rings can read "at most" for what is left. The flag reaches the block only; the model's
// acknowledgement stays the chart name and point count.
import { describe, expect, it } from "vitest";
import { runDirectBlockTool, type BlockHydrationContext } from "@/lib/coach/blocks";
import { hydrateChart } from "@/lib/coach/blocks/hydrate-chart";
import type { CoachContext } from "@/lib/server/coach-context";
import { chartBlockV1Schema } from "@/lib/coach/ui-blocks";

const consumed = { protein: 72, carbs: 140, fat: 38, kcal: 1300 };
const targets = { protein: 135, carbs: 240, fat: 70, kcal: 2200 };

function ctx(day: Record<string, unknown>): BlockHydrationContext {
  return {
    admin: {} as BlockHydrationContext["admin"], userId: "u1", date: "2026-09-14", tz: "UTC",
    context: { day: { date: "2026-09-14", consumed, targets, consumedPartial: false, ...day } } as unknown as CoachContext,
    profile: {} as BlockHydrationContext["profile"], newId: () => "chart-1",
  };
}

async function macros(day: Record<string, unknown>) {
  return runDirectBlockTool("show_chart", { chart: "macros_today" }, ctx(day));
}

describe("macros_today partial flag", () => {
  it("the hydrator sets partial only for a partial day", () => {
    const whole = hydrateChart({ chart: "macros_today" }, { id: "c", day: { consumed, targets } });
    expect(whole && "partial" in whole).toBe(false);
    const partial = hydrateChart({ chart: "macros_today" },
      { id: "c", day: { consumed, targets, partial: true } });
    expect(partial?.partial).toBe(true);
    expect(chartBlockV1Schema.parse(partial).partial).toBe(true);
  });

  it("marks the block from the day's consumedPartial and keeps it through validation", async () => {
    const { block, data } = await macros({ consumedPartial: true });
    expect(block?.kind === "chart" && block.partial).toBe(true);
    expect(JSON.stringify(data)).not.toContain("partial");
  });

  it("marks the block when the day's partial check could not run", async () => {
    const { block } = await macros({ nutritionUnchecked: true });
    expect(block?.kind === "chart" && block.partial).toBe(true);
  });

  it("leaves a whole day unmarked", async () => {
    const { block } = await macros({});
    expect(block?.kind).toBe("chart");
    expect(block && "partial" in block).toBe(false);
  });
});
