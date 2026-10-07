// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ChartBlock from "@/components/coach/blocks/chart";
import type { ChartBlockV1 } from "@/lib/coach/ui-blocks";

afterEach(cleanup);

const base = {
  kind: "chart", v: 1, id: "chart-1", unit: "lb", caption: "Weight this month",
} as const;

describe("chart block", () => {
  it("renders a weight sparkline with caption and the last value in its accessible name", () => {
    render(<ChartBlock block={{ ...base, chart: "weight_trend", series: [
      { label: "Forecast", points: [{ x: "2026-09-19", y: 140 }] },
      { label: "Weight", points: [{ x: "2026-09-18", y: 126.5 }, { x: "2026-09-19", y: 127 }] },
    ] }} />);

    expect(screen.getByText("Weight this month")).toBeTruthy();
    expect(screen.getAllByLabelText(/last value 127 lb/).length).toBeGreaterThan(0);
  });

  it("renders today's hydrated values through MacroRings", () => {
    render(<ChartBlock block={{ ...base, chart: "macros_today", unit: "g / kcal",
      caption: "Today's macros and calories", series: [
        { label: "Consumed", points: [
          { x: "protein", y: 80 }, { x: "carbs", y: 120 },
          { x: "kcal", y: 1300 }, { x: "fat", y: 40 },
        ] },
        { label: "Target", points: [
          { x: "protein", y: 130 }, { x: "carbs", y: 220 },
          { x: "fat", y: 65 }, { x: "kcal", y: 2100 },
        ] },
      ] }} />);

    expect(screen.getByLabelText("Calories: 1,300 of 2,100 kcal")).toBeTruthy();
    expect(screen.getByText("Today's macros and calories")).toBeTruthy();
    expect(screen.getByLabelText(/last value 1300 g \/ kcal/)).toBeTruthy();
    expect(screen.queryByText(/at most|at least/)).toBeNull();
  });

  /* t23 #6: an unknown-nutrient item leaves the day's macros_today chart a lower bound — mark it
     partial, never whole. */
  it("marks the day's macros as a lower bound when the chart is partial", () => {
    const points = { Consumed: [{ x: "protein", y: 80 }, { x: "carbs", y: 120 },
      { x: "kcal", y: 1300 }, { x: "fat", y: 40 }],
      Target: [{ x: "protein", y: 130 }, { x: "carbs", y: 220 }, { x: "fat", y: 65 }, { x: "kcal", y: 2100 }] };
    render(<ChartBlock block={{ ...base, chart: "macros_today", unit: "g / kcal",
      caption: "Today's macros and calories", partial: true,
      series: [{ label: "Consumed", points: points.Consumed }, { label: "Target", points: points.Target }] }} />);
    expect(screen.getByText(/at most/)).toBeTruthy();
  });

  it("renders a populated week: seven calorie bars and the target line", () => {
    const points = Array.from({ length: 7 }, (_, index) => ({
      x: `2026-09-${index + 10}`, y: 1500 + index * 10,
    }));
    const { container } = render(<ChartBlock block={{ ...base, chart: "kcal_week", unit: "kcal",
      caption: "Calories this week", series: [
        { label: "Target", points: points.map((point) => ({ ...point, y: 2100 })) },
        { label: "Consumed", points },
      ] }} />);

    expect(container.querySelectorAll("rect")).toHaveLength(7);
    expect(container.querySelector("path")).toBeTruthy();
    expect(screen.getAllByLabelText(/last value 1560 kcal/).length).toBeGreaterThan(0);
  });

  it("renders nothing for an empty series", () => {
    const block: ChartBlockV1 = { ...base, chart: "weight_trend",
      series: [{ label: "Weight", points: [] }] };
    const { container } = render(<ChartBlock block={block} />);
    expect(container.innerHTML).toBe("");
  });
});
