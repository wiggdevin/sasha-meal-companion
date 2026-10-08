// @vitest-environment jsdom
/**
 * UI audit 2026-10-07 (Body NIT): `busy` disables the sheet's buttons only after a repaint, so two
 * quick taps sent two requests (for "issue", two connection codes with only the second shown).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotionConfig } from "motion/react";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

const health = vi.hoisted(() => ({ revoke: vi.fn(), connect: vi.fn() }));
vi.mock("@/lib/health-client", () => ({
  connectOura: health.connect, disconnectOura: vi.fn(), issueToken: vi.fn(), revokeToken: health.revoke,
}));

const { default: HealthSourcesSheet } = await import("@/components/HealthSourcesSheet");

beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });
afterEach(() => { cleanup(); unbindAccount(); });

describe("the health connections sheet", () => {
  it("sends one revoke for two quick taps", async () => {
    let done!: () => void;
    health.revoke.mockImplementation(() => new Promise<void>((resolve) => { done = resolve; }));
    const onChanged = vi.fn();
    render(<MotionConfig reducedMotion="always"><HealthSourcesSheet appleOnly onClose={() => {}} onChanged={onChanged}
      sources={[{ id: "s1", kind: "apple_health_shortcut", device_label: "Apple Health Shortcut",
        revoked: false } as never]} /></MotionConfig>);
    const revoke = screen.getByRole("button", { name: "Revoke" });
    // Both taps land before React repaints the disabled state.
    act(() => { fireEvent.click(revoke); fireEvent.click(revoke); });
    await act(async () => { done(); });
    expect(health.revoke).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("starts one Oura sign-in for two quick taps", async () => {
    health.connect.mockImplementation(() => new Promise(() => {}));
    render(<MotionConfig reducedMotion="always"><HealthSourcesSheet onClose={() => {}} onChanged={() => {}} sources={[]} /></MotionConfig>);
    const connect = screen.getByRole("button", { name: "Connect Oura" });
    act(() => { fireEvent.click(connect); fireEvent.click(connect); });
    expect(health.connect).toHaveBeenCalledOnce();
  });
});
