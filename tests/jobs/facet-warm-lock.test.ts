import { afterEach, describe, expect, it, vi } from "vitest";

const releaseLock = vi.hoisted(() => vi.fn(async () => undefined));
const warmEatsFacets = vi.hoisted(() => vi.fn());
vi.mock("@/lib/server/jobs", () => ({
  cronSecretOk: () => true, claimLock: async () => "taken", releaseLock,
  accountIds: async function* () { yield "u1"; },
}));
vi.mock("@/lib/server/ratelimit", () => ({ enforceRateLimit: async () => undefined }));
// No saved resume cursor (lib/server/job-sweep.ts) and every cursor write accepted.
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ from: () => {
  const chain = { select: () => chain, eq: () => chain,
    maybeSingle: async () => ({ data: null, error: null }), upsert: async () => ({ error: null }) };
  return chain;
} }) }));
vi.mock("@/lib/server/eats-facet-warm", () => ({ warmEatsFacets }));

import { POST } from "@/app/api/jobs/facet-warm/route";

afterEach(() => vi.clearAllMocks());

/** Grok audit round 9: a run that warmed nothing because of errors held today's lock as "ok". */
describe("facet warm job lock", () => {
  it("releases a run that warmed nothing and failed as an error, so today's retry can run", async () => {
    warmEatsFacets.mockResolvedValue({ foods: 3, warmed: 0, skipped: 3, errors: 1, stoppedEarly: true });
    const res = await POST(new Request("https://x/api/jobs/facet-warm", { method: "POST" }));
    expect(await res.json()).toMatchObject({ ran: 0, errors: 1 });
    expect(releaseLock).toHaveBeenCalledWith(expect.anything(), "facet-warm", "u1", expect.any(String), "error", expect.anything());
  });

  it("releases a run that warmed something as ok", async () => {
    warmEatsFacets.mockResolvedValue({ foods: 3, warmed: 25, skipped: 2, errors: 1, stoppedEarly: true });
    const res = await POST(new Request("https://x/api/jobs/facet-warm", { method: "POST" }));
    expect(await res.json()).toMatchObject({ ran: 1, errors: 0 });
    expect(releaseLock).toHaveBeenCalledWith(expect.anything(), "facet-warm", "u1", expect.any(String), "ok", expect.anything());
  });
});
