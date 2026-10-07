/**
 * PR #248 review r3 #1: `/api/health/daily` now refuses a request with no account header, so the
 * tab bar's body probe waits for a ready account and sends that account's header.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import { probeBodyCapability, resetCapabilityCache } from "@/lib/health/capability";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const headerOf = (f: { mock: { calls: unknown[][] } }) =>
  new Headers((f.mock.calls[0][1] as RequestInit).headers).get("x-smc-account");

beforeEach(() => {
  unbindAccount();
  resetCapabilityCache();
});

describe("probeBodyCapability", () => {
  it("sends the ready account's header", async () => {
    markAccountReady(bindAccount(A));
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await expect(probeBodyCapability(f as never)).resolves.toBe("enabled");
    expect(headerOf(f)).toBe(A);
  });

  it("waits for an account to be ready before it asks", async () => {
    const f = vi.fn(async () => new Response(null, { status: 503 }));
    const probe = probeBodyCapability(f as never);
    await Promise.resolve();
    expect(f).not.toHaveBeenCalled();
    markAccountReady(bindAccount(A));
    await expect(probe).resolves.toBe("disabled");
    expect(headerOf(f)).toBe(A);
  });
});
