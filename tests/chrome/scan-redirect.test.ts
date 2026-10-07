import { expect, it, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn(() => { throw new Error("redirected"); }));

vi.mock("next/navigation", () => ({ redirect }));

it("keeps /scan as a temporary redirect to the coach scanner", async () => {
  const { default: ScanPage } = await import("@/app/scan/page");
  expect(() => ScanPage()).toThrow("redirected");
  expect(redirect).toHaveBeenCalledWith("/coach?open=scan");
});

it("redirects /scan before the auth middleware through next.config", async () => {
  const { default: config } = await import("../../next.config");
  const rules = await config.redirects?.();
  expect(rules).toEqual([{ source: "/scan", destination: "/coach?open=scan", permanent: false }]);
});
