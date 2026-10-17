// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

const focus = vi.hoisted(() => ({ held: null as { until: string; keys: [] } | null, write: vi.fn(), undo: vi.fn() }));
class Superseded extends Error {}
vi.mock("@/lib/shopping/focus-client", () => ({
  heldShoppingFocus: () => focus.held,
  refreshShoppingFocus: async () => {},
  writeShoppingFocus: (...a: unknown[]) => focus.write(...a),
  undoShoppingFocusWrite: (...a: unknown[]) => focus.undo(...a),
  ShoppingFocusSuperseded: Superseded,
}));

const { default: ShoppingFocusToggle, focusEndLabel } = await import("./ShoppingFocusToggle");
const UNTIL = "2026-10-24T12:00:00.000Z";

beforeEach(() => {
  unbindAccount(); markAccountReady(bindAccount(TEST_USER));
  focus.held = null; focus.write.mockReset(); focus.undo.mockReset();
});
afterEach(cleanup);

describe("Shopping › Use my list", () => {
  it("turns on, shows the end date and offers Undo", async () => {
    focus.write.mockImplementation(async () => { focus.held = { until: UNTIL, keys: [] };
      return { actionId: "a1", until: UNTIL, previous: null }; });
    render(<ShoppingFocusToggle />);
    fireEvent.click(screen.getByRole("switch", { name: "Use my list" }));
    expect(await screen.findByText(new RegExp(`until ${focusEndLabel(UNTIL)}`))).toBeTruthy();
    expect(focus.write).toHaveBeenCalledWith(expect.anything(), true);
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("turns off from an existing focus", async () => {
    focus.held = { until: UNTIL, keys: [] };
    focus.write.mockImplementation(async () => { focus.held = null; return { actionId: "a2", until: null, previous: UNTIL }; });
    render(<ShoppingFocusToggle />);
    fireEvent.click(screen.getByRole("switch", { name: "Use my list" }));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
    expect(focus.write).toHaveBeenCalledWith(expect.anything(), false);
  });

  it("undo restores the held state", async () => {
    focus.write.mockImplementation(async () => { focus.held = { until: UNTIL, keys: [] };
      return { actionId: "a1", until: UNTIL, previous: null }; });
    focus.undo.mockImplementation(async () => { focus.held = null; });
    render(<ShoppingFocusToggle />);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false"));
    expect(focus.undo).toHaveBeenCalledWith(expect.anything(), "a1");
  });

  it("says so when a later choice superseded the Undo", async () => {
    focus.write.mockResolvedValue({ actionId: "a1", until: UNTIL, previous: null });
    focus.undo.mockRejectedValue(new Superseded());
    render(<ShoppingFocusToggle />);
    fireEvent.click(screen.getByRole("switch"));
    await act(async () => {});
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText(/newer choice is already in place/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("shows an error when the write fails", async () => {
    focus.write.mockRejectedValue(new Error("x"));
    render(<ShoppingFocusToggle />);
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByText("That did not save. Try again.")).toBeTruthy();
  });
});
