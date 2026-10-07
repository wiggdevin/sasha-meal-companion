import { describe, expect, it, vi } from "vitest";
import { latestWins } from "@/lib/today/latest-wins";

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

describe("latestWins", () => {
  it("writes the first value, then only the newest of those asked for meanwhile", async () => {
    const first = gate();
    const write = vi.fn((value: number) => value === 5 ? first.promise : Promise.resolve());
    const set = latestWins(write);
    const done = [set(5), set(6), set(7), set(8)];
    first.open();
    await Promise.all(done);
    expect(write.mock.calls.map(([value]) => value)).toEqual([5, 8]);
  });

  it("starts fresh after a failure and drops the values that were waiting", async () => {
    const write = vi.fn(async (value: number) => { if (value === 1) throw new Error("idb"); });
    const set = latestWins(write);
    const failed = set(1);
    void set(2).catch(() => {});
    await expect(failed).rejects.toThrow("idb");
    await set(3);
    expect(write.mock.calls.map(([value]) => value)).toEqual([1, 3]);
  });
});
