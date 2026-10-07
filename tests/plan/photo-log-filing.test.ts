import { describe, expect, it } from "vitest";
import { filing } from "@/lib/plan/photo-log";

const NOW = new Date("2026-10-03T18:00:00");

describe("where a Plan panel log is filed", () => {
  it("logs now on today's panel", () => {
    const at = filing({ date: "2026-10-03", time: "07:30" }, NOW);
    expect(at.localDate).toBe("2026-10-03");
    expect(at.eatenAt).toBe(NOW);
  });

  it("files a past day's log on that day at the slot's time", () => {
    const at = filing({ date: "2026-09-23", time: "16:30" }, NOW);
    expect(at.localDate).toBe("2026-09-23");
    expect(at.eatenAt.getTime()).toBe(new Date("2026-09-23T16:30:00").getTime());
  });

  it("never files a log in the future", () => {
    expect(filing({ date: "2026-10-05", time: "12:00" }, NOW).eatenAt).toBe(NOW);
  });

  it("uses midday when the slot time is malformed", () => {
    expect(filing({ date: "2026-09-23", time: "late" }, NOW).eatenAt.getHours()).toBe(12);
  });
});
