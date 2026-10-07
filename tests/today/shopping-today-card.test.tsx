// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";
import ShoppingTodayCard from "@/components/today/ShoppingTodayCard";

const period = { id: "p1", startDate: "2026-09-30", endDate: "2026-10-06", revision: 1 };
const lines = [{ id: "a", name: "Eggs", checked: false }, { id: "b", name: "Rice", checked: true },
  { id: "c", name: "Oat milk", checked: false }];
function serve(periods: unknown[]) {
  const send = vi.fn(async (url: string) => url.startsWith("/api/shopping/periods/p1")
    ? new Response(JSON.stringify({ period, lines }), { status: 200 })
    : new Response(JSON.stringify({ periods }), { status: 200 }));
  vi.stubGlobal("fetch", send);
  return send;
}
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); unbindAccount(); });

it("shows what is still to buy on the list that covers today, linked to Shopping", async () => {
  serve([period]);
  render(<ShoppingTodayCard enabled today="2026-10-02" />);
  expect(await screen.findByText("2 to buy")).toBeTruthy();
  expect(screen.getByText("Eggs, Oat milk")).toBeTruthy();
  expect(screen.getByRole("link").getAttribute("href")).toBe("/foods#shopping");
});

it("stays silent when shopping is off, or no list covers today", async () => {
  const send = serve([]);
  const { container, rerender } = render(<ShoppingTodayCard enabled={false} today="2026-10-02" />);
  expect(send).not.toHaveBeenCalled();
  rerender(<ShoppingTodayCard enabled today="2026-10-02" />);
  await waitFor(() => expect(send).toHaveBeenCalled());
  expect(container.textContent).toBe("");
});
