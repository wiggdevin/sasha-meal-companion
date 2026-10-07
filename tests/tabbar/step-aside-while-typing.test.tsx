// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TabBar, { isTypingField } from "@/components/TabBar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(cleanup);

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

describe("the dock while the user types elsewhere", () => {
  it("steps aside for a page field and comes back when the field lets go", async () => {
    render(<><input aria-label="Ask for a meal idea" /><button type="button">Plain</button><TabBar /></>);
    act(() => screen.getByLabelText("Ask for a meal idea").focus());
    expect(document.body.dataset.typing).toBe("field");
    await act(async () => { screen.getByRole("button", { name: "Plain" }).focus(); await frame(); });
    expect(document.body.dataset.typing).toBeUndefined();
  });

  it("stays put while its own ask field is the one typing", () => {
    render(<TabBar />);
    act(() => screen.getByRole("searchbox", { name: /^Ask / }).focus());
    expect(document.body.dataset.typing).toBeUndefined();
  });

  it("counts only fields the keyboard types into", () => {
    const text = document.createElement("input");
    const box = document.createElement("input"); box.type = "checkbox";
    expect(isTypingField(text)).toBe(true);
    expect(isTypingField(box)).toBe(false);
    expect(isTypingField(document.createElement("textarea"))).toBe(true);
    expect(isTypingField(document.createElement("button"))).toBe(false);
  });
});
