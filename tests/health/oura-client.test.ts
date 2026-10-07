import { describe, expect, it, vi } from "vitest";
import { ouraGet, OURA_RETRY_DELAYS_MS } from "@/lib/oura/client";

const ok = () => new Response(JSON.stringify({ data: [{ id: "x" }] }), { status: 200 });
const sleepFn = vi.fn(async (_ms: number) => {});

describe("ouraGet", () => {
  it("returns the parsed document on the first success", async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ok());
    expect(await ouraGet("daily_activity", { start_date: "2026-09-14" },
      { accessToken: "a", fetchFn, sleepFn })).toEqual({ data: [{ id: "x" }] });
    const url = String(fetchFn.mock.calls[0][0]);
    expect(url).toBe("https://api.ouraring.com/v2/usercollection/daily_activity?start_date=2026-09-14");
    expect((fetchFn.mock.calls[0][1] as RequestInit).headers)
      .toMatchObject({ authorization: "Bearer a" });
  });

  it("backs off 1s, 2s, 4s on 429 and 5xx, then gives up", async () => {
    expect(OURA_RETRY_DELAYS_MS).toEqual([1000, 2000, 4000]);
    sleepFn.mockClear();
    const fetchFn = vi.fn(async () => new Response("busy", { status: 429 }));
    await expect(ouraGet("sleep", {}, { accessToken: "a", fetchFn, sleepFn })).rejects.toThrow(/429/);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleepFn.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
  });

  it("refreshes once on 401 and retries once, never twice", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("no", { status: 401 }))
      .mockResolvedValueOnce(ok());
    const refresh = vi.fn(async () => "fresh");
    await ouraGet("sleep", {}, { accessToken: "stale", fetchFn, refresh, sleepFn });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[1][1] as RequestInit).headers)
      .toMatchObject({ authorization: "Bearer fresh" });
  });

  it("throws on a 401 with no refresh available", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 401 }));
    await expect(ouraGet("sleep", {}, { accessToken: "stale", fetchFn, sleepFn }))
      .rejects.toThrow(/401/);
  });
});
