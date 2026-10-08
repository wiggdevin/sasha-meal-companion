// @vitest-environment jsdom
/**
 * UI audit 2026-10-07 (Body WARN): /body read its days once on mount, so a weigh-in from another
 * device, or this phone's queued weigh-in posting, left the sparklines and trend stale.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { TEST_USER } from "@/tests/helpers/account";

const reads = vi.hoisted(() => ({ daily: vi.fn() }));
vi.mock("@/lib/health-client", () => ({ fetchDaily: reads.daily }));
vi.mock("@/lib/estimator-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/estimator-client")>(),
  fetchExpenditure: vi.fn(async () => null), fetchProposals: vi.fn(async () => null), fetchTargets: vi.fn(),
}));
vi.mock("@/lib/body-profile-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/body-profile-client")>(),
  useBodyProfile: () => ({ status: "loading" }),
}));

const { useBodyDashboard } = await import("@/lib/health/body-page");
const day = (date: string, weightKg: number) => ({ response: { days: [{ date, weightKg }] } });

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); reads.daily.mockReset(); });
afterEach(() => { cleanup(); unbindAccount(); });

describe("the body page's days", () => {
  it("follow a sync pass", async () => {
    reads.daily.mockResolvedValueOnce(day("2026-10-06", 80)).mockResolvedValueOnce(day("2026-10-07", 79.6));
    const { result } = renderHook(() => useBodyDashboard());
    await act(async () => {});
    expect(result.current.daily).toEqual(day("2026-10-06", 80));
    await act(async () => { window.dispatchEvent(new Event(SYNCED_EVENT)); });
    expect(reads.daily).toHaveBeenCalledTimes(2);
    expect(result.current.daily).toEqual(day("2026-10-07", 79.6));
  });

  it("read one at a time: a burst of passes costs one more read, landing after the slow one", async () => {
    let slow!: (value: unknown) => void;
    reads.daily.mockImplementationOnce(() => new Promise((resolve) => { slow = resolve; }))
      .mockResolvedValueOnce(day("2026-10-07", 79.6));
    const { result } = renderHook(() => useBodyDashboard());
    await act(async () => {
      for (let i = 0; i < 5; i++) window.dispatchEvent(new Event(SYNCED_EVENT));
    });
    expect(reads.daily).toHaveBeenCalledTimes(1);
    await act(async () => { slow(day("2026-10-06", 80)); });
    await act(async () => {});
    expect(reads.daily).toHaveBeenCalledTimes(2);
    expect(result.current.daily).toEqual(day("2026-10-07", 79.6));
  });
});
