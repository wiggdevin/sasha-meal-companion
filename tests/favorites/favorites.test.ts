import { describe, expect, it } from "vitest";
import { mergeFavorites, nextSort, pinnedAndRest, type FavoriteRow } from "@/lib/favorites";

const row = (key: string, sort: number, clientTs: string) => ({ key, sort, clientTs });

describe("favorites", () => {
  it("puts the next favorite after the last one", () => {
    expect(nextSort([{ sort: 1 }, { sort: 7 }])).toBe(8);
    expect(nextSort([])).toBe(1);
  });

  it("unions two offline devices and lets the newer client_ts set the sort", () => {
    const merged = mergeFavorites(
      [row("food:a", 1, "2026-09-19T12:00:00.000Z"), row("food:b", 2, "2026-09-19T09:00:00.000Z")],
      [row("food:c", 1, "2026-09-19T10:00:00.000Z"), row("food:b", 5, "2026-09-19T11:00:00.000Z")],
    );
    expect(merged.map((f) => f.key)).toEqual(["food:a", "food:c", "food:b"]);
    expect(merged.find((f) => f.key === "food:b")?.sort).toBe(5);
  });

  it("pins the first twelve and hides the rest behind All", () => {
    const rows: FavoriteRow[] = Array.from({ length: 14 }, (_, i) =>
      ({ kind: "food", id: `f${i}`, name: `Food ${i}`, sort: i }));
    const { pinned, rest } = pinnedAndRest(rows);
    expect([pinned.length, rest.length]).toEqual([12, 2]);
    expect(rest[0].id).toBe("f12");
  });
});
