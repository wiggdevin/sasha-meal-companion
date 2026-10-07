import { describe, expect, it } from "vitest";
import { ID_BATCH, readByDateChunks, readByIdBatches, ROW_CAP } from "@/lib/server/date-chunks";

const DAY_MS = 86_400_000;
const dayOf = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/** A fake table: `perDay` rows on each date, and a cap that truncates like PostgREST. */
function table(perDay: (date: string) => number) {
  const calls: [string, string][] = [];
  const fetch = async (from: string, to: string) => {
    calls.push([from, to]);
    const rows: { date: string; n: number }[] = [];
    for (let d = dayOf(from); d <= dayOf(to); d += 1) {
      const date = new Date(d * DAY_MS).toISOString().slice(0, 10);
      for (let n = 0; n < perDay(date); n += 1) rows.push({ date, n });
    }
    return rows.slice(0, ROW_CAP);
  };
  return { fetch, calls };
}

describe("readByDateChunks", () => {
  it("reads five years of one row a day with nothing dropped and nothing twice", async () => {
    const { fetch } = table(() => 1);
    const rows = await readByDateChunks("2021-10-05", "2026-10-04", fetch);
    expect(rows).toHaveLength(dayOf("2026-10-04") - dayOf("2021-10-05") + 1);
    expect(new Set(rows.map((r) => r.date)).size).toBe(rows.length);
    expect(rows.at(-1)?.date).toBe("2026-10-04");
  });

  it("splits a window that comes back full instead of keeping a truncated page", async () => {
    const { fetch, calls } = table(() => 7);
    const rows = await readByDateChunks("2026-01-01", "2026-06-29", fetch);
    expect(rows).toHaveLength(180 * 7);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("refuses rather than truncates when one day alone fills a page", async () => {
    const { fetch } = table((date) => (date === "2026-03-01" ? ROW_CAP : 1));
    await expect(readByDateChunks("2026-02-01", "2026-03-31", fetch)).rejects.toThrow(/truncate/);
  });
});

describe("readByIdBatches", () => {
  it("reads every id once, in batches of at most ID_BATCH", async () => {
    const calls: number[] = [];
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i % 230}`);
    const rows = await readByIdBatches(ids, async (batch) => {
      calls.push(batch.length);
      return batch.map((id) => ({ id }));
    });
    expect(rows).toHaveLength(230);
    expect(calls).toEqual([ID_BATCH, ID_BATCH, 30]);
  });

  it("splits a batch that meets the row cap instead of truncating it", async () => {
    const calls: number[] = [];
    const rows = await readByIdBatches(["a", "b", "c", "d"], async (batch) => {
      calls.push(batch.length);
      const all = batch.flatMap((id) => Array.from({ length: 400 }, (_, n) => ({ id, n })));
      return all.slice(0, ROW_CAP);
    });
    expect(rows).toHaveLength(1600);
    expect(calls).toEqual([4, 2, 2]);
  });

  it("refuses a single id whose rows still fill the cap", async () => {
    await expect(readByIdBatches(["a"], async () => Array.from({ length: ROW_CAP }, () => ({}))))
      .rejects.toThrow(/refusing to truncate/);
  });
});
