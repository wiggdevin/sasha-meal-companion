// @vitest-environment jsdom
/** The AI label (PR #373 provenance): "AI" for a model, "AI ranked" for Jev, nothing for the app. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import AiLabel from "@/components/ui/AiLabel";
import { BY_APP, byJev, byModel } from "@/lib/provenance";

afterEach(cleanup);

describe("AiLabel", () => {
  it("says AI for a model's words, with an accessible name", () => {
    const { container } = render(<AiLabel provenance={byModel("coach")} />);
    expect(screen.getByText("Written by AI")).toBeTruthy();
    const label = container.querySelector("[data-ai-label]")!;
    expect(label.getAttribute("data-ai-label")).toBe("model");
    expect(label.querySelector("[aria-hidden='true']")!.textContent).toBe("AI");
    expect(label.className).toContain("text-tiny");
    expect(label.className).toContain("text-graphite");
  });

  it("says AI ranked for a Jev-ordered card", () => {
    const { container } = render(<AiLabel provenance={byJev("suggest-options")} />);
    expect(screen.getByText("Ranked by AI")).toBeTruthy();
    expect(container.querySelector("[aria-hidden='true']")!.textContent).toBe("AI ranked");
  });

  it("labels no other Jev use: an intent read or a purpose-less Jev call", () => {
    expect(render(<AiLabel provenance={byJev("coach-intent")} />).container.innerHTML).toBe("");
    expect(render(<AiLabel provenance={byJev()} />).container.innerHTML).toBe("");
  });

  it("renders nothing for app-written content or a legacy row with no provenance", () => {
    expect(render(<AiLabel provenance={BY_APP} />).container.innerHTML).toBe("");
    expect(render(<AiLabel provenance={undefined} />).container.innerHTML).toBe("");
    expect(render(<AiLabel provenance={null} />).container.innerHTML).toBe("");
  });
});
