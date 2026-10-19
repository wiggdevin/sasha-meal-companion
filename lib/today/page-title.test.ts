import { describe, expect, it } from "vitest";
import { todayPageTitle } from "@/lib/today/page-title";

describe("todayPageTitle", () => {
  it("says Today with the short date over it", () => {
    const { title, eyebrow } = todayPageTitle("2026-10-19", "2026-10-19");
    expect(title).toBe("Today");
    expect(eyebrow).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}/);
  });

  it("names another day by its weekday, with Yesterday or Tomorrow over it", () => {
    const yesterday = todayPageTitle("2026-10-18", "2026-10-19");
    expect(yesterday.title).toBe(new Date("2026-10-18T12:00:00").toLocaleDateString(undefined, { weekday: "long" }));
    expect(yesterday.eyebrow).toMatch(/^Yesterday · /);
    expect(todayPageTitle("2026-10-20", "2026-10-19").eyebrow).toMatch(/^Tomorrow · /);
    expect(todayPageTitle("2026-10-01", "2026-10-19").eyebrow).not.toMatch(/·/);
  });
});
