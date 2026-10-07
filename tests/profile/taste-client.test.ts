/**
 * Phase 18 W5b (D9 item 3): kept taste text is never sent to Jev or any model — the client runs
 * the local check before any request — and a failed request leaves the flow to manual chips.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/device/account", () => ({
  accountHandle: () => ({ userId: "account-a", epoch: 1 }),
  accountFetch: (_h: unknown, url: string, init: RequestInit) => mocked.fetch(url, init),
  accountJson: async (_h: unknown, response: Response) => response.json(),
  rethrowAccountChanged: () => undefined,
}));

import { classifyDietaryPreferences, suggestTasteChips } from "@/lib/profile/prefs-client";
import { ACCEPTANCE_LOCAL, HEALTH_CORPUS, REDTEAM_CORPUS } from "@/tests/fixtures/taste-safety-corpus";

beforeEach(() => { mocked.fetch.mockReset(); });

describe("suggestTasteChips on the phone", () => {
  it("answers kept text locally and makes no request", async () => {
    for (const c of [...ACCEPTANCE_LOCAL, ...HEALTH_CORPUS]) {
      expect(await suggestTasteChips(c.text)).toEqual({ route: "local", reason: c.reason,
        offer: c.reason === "unsure" ? "plain_prefs" : "rule_editor" });
    }
    expect(mocked.fetch).not.toHaveBeenCalled();
  });

  it("the dietary text field makes no classifier request for kept text: the local route", async () => {
    for (const text of [...ACCEPTANCE_LOCAL.map((c) => c.text), ...HEALTH_CORPUS.map((c) => c.text), ...REDTEAM_CORPUS]) {
      expect(await classifyDietaryPreferences(text)).toMatchObject({ route: "local", source: "local", mentionsFoods: 0 });
    }
    expect(mocked.fetch).not.toHaveBeenCalled();
  });

  it("posts plain text as { taste } and returns the server's chips", async () => {
    const chips = { route: "send", jev: true, likes: [{ key: "f:salmon", label: "salmon", p: 0.99 }], dislikes: [], cuisines: [] };
    mocked.fetch.mockResolvedValue(Response.json(chips));
    expect(await suggestTasteChips("I love salmon")).toEqual(chips);
    expect(mocked.fetch).toHaveBeenCalledWith("/api/profile/prefs", expect.objectContaining({
      method: "POST", body: JSON.stringify({ taste: "I love salmon" }) }));
  });

  it("returns null on a failed request so the flow continues manually", async () => {
    mocked.fetch.mockResolvedValue(new Response("", { status: 503 }));
    expect(await suggestTasteChips("I love salmon")).toBeNull();
    mocked.fetch.mockRejectedValue(new Error("offline"));
    expect(await suggestTasteChips("I love salmon")).toBeNull();
  });
});
