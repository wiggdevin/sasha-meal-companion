/** Round 8: the coach's get_plan / get_entries tools carry the "not fully checked" caveat. */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/day-context", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/server/day-context")>(),
  buildDayContext: vi.fn(async (_admin: unknown, _user: string, date: string) => ({
    date, dayType: "rest", targets: null, slots: [], consumed: { kcal: 0, protein: 0, carbs: 0, fat: 0 },
    remaining: null, stillToEat: "Targets are not set.", consumedPartial: false,
    nutritionUnchecked: true,
    entries: [{ entryId: "e1", at: "12:00", slot: "snack", name: "Item", items: [], macros: "0 kcal" }],
  })),
}));

const { defaultPorts } = await import("@/lib/server/coach-ports");

describe("coach day tools when the partial check could not run", () => {
  const ports = defaultPorts({} as never, {} as never, () => "id", { tz: "UTC", date: "2026-10-01" });

  it("get_plan says nutrition_unchecked", async () => {
    expect(await ports.dayPlan("u1", "2026-09-30")).toMatchObject({ nutrition_unchecked: true });
  });

  it("get_entries marks each entry, keeping the array shape", async () => {
    expect(await ports.dayEntries("u1", "2026-09-30")).toEqual([
      expect.objectContaining({ entryId: "e1", nutrition_unchecked: true })]);
  });
});
