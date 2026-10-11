// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { createOnboardingState } from "@/lib/profile/onboarding-state";
import { defaultSettings } from "@/lib/store";
import { useOnboardingFoodAccess } from "./useOnboardingFoodAccess";

const reads = vi.hoisted(() => ({ access: vi.fn(), review: vi.fn(), constraints: vi.fn() }));
vi.mock("@/lib/device/account", async (original) => ({
  ...(await original<typeof import("@/lib/device/account")>()),
  accountFetch: reads.access,
}));
vi.mock("@/lib/rule-review-client", () => ({ loadRuleReview: reads.review }));
vi.mock("@/lib/constraints-client", () => ({ loadConstraints: reads.constraints }));

beforeEach(() => {
  bindAccount("11111111-1111-4111-8111-111111111111");
  reads.access.mockReset();
  reads.review.mockReset();
  reads.constraints.mockReset();
  reads.review.mockResolvedValue({ required: false, candidateAllergens: [],
    candidateCategories: [], rev: 0 });
  reads.constraints.mockResolvedValue({ profile: {}, rev: 0 });
});
// Unmount before the next file: a mounted hook lets React run after jsdom is torn down.
afterEach(() => { cleanup(); unbindAccount(); });

describe("onboarding food access", () => {
  it("opens optional Foods only after explicit pilot access and verified rules", async () => {
    reads.access.mockResolvedValue(new Response(JSON.stringify({ enabled: true })));
    const { result } = renderHook(() => useOnboardingFoodAccess(null));
    expect(result.current.status).toBe("checking");
    await waitFor(() => expect(result.current.status).toBe("pilot"));
    expect(reads.access).toHaveBeenCalledWith(expect.objectContaining({ userId: expect.any(String) }),
      "/api/recipes/access", { cache: "no-store" }, { budget: "prefs" });
    expect(reads.review).toHaveBeenCalledOnce();
    expect(reads.constraints).toHaveBeenCalledOnce();
  });

  it("keeps the legacy path for an explicit disabled flag", async () => {
    reads.access.mockResolvedValue(new Response(JSON.stringify({ enabled: false })));
    const { result } = renderHook(() => useOnboardingFoodAccess(null));
    await waitFor(() => expect(result.current.status).toBe("legacy"));
    expect(reads.review).not.toHaveBeenCalled();
    expect(reads.constraints).not.toHaveBeenCalled();
  });

  it("rechecks a cached enabled flag at completion and observes revocation", async () => {
    reads.access.mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: false })));
    const { result } = renderHook(() => useOnboardingFoodAccess(null));
    await waitFor(() => expect(result.current.status).toBe("pilot"));
    await act(async () => expect(await result.current.revalidate()).toBe("legacy"));
    expect(result.current.status).toBe("legacy");
    expect(reads.access).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the account changes during the completion read", async () => {
    let finishRead!: (response: Response) => void;
    reads.access.mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true })))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRead = resolve; }));
    const { result } = renderHook(() => useOnboardingFoodAccess(null));
    await waitFor(() => expect(result.current.status).toBe("pilot"));
    let pending!: Promise<"checking" | "pilot" | "legacy" | "review" | "unavailable">;
    act(() => { pending = result.current.revalidate(); });
    bindAccount("22222222-2222-4222-8222-222222222222");
    finishRead(new Response(JSON.stringify({ enabled: true })));
    await act(async () => expect(await pending).toBe("unavailable"));
    expect(result.current.status).toBe("checking");
    expect(reads.review).toHaveBeenCalledOnce();
  });

  it("blocks when access is unavailable or malformed", async () => {
    reads.access.mockResolvedValue(new Response(JSON.stringify({})));
    const { result } = renderHook(() => useOnboardingFoodAccess(null));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(reads.review).not.toHaveBeenCalled();
  });

  it("holds the pilot flow for an outstanding dietary review", async () => {
    reads.access.mockResolvedValue(new Response(JSON.stringify({ enabled: true })));
    reads.review.mockResolvedValue({ required: true, candidateAllergens: [],
      candidateCategories: [], rev: 0 });
    const { result } = renderHook(() => useOnboardingFoodAccess(null));
    await waitFor(() => expect(result.current.status).toBe("review"));
  });

  it("rechecks dietary review when the user reaches Foods with new preferences", async () => {
    reads.access.mockImplementation(async () => new Response(JSON.stringify({ enabled: true })));
    const initial = createOnboardingState(defaultSettings());
    const { result, rerender } = renderHook(({ step }) => useOnboardingFoodAccess({
      ...initial, step, flags: step === 4 ? ["vegetarian"] : [],
    }), { initialProps: { step: 3 } });
    await waitFor(() => expect(result.current.status).toBe("pilot"));
    reads.review.mockResolvedValue({ required: true, candidateAllergens: [],
      candidateCategories: [], rev: 1 });
    rerender({ step: 4 });
    expect(result.current.status).toBe("checking");
    await waitFor(() => expect(result.current.status).toBe("review"));
  });
});
