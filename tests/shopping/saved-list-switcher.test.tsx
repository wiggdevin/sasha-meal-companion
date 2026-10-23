// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SavedListSwitcher from "@/components/shopping/SavedListSwitcher";
import SavedListsSheet from "@/components/shopping/SavedListsSheet";

afterEach(cleanup);

const lists = [
  { id: "a", title: "Weekly shop", startDate: "2026-10-20", endDate: "2026-10-26", updatedAt: "2026-10-19T00:00:00Z" },
  { id: "b", title: null, startDate: "2026-10-13", endDate: "2026-10-19", updatedAt: "2026-10-12T00:00:00Z" },
];

describe("SavedListSwitcher", () => {
  it("names the open list with its dates and progress, and steps with 44 px arrows", () => {
    const onStep = vi.fn();
    render(<SavedListSwitcher period={lists[0]} count={2} itemCount={12} checkedCount={3}
      hasNewer={false} hasOlder onStep={onStep} onOpenLists={vi.fn()} />);
    expect(screen.getByText("Weekly shop")).toBeTruthy();
    expect(screen.getByText("20–26 Oct · 12 items · 3 in cart")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Newer list" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Older list" }));
    expect(onStep).toHaveBeenCalledWith(1);
    expect(screen.getByRole("button", { name: "Older list" }).className).toContain("h-11");
  });
});

describe("SavedListsSheet", () => {
  const sheet = (over: Partial<Parameters<typeof SavedListsSheet>[0]> = {}) => render(<SavedListsSheet
    periods={lists} currentId="a" today="2026-10-19" onClose={vi.fn()} onOpen={vi.fn()}
    onCreate={vi.fn(async () => {})} onRename={vi.fn(async () => {})} onDelete={vi.fn()} {...over} />);

  it("starts a new named list on next week's dates", async () => {
    const onCreate = vi.fn(async () => {});
    sheet({ onCreate });
    fireEvent.click(screen.getByRole("button", { name: "New list" }));
    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "  Party  " } });
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    fireEvent.click(screen.getByRole("button", { name: "Start list" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Party",
      { startDate: "2026-10-26", endDate: "2026-11-01" }));
  });

  it("renames a list, and an emptied name clears it", async () => {
    const onRename = vi.fn(async () => {});
    sheet({ onRename });
    fireEvent.click(screen.getByRole("button", { name: "Rename Weekly shop" }));
    fireEvent.change(screen.getByLabelText("List name"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("a", null));
  });

  it("confirms before deleting, saying planned meals stay", () => {
    const onDelete = vi.fn();
    sheet({ onDelete });
    fireEvent.click(screen.getByRole("button", { name: "Delete List for 13–19 Oct" }));
    expect(screen.getByText("Meals you already planned stay on Today.")).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete list" }));
    expect(onDelete).toHaveBeenCalledWith("b");
  });
});
