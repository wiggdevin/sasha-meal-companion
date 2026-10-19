/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PageTitle from "@/components/ui/PageTitle";

afterEach(() => { cleanup(); });

describe("PageTitle", () => {
  it("shows one visible h1 with its eyebrow over it", () => {
    render(<PageTitle eyebrow="Mon 19 Oct" title="Today" />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Today");
    expect(h1.className).not.toContain("sr-only");
    expect(h1.previousElementSibling?.textContent).toBe("Mon 19 Oct");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("offers a way back that can move in place", () => {
    const onClick = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(<PageTitle title="Sunday" back={{ href: "/", label: "Back to today", onClick }} trailing={<button type="button">Menu</button>} />);
    const link = screen.getByRole("link", { name: "Back to today" });
    expect(link.getAttribute("href")).toBe("/");
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Menu" })).toBeTruthy();
  });
});
