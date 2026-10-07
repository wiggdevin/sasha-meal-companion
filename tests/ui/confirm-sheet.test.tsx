// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ConfirmSheet from "@/components/ui/ConfirmSheet";

/** The shared confirmation step (owner, 2026-10-05: "reset to your plan" needs a confirmation). */
afterEach(cleanup);

describe("ConfirmSheet", () => {
  it("destructive: names the action, confirms once, and Cancel changes nothing", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmSheet title="Reset to your plan?" confirmLabel="Reset targets" destructive
      onConfirm={onConfirm} onCancel={onCancel}>Your own numbers are removed.</ConfirmSheet>);
    expect(screen.getByRole("dialog", { name: "Reset to your plan?" })).toBeTruthy();
    expect(screen.getByText("Your own numbers are removed.")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Reset targets" });
    expect(confirm.className).toContain("btn-danger");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("plain: the confirm button is the primary one", () => {
    render(<ConfirmSheet title="Start over?" confirmLabel="Start over"
      onConfirm={() => {}} onCancel={() => {}}>Your draft is cleared.</ConfirmSheet>);
    expect(screen.getByRole("button", { name: "Start over" }).className).toContain("btn-primary");
  });
});
