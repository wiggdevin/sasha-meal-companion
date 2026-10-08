import { describe, expect, it } from "vitest";
import { localDateFor } from "@/lib/log/contract";
import { viewedLogAt } from "@/lib/log/viewed-at";

describe("viewedLogAt (UI audit 2026-10-07)", () => {
  it("is now (undefined) on today and before the day is known", () => {
    expect(viewedLogAt("2026-10-07", "2026-10-07", "08:30")).toBeUndefined();
    expect(viewedLogAt("", "2026-10-07", "08:30")).toBeUndefined();
  });

  it("files a past day's log on that day, at the slot's own time in the phone's zone", () => {
    const at = viewedLogAt("2026-10-05", "2026-10-07", "08:30")!;
    expect(at.getFullYear()).toBe(2026);
    expect([at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()]).toEqual([9, 5, 8, 30]);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(localDateFor(at.toISOString(), zone)).toBe("2026-10-05");
  });

  it("uses midday when the slot has no readable time", () => {
    expect(viewedLogAt("2026-10-05", "2026-10-07")!.getHours()).toBe(12);
    expect(viewedLogAt("2026-10-05", "2026-10-07", "late")!.getHours()).toBe(12);
  });
});
