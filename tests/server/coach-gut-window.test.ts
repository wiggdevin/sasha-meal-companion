/**
 * Audit A109: the coach's "last N days" of gut notes steps back from the phone's own day (the
 * turn's zone), not from the server's UTC date. gut_log.local_date is the phone's day.
 */
import { describe, expect, it } from "vitest";
import { defaultPorts } from "@/lib/server/coach-ports";

function client(timeZone: string | null) {
  const gte: string[] = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain, eq: () => chain, is: () => chain, order: () => chain,
      gte: (_column: string, value: string) => { gte.push(value); return chain; },
      maybeSingle: async () => ({ data: table === "user_settings" ? { time_zone: timeZone } : null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
    });
    return chain;
  };
  return { gte, db: { from, rpc: async () => ({ data: null, error: null }) } as never };
}

describe("recent gut notes window", () => {
  // 03:00 UTC on Oct 11 is still Oct 10 in Denver.
  const now = "2026-10-11T03:00:00.000Z";

  it("counts back from the day the turn's zone is on, even when the stored zone differs", async () => {
    const { gte, db } = client("Pacific/Auckland");
    await defaultPorts(db, db, () => "id", { tz: "America/Denver", date: "2026-10-10", now })
      .recentGut("u1", 7);
    expect(gte).toEqual(["2026-10-03"]);
  });

  it("never uses the server's UTC date", async () => {
    const { gte, db } = client(null);
    await defaultPorts(db, db, () => "id", { tz: "America/Denver", date: "2026-10-10", now })
      .recentGut("u1", 1);
    expect(gte).toEqual(["2026-10-09"]);
  });
});
