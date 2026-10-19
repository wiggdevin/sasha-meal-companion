// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CLEARED } from "@/lib/ai/call-registry";
import ProcessorsSection, { PROCESSORS } from "./ProcessorsSection";

/** Every model provider in the call registry, by the name the notice gives it (OD12). */
const PROVIDER_NAMES: Record<keyof typeof CLEARED, string> = {
  google: "Google Gemini",
  openrouter: "OpenRouter",
  typesafe: "TypeSafe (Jev)",
};

describe("Who handles your data", () => {
  afterEach(cleanup);

  it("names every model provider the app can call", () => {
    const names = PROCESSORS.map((processor) => processor.name);
    for (const provider of Object.keys(CLEARED) as (keyof typeof CLEARED)[]) {
      expect(names).toContain(PROVIDER_NAMES[provider]);
    }
  });

  it("names OpenStreetMap for the Shopping store map (UI makeover W8)", () => {
    expect(PROCESSORS).toContainEqual({
      name: "OpenStreetMap",
      what: "The area and country you type, and rounded coordinates, go through our server. "
        + "Map tiles load from OpenStreetMap, which sees your IP address.",
    });
  });

  it("renders each processor with what it does", () => {
    render(<ProcessorsSection />);
    expect(screen.getByRole("region", { name: "Who handles your data" })).toBeTruthy();
    for (const processor of PROCESSORS) {
      expect(screen.getByText(processor.name)).toBeTruthy();
      expect(screen.getByText(processor.what)).toBeTruthy();
    }
  });
});
