// @vitest-environment jsdom
/**
 * Phase 18 W5b UI hand-off: the hint under a dietary text field once the local safety check keeps
 * the text on the phone (docs/specs/phase-18-open-world-foods.md §W5b acceptance 2's last line).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DietaryTextHint from "@/components/ui/DietaryTextHint";

afterEach(() => cleanup());

describe("DietaryTextHint", () => {
  it("shows nothing while there is no local answer", () => {
    const { container } = render(<DietaryTextHint offer={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("offers the rule editor for a rule, allergy, condition or symptom, never a diagnosis", () => {
    render(<DietaryTextHint offer="rule_editor" onAddRule={vi.fn()} />);
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("food rule");
    expect(notice.textContent?.toLowerCase()).not.toMatch(/diagnos|you have|see a doctor/);
    expect(screen.getByRole("button", { name: "Add it as a rule" })).toBeTruthy();
  });

  it("jumps to the rule editor on that action", () => {
    const onAddRule = vi.fn();
    render(<DietaryTextHint offer="rule_editor" onAddRule={onAddRule} />);
    fireEvent.click(screen.getByRole("button", { name: "Add it as a rule" }));
    expect(onAddRule).toHaveBeenCalledOnce();
  });

  it("shows the rule-editor line with no action when the caller gives none", () => {
    render(<DietaryTextHint offer="rule_editor" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("asks for plain likes and dislikes for unsure text, with no action", () => {
    render(<DietaryTextHint offer="plain_prefs" onAddRule={vi.fn()} />);
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("plain likes and dislikes");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("never tells anyone to eat or not eat, and gives no medical advice", () => {
    render(<DietaryTextHint offer="rule_editor" onAddRule={vi.fn()} />);
    render(<DietaryTextHint offer="plain_prefs" />);
    const text = screen.getAllByRole("status").map((n) => n.textContent).join(" ").toLowerCase();
    expect(text).not.toMatch(/\b(eat|avoid|don't eat|should eat)\b/);
  });
});
