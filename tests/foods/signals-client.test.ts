/**
 * Phase 18 W6: the phone's signal post never blocks a tap. It sends the wire contract the route
 * parses, splits more than 20 events into batches, and a failed post answers false, never throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/device/account", () => ({
  accountHandle: () => ({ userId: "account-a", epoch: 1 }),
  accountFetch: (_h: unknown, url: string, init: RequestInit) => mocked.fetch(url, init),
  rethrowAccountChanged: () => undefined,
}));

import { FoodSignalBatch } from "@/lib/foods/signals";
import { foodSignal, sendFoodSignals } from "@/lib/foods/signals-client";

const tap = () => foodSignal({ slateId: crypto.randomUUID(), surface: "plan_sheet", kind: "not_this",
  occasion: "dinner", chosenKey: "food:smoked-salmon", offeredKeys: ["food:smoked-salmon", "catalog:42"],
  rankingVersion: "o2.1" }, new Date("2026-10-06T18:30:00Z"));

beforeEach(() => { mocked.fetch.mockReset(); });

describe("foodSignal", () => {
  it("stamps the phone's own date at the tap, not the viewed plan's date", () => {
    const now = new Date(2026, 9, 6, 23, 50);
    const e = foodSignal({ slateId: crypto.randomUUID(), surface: "swap_sheet", kind: "picked",
      occasion: "snack", chosenKey: "catalog:42", offeredKeys: ["catalog:42"], rankingVersion: "o2.1" }, now);
    expect(e.localDate).toBe("2026-10-06");
    expect(e.at).toBe(now.toISOString());
  });
});

describe("sendFoodSignals", () => {
  it("posts the contract the route parses", async () => {
    mocked.fetch.mockResolvedValue(new Response("{}", { status: 202 }));
    expect(await sendFoodSignals([tap()])).toBe(true);
    const [url, init] = mocked.fetch.mock.calls[0];
    expect(url).toBe("/api/foods/signals");
    expect(FoodSignalBatch.safeParse(JSON.parse(init.body as string)).success).toBe(true);
  });

  it("splits more than 20 events into batches of 20", async () => {
    mocked.fetch.mockResolvedValue(new Response("{}", { status: 202 }));
    await sendFoodSignals(Array.from({ length: 45 }, tap));
    expect(mocked.fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string).events.length))
      .toEqual([20, 20, 5]);
  });

  it("answers false and never throws when the post fails", async () => {
    mocked.fetch.mockRejectedValue(new Error("offline"));
    await expect(sendFoodSignals([tap()])).resolves.toBe(false);
    mocked.fetch.mockResolvedValue(new Response("{}", { status: 429 }));
    await expect(sendFoodSignals([tap()])).resolves.toBe(false);
  });
});
