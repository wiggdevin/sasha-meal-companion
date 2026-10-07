// @vitest-environment jsdom
/**
 * Grok verify, 2026-10-05: "Type it from the label" saves the food and logs a serving through the
 * durable commit. Two taps before the sheet closes must add (and log) it once.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { __resetScrollLockForTests } from "@/lib/dom/scroll-lock";
import { TEST_USER } from "@/tests/helpers/account";

const { default: AddFoodSheet } = await import("@/components/AddFoodSheet");

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });
afterEach(() => { cleanup(); __resetScrollLockForTests(); vi.restoreAllMocks(); });

function fill() {
  fireEvent.change(screen.getByLabelText("Food name"), { target: { value: "Protein bar" } });
  fireEvent.change(screen.getByLabelText("Protein g"), { target: { value: "20" } });
}

it("adds a typed label food once however fast it is tapped", () => {
  const onAdd = vi.fn();
  render(<AddFoodSheet existing={{}} startCustom onAdd={onAdd} onClose={() => undefined} />);
  fill();
  const add = screen.getByRole("button", { name: "Add to my foods" });
  fireEvent.click(add);
  fireEvent.click(add);
  expect(onAdd).toHaveBeenCalledTimes(1);
});

it("adds again once the form changes", () => {
  const onAdd = vi.fn();
  render(<AddFoodSheet existing={{}} startCustom onAdd={onAdd} onClose={() => undefined} />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Add to my foods" }));
  fireEvent.change(screen.getByLabelText("Food name"), { target: { value: "Protein bar, chocolate" } });
  fireEvent.click(screen.getByRole("button", { name: "Add to my foods" }));
  expect(onAdd).toHaveBeenCalledTimes(2);
});

it("keeps the typed draft open after a refused label log, says why, and lets it be sent again", async () => {
  const onAdd = vi.fn()
    .mockResolvedValueOnce("The server would not take that one. Try again.")
    .mockResolvedValueOnce(undefined);
  render(<AddFoodSheet existing={{}} startCustom onAdd={onAdd} onClose={() => undefined} />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Add to my foods" }));
  await screen.findByText("The server would not take that one. Try again.");
  // The draft is still there, unchanged, and the same tap sends it again.
  expect((screen.getByLabelText("Food name") as HTMLInputElement).value).toBe("Protein bar");
  fireEvent.click(screen.getByRole("button", { name: "Add to my foods" }));
  await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
  expect(onAdd.mock.calls[1][0]).toMatchObject({ name: "Protein bar" });
  await waitFor(() => expect(screen.queryByText("The server would not take that one. Try again.")).toBeNull());
});

it("blocks a second tap while the label log is still in flight", async () => {
  let answer: (refusal: string | void) => void = () => undefined;
  const onAdd = vi.fn(() => new Promise<string | void>((resolve) => { answer = resolve; }));
  render(<AddFoodSheet existing={{}} startCustom onAdd={onAdd} onClose={() => undefined} />);
  fill();
  const add = screen.getByRole("button", { name: "Add to my foods" });
  fireEvent.click(add);
  fireEvent.click(add);
  await act(async () => { answer(undefined); });
  fireEvent.click(add);
  expect(onAdd).toHaveBeenCalledTimes(1);
});
