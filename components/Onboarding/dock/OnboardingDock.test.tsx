// @vitest-environment jsdom
/**
 * Visual-state coverage for the four dock modes (onboarding v2, lane L2 acceptance criteria):
 * mic, chips, game and confirm each render their own content inside the one glass pill, and the
 * reduced-motion path renders exactly the same content with every spring collapsed to instant.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MotionConfig } from "motion/react";
import OnboardingDock from "./OnboardingDock";

afterEach(cleanup);

describe("OnboardingDock", () => {
  it("mic mode: one labelled answer field and a record control, nothing else", () => {
    render(<OnboardingDock mode="mic" reduce={false} value="" placeholder="Tell Sasha" />);
    // Sol review: this is an answer to Sasha's question, not a search — no search/searchbox role.
    screen.getByRole("textbox", { name: "Tell Sasha" });
    expect(screen.queryByRole("searchbox")).toBeNull();
    screen.getByRole("button", { name: "Record" });
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("chips mode: every chip renders, and 'None' can be marked the largest", () => {
    const onPick = vi.fn();
    render(<OnboardingDock mode="chips" reduce={false} onPick={onPick}
      chips={[{ key: "none", label: "No, nothing", emphasis: "largest" }, { key: "rule", label: "Allergy or rule" }]} />);
    screen.getByRole("group", { name: "Choose one" });
    fireEvent.click(screen.getByRole("button", { name: "No, nothing" }));
    expect(onPick).toHaveBeenCalledWith("none");
  });

  it("game mode: shows only the escape chip — the game itself is not inside the dock", () => {
    const onEscape = vi.fn();
    render(<OnboardingDock mode="game" reduce={false} escapeLabel="Sprout, pick for me" onEscape={onEscape} />);
    fireEvent.click(screen.getByRole("button", { name: "Sprout, pick for me" }));
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("confirm mode: one primary button that confirms the beat", () => {
    const onConfirm = vi.fn();
    render(<OnboardingDock mode="confirm" reduce={false} confirmLabel="That's me" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "That's me" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("morphs between modes with no page transition — the same dock element stays mounted", () => {
    const { rerender, container } = render(<OnboardingDock mode="mic" reduce={false} value="" />);
    const dock = container.querySelector('[data-onboarding-dock="true"]');
    expect(dock).not.toBeNull();
    rerender(<OnboardingDock mode="confirm" reduce={false} confirmLabel="That's me" />);
    expect(container.querySelector('[data-onboarding-dock="true"]')).toBe(dock);
    expect(dock?.getAttribute("data-mode")).toBe("confirm");
  });

  it("renders the same chip content under reduced motion, collapsed to instant", () => {
    render(<MotionConfig reducedMotion="always">
      <OnboardingDock mode="chips" reduce chips={[{ key: "a", label: "A" }, { key: "b", label: "B" }]} />
    </MotionConfig>);
    screen.getByRole("button", { name: "A" });
    screen.getByRole("button", { name: "B" });
  });

  it("makes the outgoing mode inert under reduced motion, where it unmounts on the same tick (Sol review)", () => {
    const { rerender, container } = render(<MotionConfig reducedMotion="always">
      <OnboardingDock mode="mic" reduce value="" />
    </MotionConfig>);
    rerender(<MotionConfig reducedMotion="always">
      <OnboardingDock mode="confirm" reduce confirmLabel="That's me" />
    </MotionConfig>);
    // Only the arriving mode's controls remain reachable — the mic field left with its layer.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(container.querySelectorAll('[data-onboarding-dock="true"] button').length).toBeGreaterThan(0);
  });

  it("moves focus to the arriving mode's own control when the dock held focus before the change"
    + " (Sol review round 3: a keyboard Tab used to start over from the document)", async () => {
    const { rerender } = render(<MotionConfig reducedMotion="always">
      <OnboardingDock mode="chips" reduce chips={[{ key: "a", label: "A" }]} />
    </MotionConfig>);
    screen.getByRole("button", { name: "A" }).focus();
    rerender(<MotionConfig reducedMotion="always">
      <OnboardingDock mode="confirm" reduce confirmLabel="That's me" />
    </MotionConfig>);
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "That's me" })));
  });

  it("never steals focus into the dock when it held none before the mode changed", () => {
    const { rerender } = render(<OnboardingDock mode="chips" reduce chips={[{ key: "a", label: "A" }]} />);
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "A" }));
    rerender(<OnboardingDock mode="confirm" reduce confirmLabel="That's me" />);
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
  });
});
