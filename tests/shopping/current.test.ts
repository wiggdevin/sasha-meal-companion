import { describe, expect, it } from "vitest";
import { compareLists, currentShoppingPeriod } from "@/lib/shopping/current";

const list = (id: string, startDate: string, endDate: string, updatedAt?: string) =>
  ({ id, startDate, endDate, updatedAt });

describe("the one current-list rule", () => {
  it("picks, among lists covering today, the latest start, then the most recently updated", () => {
    const lists = [
      list("wide", "2026-10-01", "2026-10-31", "2026-10-02T00:00:00Z"),
      list("week-old", "2026-10-15", "2026-10-21", "2026-10-15T00:00:00Z"),
      list("week-new", "2026-10-15", "2026-10-21", "2026-10-16T00:00:00Z"),
      list("future", "2026-10-25", "2026-10-31", "2026-10-20T00:00:00Z"),
    ];
    expect(currentShoppingPeriod(lists, "2026-10-19")?.id).toBe("week-new");
  });

  it("answers null when no list covers today", () => {
    expect(currentShoppingPeriod([list("past", "2026-09-01", "2026-09-07")], "2026-10-19")).toBeNull();
    expect(currentShoppingPeriod([], "2026-10-19")).toBeNull();
  });

  it("sorts a list with no update time after one that has it", () => {
    expect(compareLists(list("a", "2026-10-15", "2026-10-21"),
      list("b", "2026-10-15", "2026-10-21", "2026-10-16T00:00:00Z"))).toBe(1);
  });
});
