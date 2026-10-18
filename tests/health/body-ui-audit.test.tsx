// @vitest-environment jsdom
/**
 * UI audit 2026-10-18, section 2 (Body page and health sources): the connection code appears in
 * the section that made it, destructive actions ask twice, Connect Oura reports a failure, the
 * sheet follows the connection, and each source row says when it last sent.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotionConfig } from "motion/react";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

const health = vi.hoisted(() => ({ revoke: vi.fn(), connect: vi.fn(), issue: vi.fn(),
  disconnect: vi.fn() }));
vi.mock("@/lib/health-client", () => ({
  connectOura: health.connect, disconnectOura: health.disconnect, issueToken: health.issue,
  revokeToken: health.revoke,
}));

const { default: HealthSourcesSheet } = await import("@/components/HealthSourcesSheet");

const SHORTCUT = { id: "s1", kind: "apple_health_shortcut", device_label: "Apple Health Shortcut",
  last_received_at: null, revoked: false };

function sheet(sources: unknown[] = [], appleOnly = false) {
  return render(<MotionConfig reducedMotion="always"><HealthSourcesSheet appleOnly={appleOnly}
    onClose={() => {}} onChanged={() => {}} sources={sources as never} /></MotionConfig>);
}

let onLine = true;
beforeEach(() => {
  unbindAccount(); bindAccount(TEST_USER); onLine = true;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => onLine });
  for (const fn of Object.values(health)) fn.mockReset();
});
afterEach(() => { cleanup(); unbindAccount(); vi.useRealTimers(); });

describe("the health connections sheet (UI audit 2026-10-18)", () => {
  it("shows the code inside the tapped section and stops a second code", async () => {
    health.issue.mockResolvedValue({ token: "tok-123", source: { id: "n1" } });
    sheet([], true);
    const [shortcut] = screen.getAllByRole("button", { name: "Create connection code" });
    await act(async () => { fireEvent.click(shortcut); });
    const code = screen.getByText("tok-123");
    expect(shortcut.closest("section")?.contains(code)).toBe(true);
    expect(screen.getByText(/shown once/).getAttribute("role")).toBe("status");
    const done = screen.getByRole("button", { name: "Code created, copy it below" });
    expect((done as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement?.contains(code)).toBe(true);
  });

  it("revokes only on a second tap, and disarms after a pause", () => {
    vi.useFakeTimers();
    health.revoke.mockResolvedValue(undefined);
    sheet([SHORTCUT], true);
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Revoke Apple Health Shortcut" })); });
    expect(health.revoke).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(4100); });
    expect(screen.getByRole("button", { name: "Revoke Apple Health Shortcut" })).toBeTruthy();
    expect(health.revoke).not.toHaveBeenCalled();
  });

  it("disconnects Oura only on a second tap", () => {
    health.disconnect.mockResolvedValue(undefined);
    sheet([{ id: "o1", kind: "oura", device_label: null, last_received_at: null, revoked: false }]);
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Disconnect Oura" })); });
    expect(health.disconnect).not.toHaveBeenCalled();
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Tap again to disconnect" })); });
    expect(health.disconnect).toHaveBeenCalledOnce();
  });

  it("says when Connect Oura fails", async () => {
    health.connect.mockRejectedValue(new Error("down"));
    sheet();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Connect Oura" })); });
    expect(screen.getByRole("alert").textContent).toContain("did not go through");
  });

  it("turns its buttons back on when the connection returns", () => {
    onLine = false;
    sheet([SHORTCUT], true);
    expect(screen.getByText("These need a connection.")).toBeTruthy();
    onLine = true;
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(screen.queryByText("These need a connection.")).toBeNull();
    expect((screen.getByRole("button", { name: "Revoke Apple Health Shortcut" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says when each source last sent", () => {
    sheet([SHORTCUT, { ...SHORTCUT, id: "s2", last_received_at: new Date().toISOString() }], true);
    expect(screen.getByText(/last received never/)).toBeTruthy();
    expect(screen.getByText(/last received (0 min ago|just now)/)).toBeTruthy();
  });
});
