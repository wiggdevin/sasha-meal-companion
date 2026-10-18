// @vitest-environment jsdom
/**
 * UI audit 2026-10-18 §5: the Week screen resolved its days without the verified Eats Today uses, so
 * generated meals never existed there and its dots and stats disagreed with Today's strip. It now
 * reads the same set and resolves each day through Today's builder.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const ids = new Set(["food-a"]);
const resolveStripDay = vi.fn();

vi.mock("@/lib/device/account", async (original) => ({
  ...(await original<typeof import("@/lib/device/account")>()),
  currentAccountOrNull: () => ({ userId: "u1", epoch: 1 }),
}));
vi.mock("@/lib/foods/eligible-client", () => ({ loadEligibleLocalFoodIds: vi.fn(async () => ids) }));
vi.mock("@/lib/today/resolve-strip-day", async () => {
  const { resolveDay } = await import("@/lib/resolve");
  return {
    resolveStripDay: (...args: Parameters<typeof resolveDay>) => {
      resolveStripDay(...args);
      return resolveDay(args[0], args[1]);
    },
  };
});

afterEach(() => { cleanup(); resolveStripDay.mockClear(); });

describe("the Week screen's plan inputs", () => {
  it("resolves every day with the verified Eats Today generates from", async () => {
    const { default: WeekPage } = await import("@/app/week/page");
    render(<WeekPage />);
    await waitFor(() => expect(resolveStripDay).toHaveBeenCalled());
    expect(screen.queryByText("Loading your week…")).toBeNull();
    for (const call of resolveStripDay.mock.calls) {
      // A fresh store has no rule review recorded, so generation still waits, as on Today.
      expect(call[2]).toMatchObject({ eligibleFoodIds: ids, ruleReviewReady: false });
    }
    expect(resolveStripDay.mock.calls.length % 7).toBe(0);
  });
});
