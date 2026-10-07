/**
 * Phase 13 §2 "Enforcement": the provider adapters refuse at runtime, before any transport, when
 * the registered class is not cleared for the provider. The clearance table is narrowed here so
 * that real, registered purposes become uncleared: `profile-prefs` (D1) for Jev, `coach` (D2) for
 * Gemini.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));
vi.mock("@/lib/ai/call-registry", async (original) => {
  const real = await original<typeof import("@/lib/ai/call-registry")>();
  const narrowed = { ...real.CLEARED, google: ["D0", "D1"], typesafe: ["D0"] } as const;
  return { ...real,
    callRefusal: (purpose: string, provider: Parameters<typeof real.callRefusal>[1]) =>
      real.callRefusal(purpose, provider, real.CALL_REGISTRY, narrowed) };
});

import { z } from "zod";
import { generateStructured, type GenerateDeps } from "@/lib/ai/adapter";
import { coachTurnPayload } from "@/lib/ai/gemini-payloads";
import { prefsPayload } from "@/lib/ai/payloads";
import { systemOne } from "@/lib/ai/typesafe";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("adapter refusal of an uncleared class", () => {
  it("systemOne refuses a D1 purpose when Jev is cleared for D0 only, with no request", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "k");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const payload = prefsPayload({ text: "veggie" });
    await expect(systemOne(payload, { userId: "u1" })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not cleared for D1/));
  });

  it("generateStructured refuses a D2 purpose when Gemini is not cleared for D2", async () => {
    const callGemini = vi.fn();
    const insert = vi.fn();
    await expect(generateStructured({
      payload: coachTurnPayload(["USER: hi"]), userId: "u1", schema: z.object({ ok: z.boolean() }),
      admin: { from: () => ({ insert }) } as never,
    }, { callGemini } as GenerateDeps)).rejects.toThrow(/not cleared for D2/);
    expect(callGemini).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});
