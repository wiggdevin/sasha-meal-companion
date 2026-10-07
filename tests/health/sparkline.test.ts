/**
 * @testing-library/react is not installed and no dependency may be added (contracts §1), so the
 * sparkline's geometry is tested through its exported pure helper and the screen itself is a manual
 * gate. The helper is what decides gap-versus-line, which is the rule worth protecting.
 */
import { describe, expect, it } from "vitest";
import { sparklineSegments } from "@/components/Sparkline";

describe("sparklineSegments", () => {
  it("breaks the path at a null instead of drawing through zero", () => {
    const segments = sparklineSegments([1, 2, null, 4], 100, 20);
    expect(segments).toHaveLength(2);
    expect(segments[0].split("L").length).toBe(2);
  });

  it("returns no segment for an isolated point and none at all for all nulls", () => {
    expect(sparklineSegments([null, 5, null], 100, 20)).toEqual([]);
    expect(sparklineSegments([null, null], 100, 20)).toEqual([]);
  });

  it("draws a flat series down the middle rather than dividing by zero", () => {
    const [path] = sparklineSegments([3, 3, 3], 100, 20);
    expect(path).toMatch(/^M0,10 L50,10 L100,10$/);
  });
});
