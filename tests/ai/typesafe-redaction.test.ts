/**
 * Phase 18 W5b (Sol r1 WARN 5), widened by W068: for every purpose that carries the user's own
 * content (data class D1), a provider error keeps only its status in `ai_calls.error` and in the
 * server log — never the provider's body, which may echo it. Food-only (D0) evals keep the detail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminClientMock } = vi.hoisted(() => ({ adminClientMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/admin", () => ({ adminClient: adminClientMock }));

import { occasionEvalPayload, prefsPayload, tastePayload, verifyPayload } from "@/lib/ai/payloads";
import { systemOne } from "@/lib/ai/typesafe";
import { spendAdmin } from "./spend-admin";

const SECRET = "I love salmon";
const echo = () => new Response(`bad request: you sent "${SECRET}"`, { status: 400 });

describe("redacted Jev errors", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
    vi.stubGlobal("fetch", vi.fn());
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); warn.mockRestore(); });

  it("stores and logs only the status for every user-content purpose", async () => {
    const payloads = [
      () => tastePayload({ text: SECRET, families: ["salmon"] }),
      () => prefsPayload({ text: SECRET }),
      () => verifyPayload({ reply: SECRET, actions: [], toolNames: [] }),
    ];
    for (const make of payloads) {
      const rows: Record<string, unknown>[] = [];
      adminClientMock.mockReturnValue(spendAdmin([], rows));
      vi.mocked(fetch).mockResolvedValue(echo());
      await expect(systemOne(make() as never, { userId: "user-1" })).resolves.toBeNull();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "provider_error", error: "HTTP 400" });
    }
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain("HTTP 400");
  });

  it("keeps the provider detail for a food-only (D0) eval, as before", async () => {
    const rows: Record<string, unknown>[] = [];
    adminClientMock.mockReturnValue(spendAdmin([], rows));
    vi.mocked(fetch).mockResolvedValue(new Response("bad request", { status: 400 }));
    await systemOne(occasionEvalPayload({ items: [{ id: "congee", food: { name: "Congee" } }] }),
      { userId: "user-1" });
    expect(rows[0]).toMatchObject({ error: "HTTP 400: bad request" });
  });
});
