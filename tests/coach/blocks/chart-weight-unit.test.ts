// The weight chart speaks the account's own unit (user_settings.weight_unit), so the weigh-in
// follow-up "Check your trends" shows the unit the weight was just logged in.
import { describe, expect, it } from "vitest";
import { runDirectBlockTool, type BlockHydrationContext } from "@/lib/coach/blocks";

function adminWith(weightUnit: string | null, kg: number[]) {
  const samples = kg.map((value, i) => ({ value, unit: "kg",
    start_time: `2026-09-${String(10 + i).padStart(2, "0")}T08:00:00Z`,
    end_time: `2026-09-${String(10 + i).padStart(2, "0")}T08:00:00Z`, tz: "UTC",
    device_label: "scale", vendor_sample_id: `s${i}`, health_sources: { kind: "manual" } }));
  const chain = (rows: unknown[]) => {
    const builder = {
      select: () => builder, eq: () => builder, gte: () => builder, lt: () => builder,
      order: async () => ({ data: rows, error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    };
    return builder;
  };
  return { from: (table: string) => table === "user_settings"
    ? chain(weightUnit === null ? [] : [{ weight_unit: weightUnit }])
    : chain(samples) } as unknown as BlockHydrationContext["admin"];
}

function ctx(admin: BlockHydrationContext["admin"], weightUnit?: "lb" | "kg") {
  return { admin, userId: "u1", date: "2026-09-14", tz: "UTC", context: null,
    profile: {} as BlockHydrationContext["profile"], newId: () => "chart-1",
    ...(weightUnit ? { weightUnit } : {}) } as BlockHydrationContext;
}

const chartUnit = async (c: BlockHydrationContext) => {
  const { block } = await runDirectBlockTool("show_chart", { chart: "weight_trend", days: 7 }, c);
  return block?.kind === "chart" ? { unit: block.unit, first: block.series[0].points[0].y } : null;
};

describe("weight_trend chart unit", () => {
  it("uses kg when the account chose kg", async () => {
    expect(await chartUnit(ctx(adminWith("kg", [60, 60.4])))).toEqual({ unit: "kg", first: 60 });
  });

  it("uses lb when the account chose lb, or never chose", async () => {
    expect(await chartUnit(ctx(adminWith("lb", [60, 60.4])))).toEqual({ unit: "lb", first: 132.3 });
    expect((await chartUnit(ctx(adminWith(null, [60, 60.4]))))?.unit).toBe("lb");
  });

  it("an injected unit wins over the stored one", async () => {
    expect((await chartUnit(ctx(adminWith("lb", [60]), "kg")))?.unit).toBe("kg");
  });
});
