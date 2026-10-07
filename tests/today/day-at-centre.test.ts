// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { dayAtCentre } from "@/components/TodayDayStrip";

/** A strip of 57 days 50 px wide behind a 180 px spacer, in a 350 px viewport. */
function strip(scrollLeft: number, renderedScale: number) {
  const element = document.createElement("div");
  for (let i = 0; i < 57; i++) {
    const day = document.createElement("button");
    day.dataset.date = `d${i}`;
    Object.defineProperty(day, "offsetLeft", { value: 150 + i * 50 });
    Object.defineProperty(day, "offsetWidth", { value: 50 });
    // A scaled face renders every day smaller; the pick must not care.
    day.getBoundingClientRect = () => ({ width: 50 * renderedScale }) as DOMRect;
    element.appendChild(day);
  }
  Object.defineProperty(element, "scrollLeft", { value: scrollLeft });
  Object.defineProperty(element, "clientWidth", { value: 350 });
  return element;
}

describe("the day under the strip's centre", () => {
  it("is the centred day, whatever scale the face is drawn at", () => {
    // Day 28 centred: its middle (150 + 28*50 + 25 = 1575) sits at scrollLeft + 175.
    expect(dayAtCentre(strip(1400, 1))).toBe("d28");
    expect(dayAtCentre(strip(1400, 0.98))).toBe("d28");
    expect(dayAtCentre(strip(1400, 0.6))).toBe("d28");
  });

  it("follows a scrub to the neighbouring day past the halfway point", () => {
    expect(dayAtCentre(strip(1424, 1))).toBe("d28");
    expect(dayAtCentre(strip(1426, 1))).toBe("d29");
  });
});
