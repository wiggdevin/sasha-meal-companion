import { describe, expect, it } from "vitest";
import {
  filterThreads, fuzzyScore, groupOf, groupThreads, relativeTime, titleOf,
} from "@/components/coach/conversations/list";

const NOW = new Date(2026, 9, 4, 18, 0); // Sun 4 Oct 2026, 18:00 local
const at = (days: number, hours = 0) => new Date(2026, 9, 4 - days, 18 - hours, 0).toISOString();
const thread = (id: string, title: string | null, lastMessageAt: string | null) =>
  ({ id, title, kind: "chat", lastMessageAt });

describe("grouping and times", () => {
  it("groups by the local day the chat was last active", () => {
    expect(groupOf(thread("a", "x", at(0, 3)), NOW)).toBe("Today");
    expect(groupOf(thread("b", "x", at(1)), NOW)).toBe("This week");
    expect(groupOf(thread("c", "x", at(6)), NOW)).toBe("This week");
    expect(groupOf(thread("d", "x", at(7)), NOW)).toBe("Earlier");
    expect(groupOf(thread("e", "x", null), NOW)).toBe("No messages yet");
  });

  it("says how long ago in short words", () => {
    expect(relativeTime(thread("a", "x", new Date(NOW.getTime() - 20_000).toISOString()), NOW)).toBe("Now");
    expect(relativeTime(thread("a", "x", new Date(NOW.getTime() - 12 * 60_000).toISOString()), NOW)).toBe("12 min");
    expect(relativeTime(thread("a", "x", at(0, 3)), NOW)).toBe("3 h");
    expect(relativeTime(thread("a", "x", at(1)), NOW)).toBe("Yesterday");
    expect(relativeTime(thread("a", "x", null), NOW)).toBe("");
    expect(relativeTime(thread("a", "x", at(20)), NOW)).toMatch(/14/);
  });

  it("keeps the given order inside each group and drops empty groups", () => {
    const rows = [thread("a", "A", at(0)), thread("b", "B", at(9)), thread("c", "C", at(0, 1)), thread("d", "D", null)];
    expect(groupThreads(rows, NOW).map((section) => [section.group, section.threads.map((t) => t.id)]))
      .toEqual([["Today", ["a", "c"]], ["Earlier", ["b"]], ["No messages yet", ["d"]]]);
  });

  it("names an untitled chat", () => {
    expect(titleOf({ title: "  " })).toBe("Untitled chat");
  });
  it("counts calendar days across a daylight-saving change", () => {
    // US clocks spring forward on Sun 8 Mar 2026, so that week is an hour short. A floored day
    // count read the chat seven calendar days back as six, filing it under "This week".
    const savedTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const now = new Date(2026, 2, 12, 18, 0); // Thu 12 Mar 2026, 18:00 local
      // Prove the zone took effect (it does not in thread pools): EST before, EDT after.
      expect(new Date(2026, 2, 5).getTimezoneOffset()).toBe(300);
      expect(now.getTimezoneOffset()).toBe(240);
      const sevenBack = new Date(2026, 2, 5, 18, 0).toISOString(); // Thu 5 Mar, before the change
      const sixBack = new Date(2026, 2, 6, 18, 0).toISOString();
      expect(groupOf(thread("a", "x", sevenBack), now)).toBe("Earlier");
      expect(groupOf(thread("b", "x", sixBack), now)).toBe("This week");
      expect(relativeTime(thread("c", "x", new Date(2026, 2, 11, 9, 0).toISOString()), now)).toBe("Yesterday");
      // Fall back on Sun 1 Nov 2026: that week is an hour long.
      const autumn = new Date(2026, 10, 5, 18, 0);
      expect(groupOf(thread("d", "x", new Date(2026, 9, 29, 18, 0).toISOString()), autumn)).toBe("Earlier");
      expect(groupOf(thread("e", "x", new Date(2026, 9, 30, 18, 0).toISOString()), autumn)).toBe("This week");
      expect(relativeTime(thread("f", "x", new Date(2026, 10, 1, 0, 30).toISOString()), new Date(2026, 10, 2, 0, 15))).toBe("Yesterday");
    } finally {
      if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
    }
  });
});

describe("title search", () => {
  it("matches words anywhere, accents and case aside, and forgives a missing letter", () => {
    expect(fuzzyScore("dinner", "What should I eat for dinner")).toBe(3);
    expect(fuzzyScore("inner", "What should I eat for dinner")).toBe(2);
    expect(fuzzyScore("chiken", "Chicken and rice")).toBe(1);
    expect(fuzzyScore("CREME", "Crème brûlée ideas")).toBe(3);
    expect(fuzzyScore("salmon", "Chicken and rice")).toBeNull();
    // Letters scattered across a long title are not a match.
    expect(fuzzyScore("dinner", "Hi what should I replace for my lunch today? I'm getting sick of it")).toBeNull();
    expect(fuzzyScore("dinner rice", "Dinner with rice")).toBe(6);
  });

  it("orders the best matches first and keeps recency among equals", () => {
    const rows = [thread("1", "Lunch swaps", null), thread("2", "Snack for lunch", null), thread("3", "Lunchbox", null)];
    expect(filterThreads(rows, "lunch").map((t) => t.id)).toEqual(["1", "2", "3"]);
    expect(filterThreads(rows, "box").map((t) => t.id)).toEqual(["3"]);
    expect(filterThreads(rows, "  ").map((t) => t.id)).toEqual(["1", "2", "3"]);
  });
});
