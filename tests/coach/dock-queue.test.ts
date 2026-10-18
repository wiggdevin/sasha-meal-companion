// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { clearCoachDockText, deliverDockText, queueCoachDockText } from "@/components/coach/use-dock-submit";

afterEach(() => clearCoachDockText());

describe("the parked dock question (UI audit 2026-10-18)", () => {
  it("parks one question and refuses a second, so the field keeps that draft", () => {
    expect(deliverDockText("first")).toBe(true);
    expect(deliverDockText("second")).toBe(false);
  });

  it("takes a new question once the parked one is dropped", () => {
    expect(queueCoachDockText("first")).toBe(true);
    clearCoachDockText();
    expect(queueCoachDockText("second")).toBe(true);
  });

  it("never parks blank text", () => {
    expect(queueCoachDockText("   ")).toBe(false);
    expect(queueCoachDockText("real")).toBe(true);
  });
});
