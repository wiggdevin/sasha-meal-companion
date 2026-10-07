/**
 * Phase 13 slice 4 (sol BLOCK, p13-s4 review): mergeAccountProfileInstance writes one account's
 * profile row under optimistic concurrency on its `rev`, so two confirm taps racing each other
 * cannot drop one another — a lost race re-reads the row and merges again.
 */
import { describe, expect, it, vi } from "vitest";
import { mergeAccountProfileInstance } from "@/lib/server/dietary-profiles";

type Result = { data: unknown; error: { code?: string } | null };

function fakeClient(script: { reads: Result[]; writes: Result[] }) {
  const calls: { op: string; row?: unknown; filters: [string, unknown][] }[] = [];
  const client = {
    from: () => {
      const call = { op: "select", row: undefined as unknown, filters: [] as [string, unknown][] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (column: string, value: unknown) => { call.filters.push([column, value]); return chain; },
        insert: (row: unknown) => { call.op = "insert"; call.row = row; return chain; },
        update: (row: unknown) => { call.op = "update"; call.row = row; return chain; },
        maybeSingle: async () => (call.op === "select" ? script.reads : script.writes).shift()
          ?? { data: null, error: null },
      });
      return chain;
    },
  };
  return { client: client as never, calls };
}

const row = (rev: number, facets: string[]) => ({
  profile_id: "pregnancy", source: "user_stated", confirmed_at: "2026-09-24T00:00:00.000Z",
  rules: facets.map((facet) => ({ facet, confirmation: "confirmed" })), options: {}, notes: null,
  rev,
});
const input = { profileId: "pregnancy", source: "user_stated" as const,
  confirmedAt: "2026-09-25T00:00:00.000Z", rules: [], options: {} };

describe("mergeAccountProfileInstance", () => {
  it("inserts the first row, building from no stored state", async () => {
    const { client, calls } = fakeClient({ reads: [{ data: null, error: null }],
      writes: [{ data: row(1, []), error: null }] });
    const build = vi.fn((stored: unknown) => { void stored; return input; });
    await mergeAccountProfileInstance(client, "u1", "pregnancy", build);
    expect(build).toHaveBeenCalledWith(null);
    expect(calls.map((call) => call.op)).toEqual(["select", "insert"]);
    expect(calls[1].row).toMatchObject({ user_id: "u1", profile_id: "pregnancy", rev: 1 });
  });

  it("updates only while the row is still at the rev it read, bumping it", async () => {
    const { client, calls } = fakeClient({ reads: [{ data: row(3, ["alcohol"]), error: null }],
      writes: [{ data: row(4, ["alcohol"]), error: null }] });
    await mergeAccountProfileInstance(client, "u1", "pregnancy", () => input);
    expect(calls[1].op).toBe("update");
    expect(calls[1].filters).toEqual(expect.arrayContaining([
      ["user_id", "u1"], ["profile_id", "pregnancy"], ["rev", 3],
    ]));
    expect(calls[1].row).toMatchObject({ rev: 4 });
  });

  it("re-reads and merges again after losing a race (update matched no row)", async () => {
    const { client } = fakeClient({
      reads: [{ data: row(3, ["alcohol"]), error: null },
        { data: row(4, ["alcohol", "unpasteurized"]), error: null }],
      writes: [{ data: null, error: null }, { data: row(5, []), error: null }],
    });
    const build = vi.fn((stored: unknown) => { void stored; return input; });
    await mergeAccountProfileInstance(client, "u1", "pregnancy", build);
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[1][0]).toMatchObject({ rules: [
      { facet: "alcohol" }, { facet: "unpasteurized" },
    ] });
  });

  it("re-reads after a concurrent first insert (unique violation)", async () => {
    const { client, calls } = fakeClient({
      reads: [{ data: null, error: null }, { data: row(1, ["alcohol"]), error: null }],
      writes: [{ data: null, error: { code: "23505" } }, { data: row(2, []), error: null }],
    });
    await mergeAccountProfileInstance(client, "u1", "pregnancy", () => input);
    expect(calls.map((call) => call.op)).toEqual(["select", "insert", "select", "update"]);
  });

  it("gives up with a 409 rather than overwriting when every attempt loses", async () => {
    const lost = { data: null, error: null };
    const { client } = fakeClient({
      reads: [0, 1, 2].map(() => ({ data: row(3, []), error: null })), writes: [lost, lost, lost],
    });
    await expect(mergeAccountProfileInstance(client, "u1", "pregnancy", () => input))
      .rejects.toMatchObject({ status: 409 });
  });
});
