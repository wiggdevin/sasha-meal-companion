import { describe, expect, it } from "vitest";
import { compactRange, cycleOrder, listName, newListDates, newListProblem, progressLine, stepList } from "@/lib/shopping/saved-lists";

const row = (id: string, startDate: string, updatedAt = "2026-10-01T00:00:00Z") =>
  ({ id, startDate, endDate: startDate, updatedAt, title: null });

describe("saved list names and dates", () => {
  it("shows a title, else a dated name that is never stored", () => {
    expect(listName({ title: " Weekly shop ", startDate: "2026-10-20", endDate: "2026-10-26" })).toBe("Weekly shop");
    expect(listName({ title: null, startDate: "2026-10-20", endDate: "2026-10-26" })).toBe("List for 20–26 Oct");
    expect(compactRange("2026-10-28", "2026-11-03")).toMatch(/^28 Oct – 3 Nov$/);
  });

  it("starts a new list this week, next week or on custom dates", () => {
    expect(newListDates("this_week", "2026-10-19")).toEqual({ startDate: "2026-10-19", endDate: "2026-10-25" });
    expect(newListDates("next_week", "2026-10-19")).toEqual({ startDate: "2026-10-26", endDate: "2026-11-01" });
    expect(newListDates("custom", "2026-10-19", { startDate: "2026-11-01", endDate: "2026-11-02" }))
      .toEqual({ startDate: "2026-11-01", endDate: "2026-11-02" });
  });

  it("counts items and the cart", () => {
    expect(progressLine(0, 0)).toBe("No items yet");
    expect(progressLine(12, 3)).toBe("12 items · 3 in cart");
  });
});

describe("cycling saved lists", () => {
  const lists = [row("old", "2026-09-01"), row("new", "2026-10-20"), row("mid", "2026-10-01")];
  it("walks newest first and stops at either end", () => {
    expect(cycleOrder(lists).map((item) => item.id)).toEqual(["new", "mid", "old"]);
    expect(stepList(lists, "new", 1)?.id).toBe("mid");
    expect(stepList(lists, "mid", -1)?.id).toBe("new");
    expect(stepList(lists, "new", -1)).toBeNull();
    expect(stepList(lists, "old", 1)).toBeNull();
    expect(stepList(lists, null, 1)?.id).toBe("new");
    expect(stepList([], null, 1)).toBeNull();
  });
});

describe("new list dates", () => {
  it("takes up to 366 days, the database's limit, and names what is wrong", () => {
    expect(newListProblem({ startDate: "2026-10-20", endDate: "2027-10-21" })).toBeNull();
    expect(newListProblem({ startDate: "2026-10-20", endDate: "2027-10-22" })).toBe("A list can cover a year at most.");
    expect(newListProblem({ startDate: "2026-10-20", endDate: "2026-10-19" })).toBe("Through must be on or after From.");
    expect(newListProblem({ startDate: "", endDate: "2026-10-19" })).toBe("Pick both dates.");
  });
});
