// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthSourceRecipes } from "@/components/HealthSourcesSheet";

describe("Apple Health setup recipes", () => {
  it("orders the free Shortcut before the paid exporter and uses the fixed labels", () => {
    const { container } = render(<HealthSourceRecipes shortcutUrl={null} busy={false}
      online onIssue={() => {}} />);
    const text = container.textContent ?? "";
    const free = "Free (Shortcut) · needs your phone unlocked at the sync time";
    const paid = "Most reliable (Health Auto Export, paid app)";
    expect(text.indexOf(free)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(free)).toBeLessThan(text.indexOf(paid));
    expect(text).toContain("Premium is $1.99/month, $6.99/year, or $24.99 lifetime.");
    expect(text).toContain("The ready-made Shortcut is not published yet");
    expect(text).toContain('"source_kind": "apple_health_shortcut"');
  });

  it("shows Add Shortcut only when the public URL exists", () => {
    render(<HealthSourceRecipes shortcutUrl="https://www.icloud.com/shortcuts/example"
      busy={false} online onIssue={() => {}} />);
    expect(screen.getByRole("link", { name: "Add Shortcut" }).getAttribute("href"))
      .toBe("https://www.icloud.com/shortcuts/example");
  });

  it("keeps every interactive setup control at least 44px high", () => {
    render(<HealthSourceRecipes shortcutUrl={null} busy={false} online onIssue={() => {}} />);
    // A system button's md and lg sizes are 44 and 52 px (components/ui/Button, DESIGN.md §Buttons).
    for (const control of screen.getAllByRole("button")) {
      expect(control.className).toMatch(/(?:\bbtn-(?:md|lg)\b|h-11|min-h-1[12])/);
    }
  });
});
