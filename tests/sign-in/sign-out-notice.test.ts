/** UI audit 2026-10-18 §9: the unsent-work notice reads correctly for one change. */
import { describe, expect, it, vi } from "vitest";

const total = vi.fn((_w: unknown) => 0 as number | null);
vi.mock("@/lib/device/forget", () => ({
  pendingWork: async () => ({}),
  pendingTotal: (w: unknown) => total(w),
}));

const { signOutNotice } = await import("@/lib/device/sign-out");

describe("signOutNotice", () => {
  it("says '1 change is' for one", async () => {
    total.mockReturnValueOnce(1);
    expect(await signOutNotice("u")).toBe(
      "1 change is not synced yet. It stays on this phone and sends when you sign in again.",
    );
  });

  it("says 'N changes are' for more", async () => {
    total.mockReturnValueOnce(3);
    expect(await signOutNotice("u")).toMatch(/^3 changes are not synced yet\./);
  });

  it("is null when nothing waits", async () => {
    total.mockReturnValueOnce(0);
    expect(await signOutNotice("u")).toBeNull();
  });
});
