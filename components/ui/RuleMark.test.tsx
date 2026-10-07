// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import RuleMark from "@/components/ui/RuleMark";

afterEach(cleanup);

describe("RuleMark", () => {
  it("says a blocked line is off the rules, with the server's own reason", () => {
    render(<RuleMark mark={{ verdict: "blocked", reason: "Peanut butter has peanut, which your rules exclude." }} />);
    expect(screen.getByText("Off your rules")).toBeTruthy();
    expect(screen.getByText("Peanut butter has peanut, which your rules exclude.")).toBeTruthy();
  });

  it("asks to check an unknown line, and keeps the reason for assistive tech in the tag form", () => {
    const { container } = render(<RuleMark variant="tag" mark={{ verdict: "unknown", reason: "Checking against your updated food rules" }} />);
    expect(container.textContent).toBe("Check: Checking against your updated food rules");
    expect(container.querySelector("[data-rule-mark='unknown']")?.getAttribute("title")).toBe("Checking against your updated food rules");
  });

  it("starts the reason with a capital when it opens on a food's lowercase name", () => {
    render(<RuleMark mark={{ verdict: "unknown", reason: "whey protein powder is not in your foods." }} />);
    expect(screen.getByText("Whey protein powder is not in your foods.")).toBeTruthy();
  });

  it("lets a long unbroken reason wrap inside a narrow row", () => {
    const long = "Pneumonoultramicroscopicsilicovolcanoconiosisflavouredcrisps is not in your foods.";
    render(<RuleMark mark={{ verdict: "unknown", reason: long }} />);
    expect(screen.getByText(long).className).toContain("break-words");
    expect(screen.getByText(long).className).toContain("min-w-0");
  });

  it("renders nothing without a mark", () => {
    const { container } = render(<RuleMark mark={null} />);
    expect(container.innerHTML).toBe("");
  });
});
