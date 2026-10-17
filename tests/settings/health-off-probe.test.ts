import { afterEach, describe, expect, it, vi } from "vitest";

const fetchDaily = vi.fn();
const read = vi.fn();
const probe = vi.fn();
vi.mock("@/lib/health-client", () => ({ fetchDaily: (...a: unknown[]) => fetchDaily(...a) }));
vi.mock("@/lib/health/capability", () => ({
  readBodyCapability: () => read(),
  probeBodyCapability: () => probe(),
}));

import { fetchDailyIfEnabled } from "@/components/settings/use-settings-controller";

afterEach(() => vi.clearAllMocks());

describe("Settings health read", () => {
  it("makes no daily request when health is known to be off", async () => {
    read.mockReturnValue("disabled");
    expect(await fetchDailyIfEnabled({} as never, "2026-10-01", "2026-10-17")).toBeNull();
    expect(fetchDaily).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("asks the shared probe once when unknown, and skips the read if it says disabled", async () => {
    read.mockReturnValue("unknown");
    probe.mockResolvedValue("disabled");
    expect(await fetchDailyIfEnabled({} as never, "a", "b")).toBeNull();
    expect(fetchDaily).not.toHaveBeenCalled();
  });

  it("falls through to the read when the probe cannot decide", async () => {
    read.mockReturnValue("unknown");
    probe.mockResolvedValue("unknown");
    fetchDaily.mockResolvedValue({ ok: true });
    expect(await fetchDailyIfEnabled({} as never, "a", "b")).toEqual({ ok: true });
    expect(fetchDaily).toHaveBeenCalledTimes(1);
  });

  it("reads when health is on", async () => {
    read.mockReturnValue("enabled");
    fetchDaily.mockResolvedValue({ ok: true });
    expect(await fetchDailyIfEnabled({} as never, "a", "b")).toEqual({ ok: true });
  });
});
