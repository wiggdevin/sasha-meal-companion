// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";
import Disclosure, { DisclosurePanel } from "@/components/ui/Disclosure";

/** The one animated disclosure (KIT.md §Expanding; owner 2026-10-03: "smooth, transformative
 *  animations"): a real button with aria-expanded / aria-controls, a body that springs its height
 *  while its content fades and lifts, and an instant toggle under reduced motion. */
afterEach(cleanup);

const reduced = (node: ReactNode) => <MotionConfig reducedMotion="always">{node}</MotionConfig>;
const toggle = (name: string) => screen.getByRole("button", { name: new RegExp(name) });
const panelOf = (button: HTMLElement) => document.getElementById(button.getAttribute("aria-controls")!)!;

describe("Disclosure", () => {
  it("is a card whose header is a native button controlling a hidden, still-mounted body", () => {
    render(<Disclosure title="Other foods" aside="3 foods"><p>body</p></Disclosure>);
    const button = toggle("Other foods");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent).toContain("3 foods");
    expect(button.closest(".shell")).not.toBeNull();
    const panel = panelOf(button);
    expect(panel.hidden).toBe(true);
    expect(panel.textContent).toBe("body");
  });

  it("toggles open and closed on click (Enter and Space come with the native button)", () => {
    render(reduced(<Disclosure title="Advanced targets"><p>fields</p></Disclosure>));
    const button = toggle("Advanced targets");
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(panelOf(button).hidden).toBe(false);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("is instant under reduced motion: closing hides the body in the same commit", () => {
    render(reduced(<Disclosure title="T" defaultOpen><p>x</p></Disclosure>));
    const button = toggle("T");
    expect(panelOf(button).hidden).toBe(false);
    fireEvent.click(button);
    expect(panelOf(button).hidden).toBe(true);
  });

  it("with motion, keeps the body visible but inert while it folds, then hides it", async () => {
    render(<Disclosure title="T" defaultOpen><p>x</p></Disclosure>);
    const button = toggle("T");
    fireEvent.click(button);
    const panel = panelOf(button);
    expect(panel.hidden).toBe(false);
    expect(panel.hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(panel.hidden).toBe(true), { timeout: 3000 });
  });

  it("opens itself when find-in-page reveals a match inside it", () => {
    const onOpenChange = vi.fn();
    render(<Disclosure title="T" onOpenChange={onOpenChange}><p>needle</p></Disclosure>);
    const button = toggle("T");
    act(() => { panelOf(button).dispatchEvent(new Event("beforematch")); });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("hands the panel back to the spring after a find-in-page reveal, so the next close folds it", async () => {
    render(reduced(<Disclosure title="T"><p>needle</p></Disclosure>));
    const button = toggle("T");
    const panel = panelOf(button);
    const body = panel.firstElementChild as HTMLElement;
    act(() => { panel.dispatchEvent(new Event("beforematch")); });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(panel.hidden).toBe(true));
    expect(panel.style.height).toBe("0px");
    expect(body.style.opacity).toBe("0");
  });

  it("folds back a find-in-page reveal that a controlled owner keeps closed", async () => {
    render(reduced(<Disclosure title="T" open={false} onOpenChange={() => {}}><p>needle</p></Disclosure>));
    const panel = panelOf(toggle("T"));
    const body = panel.firstElementChild as HTMLElement;
    act(() => { panel.dispatchEvent(new Event("beforematch")); });
    expect(panel.style.height).toBe("auto");
    await waitFor(() => expect(panel.style.height).not.toBe("auto"));
    expect(body.style.opacity).not.toBe("1");
    expect(toggle("T").getAttribute("aria-expanded")).toBe("false");
  });

  it("can be controlled", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(reduced(<Disclosure title="T" open={false} onOpenChange={onOpenChange}>x</Disclosure>));
    fireEvent.click(toggle("T"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(toggle("T").getAttribute("aria-expanded")).toBe("false");
    rerender(reduced(<Disclosure title="T" open onOpenChange={onOpenChange}>x</Disclosure>));
    expect(toggle("T").getAttribute("aria-expanded")).toBe("true");
  });

  it("renders on the server: closed bodies hidden, defaultOpen shown", () => {
    const closed = renderToStaticMarkup(<Disclosure title="T"><p>body</p></Disclosure>);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toMatch(/hidden=""[^>]*>.*<p>body<\/p>/);
    expect(closed).toContain("disclosure-chevron");
    const open = renderToStaticMarkup(<Disclosure title="T" defaultOpen>x</Disclosure>);
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toMatch(/ hidden=/);
  });

  it("row variant draws an optional hairline and keeps the 44 px floor at the small size", () => {
    render(<Disclosure variant="row" size="sm" divider title="Preparation" aside="10 min">x</Disclosure>);
    const button = toggle("Preparation");
    expect(button.className).toContain("min-h-11");
    expect(button.parentElement?.className).toContain("border-hairline");
  });
});

describe("DisclosurePanel without keepMounted", () => {
  it("mounts its content on open and unmounts it once folded", async () => {
    const { rerender } = render(reduced(<DisclosurePanel id="p" open={false} keepMounted={false}>inside</DisclosurePanel>));
    expect(screen.queryByText("inside")).toBeNull();
    rerender(reduced(<DisclosurePanel id="p" open keepMounted={false}>inside</DisclosurePanel>));
    expect(screen.getByText("inside")).toBeTruthy();
    rerender(reduced(<DisclosurePanel id="p" open={false} keepMounted={false}>inside</DisclosurePanel>));
    await waitFor(() => expect(screen.queryByText("inside")).toBeNull());
  });
});
