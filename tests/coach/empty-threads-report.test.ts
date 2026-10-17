/** W088: the read-only report of coach threads that hold no message (scripts/coach-empty-threads.ts). */
import { describe, expect, it } from "vitest";
import { emptyThreads, parseArgs, reportLines, type ThreadRow } from "@/scripts/coach-empty-threads";

const thread = (id: string): ThreadRow => ({ id, user_id: "u1", kind: "chat", created_at: "2026-10-01T00:00:00Z" });

describe("coach-empty-threads", () => {
  it("lists only the threads that hold no message, in order", async () => {
    const asked: string[] = [];
    const rows = await emptyThreads({
      threads: async (before) => { asked.push(before); return ["a", "b", "c"].map(thread); },
      hasMessage: async (id) => id === "b",
    }, "2026-10-16T00:00:00Z");
    expect(rows.map((row) => row.id)).toEqual(["a", "c"]);
    expect(asked).toEqual(["2026-10-16T00:00:00Z"]);
  });

  it("prints no account id, only a truncated hash, then the total", () => {
    const lines = reportLines([thread("a")]);
    expect(lines[0]).toMatch(/^a\t[0-9a-f]{12}\tchat\t2026-10-01T00:00:00Z$/);
    expect(lines.join("\n")).not.toContain("u1");
    expect(lines.at(-1)).toBe("1 empty thread");
  });

  it("takes only its two read-only flags", () => {
    expect(parseArgs([])).toEqual({ olderThanDays: 1, production: false });
    expect(parseArgs(["--older-than-days", "7", "--production"])).toEqual({ olderThanDays: 7, production: true });
    expect(() => parseArgs(["--fix"])).toThrow(/read-only/);
    expect(() => parseArgs(["--older-than-days", "0"])).toThrow();
  });
});
