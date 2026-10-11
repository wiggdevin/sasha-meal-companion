// @vitest-environment jsdom
// Final Sol review r3 BLOCK: after an account switch in the same mounted shell, the previous
// account's stored holds (`ready`) and reward preview stayed in force until the new reads answered.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAccount, markAccountReady, unbindAccount } from "@/lib/device/account";
import { useStoredEligibility } from "@/components/Onboarding/v2/stored-eligibility";
import { usePreviewAccount } from "@/components/Onboarding/v2/preview-account";
import { defaultStore } from "@/lib/store";
import { SAFETY_CONDITION_TEXT } from "@/lib/profile/rate-eligibility";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const rules = { avoid_allergens: [], avoid_food_ref_ids: [], banned_categories: [], notes: null };

// Without vitest globals Testing Library never registers its own cleanup, so a hook left mounted
// let React's scheduler run after jsdom was torn down ("window is not defined", CI 2026-10-10).
afterEach(() => { cleanup(); unbindAccount(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("the stored pace holds follow the bound account", () => {
  it("reads loading, never A's ready, while B's read is pending, and drops a late answer for A", async () => {
    bindAccount(A);
    const bRead = deferred<unknown>();
    const lateA = deferred<unknown>();
    let calls = 0;
    const reads = {
      constraints: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { profile: { ...rules, conditions: [] }, rev: 1 };
        if (calls === 2) return lateA.promise;
        return bRead.promise;
      }),
      instances: vi.fn(async () => ({ instances: [], catalog: [], legacyProfileIds: [] })),
    };
    const { result } = renderHook(() => useStoredEligibility(true, 0, reads as never));
    await vi.waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.eligibility).toEqual({ holds: [], minor: false });

    // A second read for A is still in flight when the switch happens.
    let late: Promise<unknown> | null = null;
    act(() => { late = result.current.refresh(); });
    act(() => { unbindAccount(); markAccountReady(bindAccount(B)); });
    expect(result.current.status).toBe("loading");
    expect(result.current.eligibility).toBeNull();

    lateA.resolve({ profile: { ...rules, conditions: [] }, rev: 2 });
    await act(async () => { expect(await late).toBeNull(); });
    expect(result.current.status).toBe("loading");

    await act(async () => { bRead.resolve({ profile: { ...rules, conditions: [SAFETY_CONDITION_TEXT.pregnant] }, rev: 4 }); });
    await vi.waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.eligibility?.holds).toEqual(["pregnancy"]);
  });
});

describe("the reward preview follows the bound account", () => {
  it("is dropped when the beat closes and never shows A's foods to B", async () => {
    bindAccount(A);
    const storeA = { ...defaultStore(), foods: {} };
    const bStore = deferred<void>();
    let which = "A";
    const reads = {
      store: vi.fn(() => ({ ...storeA, marker: which }) as never),
      eligible: vi.fn(),
    };
    const { result, rerender } = renderHook(({ on }) => usePreviewAccount(on, reads as never),
      { initialProps: { on: true } });
    await vi.waitFor(() => expect(result.current).not.toBeNull());
    expect((result.current?.store as unknown as { marker: string }).marker).toBe("A");

    rerender({ on: false });
    expect(result.current).toBeNull();
    act(() => { unbindAccount(); markAccountReady(bindAccount(B)); });
    which = "B";
    reads.store.mockImplementationOnce(() => { void bStore.promise; return ({ ...storeA, marker: "B" }) as never; });
    rerender({ on: true });
    // Never A's answer, even for the first render of the reopened beat.
    expect((result.current?.store as unknown as { marker: string } | undefined)?.marker).not.toBe("A");
    await vi.waitFor(() => expect(result.current).not.toBeNull());
    expect((result.current?.store as unknown as { marker: string }).marker).toBe("B");
  });
});
