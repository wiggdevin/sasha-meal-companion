// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const motion = vi.hoisted(() => ({ reduce: false }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduce,
}));

import Notice, { noticeRole, type NoticeTone } from "@/components/ui/Notice";

afterEach(() => { cleanup(); motion.reduce = false; });

describe("Notice", () => {
  it.each<[NoticeTone, "alert" | "status"]>([
    ["info", "status"], ["attention", "status"], ["error", "alert"], ["success", "status"], ["neutral", "status"],
  ])("%s is a %s with its tone on the card", (tone, role) => {
    render(<Notice tone={tone} title="Something happened" />);
    const card = screen.getByRole(role);
    expect(noticeRole(tone)).toBe(role);
    expect(card.getAttribute("data-tone")).toBe(tone);
    expect(card.className).toContain("notice");
    expect(card.textContent).toBe("Something happened");
  });

  it("marks a neutral notice with a calm dot, never a minus that reads as remove", () => {
    render(<Notice tone="neutral" title="No chats yet" />);
    const mark = screen.getByRole("status").querySelector(".notice-mark svg")!;
    expect(mark.getAttribute("data-notice-mark")).toBe("dot");
    expect(mark.querySelector("path")).toBeNull();
  });

  it("shows a title and a body, its glyph hidden from assistive tech", () => {
    const { container } = render(<Notice tone="attention" title="Some foods are hidden">Check their labels.</Notice>);
    expect(screen.getByText("Some foods are hidden").className).toContain("notice-title");
    expect(screen.getByText("Check their labels.")).toBeTruthy();
    expect(container.querySelector(".notice-mark svg")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("runs its action and can be dismissed", () => {
    const retry = vi.fn();
    const dismiss = vi.fn();
    render(<Notice tone="error" title="Couldn’t get meal ideas." action={{ label: "Try again", onClick: retry }}
      onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert").textContent).toBe("Couldn’t get meal ideas.Try again");
  });

  it("disables its action while busy", () => {
    render(<Notice tone="error" title="Failed" action={{ label: "Try again", onClick: vi.fn(), disabled: true }} />);
    expect(screen.getByRole("button", { name: "Try again" })).toHaveProperty("disabled", true);
  });

  it("uses class recipes only: no inline colour and no hex", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(`${process.cwd()}/components/ui/Notice.tsx`, "utf8");
    expect(source).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
    expect(source).not.toMatch(/style=\{/);
  });

  it("arrives at once under reduced motion", () => {
    motion.reduce = true;
    render(<Notice tone="info" title="Still saving this meal…" />);
    expect(screen.getByRole("status").getAttribute("style") ?? "").not.toMatch(/opacity: 0/);
  });
});
