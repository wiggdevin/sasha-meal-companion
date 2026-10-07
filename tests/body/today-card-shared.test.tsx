// @vitest-environment jsdom
/**
 * Health Overview Orbit (2026-09-30): Today reads the viewed day's body data once for the orbit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { resetTestAccount } from "@/tests/helpers/account";
import { useTodayBody } from "@/lib/health/today-card";

const calls = vi.hoisted(() => ({ daily: vi.fn(), expenditure: vi.fn() }));
vi.mock("@/lib/health-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/health-client")>()),
  fetchDaily: (...args: unknown[]) => {
    calls.daily(...args);
    return Promise.resolve({ response: { days: [], sources: [] }, fetchedAt: null, offline: false, disabled: false });
  },
}));
vi.mock("@/lib/estimator-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/estimator-client")>()),
  fetchExpenditure: (...args: unknown[]) => { calls.expenditure(...args); return Promise.resolve(null); },
}));
vi.mock("@/lib/body-profile-client", () => ({ useBodyProfile: () => ({ state: null, error: null }) }));

beforeEach(async () => {
  await resetTestAccount();
  calls.daily.mockClear();
  calls.expenditure.mockClear();
});
afterEach(cleanup);

describe("shared Today body read", () => {
  it("fetches nothing while disabled", () => {
    renderHook(() => useTodayBody("2026-09-30", false));
    expect(calls.daily).not.toHaveBeenCalled();
    expect(calls.expenditure).not.toHaveBeenCalled();
  });

  it("fetches once when enabled", () => {
    renderHook(() => useTodayBody("2026-09-30", true));
    expect(calls.daily).toHaveBeenCalledTimes(1);
  });
});
