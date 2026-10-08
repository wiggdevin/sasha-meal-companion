/**
 * W13 (D14) + Sol review BLOCK: openFoodWorld must flush the outbox before calling
 * POST /api/foods/world, since the onboarded_at write it follows is only queued locally — a
 * brand-new account's user_settings row may not exist on the server yet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ fetch: vi.fn(), flush: vi.fn() }));
vi.mock("@/lib/device/account", () => ({
  accountHandle: () => ({ userId: "account-a", epoch: 1 }),
  accountFetch: (_h: unknown, url: string, init?: RequestInit) => mocked.fetch(url, init),
  assertCurrent: () => undefined,
  rethrowAccountChanged: () => undefined,
}));
vi.mock("@/lib/sync/client", () => ({ flushOutboxNow: (h: unknown) => mocked.flush(h) }));

import { openFoodWorld } from "@/lib/profile/onboarding-client";

const H = { userId: "account-a", epoch: 1 };

beforeEach(() => { mocked.fetch.mockReset(); mocked.flush.mockReset(); });

describe("openFoodWorld", () => {
  it("flushes the outbox before posting, so the just-queued onboarded_at write lands first", async () => {
    mocked.flush.mockResolvedValue(true);
    mocked.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await openFoodWorld(H as never);
    expect(mocked.flush).toHaveBeenCalledTimes(1);
    expect(mocked.fetch).toHaveBeenCalledWith("/api/foods/world", expect.objectContaining({ method: "POST" }));
  });

  it("never calls the open-world route when the flush fails — never a 409 against a missing row", async () => {
    mocked.flush.mockResolvedValue(false);
    await openFoodWorld(H as never);
    expect(mocked.fetch).not.toHaveBeenCalled();
  });

  it("never throws when the post itself fails", async () => {
    mocked.flush.mockResolvedValue(true);
    mocked.fetch.mockRejectedValue(new Error("offline"));
    await expect(openFoodWorld(H as never)).resolves.toBeUndefined();
  });
});
