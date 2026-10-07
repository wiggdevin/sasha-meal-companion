// @vitest-environment jsdom
/**
 * Settings → Data & account → Sign out (Phase 9 slice 1, reload boundary). The card says first
 * what is still waiting on this phone; a second tap signs out, for the account the tap was for.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({
  notice: vi.fn(async (_id: string): Promise<string | null> => null),
  signOutHere: vi.fn(async (_auth: unknown, _id: string) => "leaving"),
}));
vi.mock("@/lib/device/sign-out", () => ({
  signOutNotice: (id: string) => device.notice(id),
  signOutHere: (auth: unknown, id: string) => device.signOutHere(auth, id),
}));
vi.mock("@/lib/supabase/client", () => ({ browserClient: () => ({ auth: {} }) }));

import SignOutCard from "@/components/settings/SignOutCard";
import { bindAccount, unbindAccount } from "@/lib/device/account";

let container: HTMLDivElement;

beforeEach(() => {
  unbindAccount();
  bindAccount("user-a");
  device.notice.mockReset().mockResolvedValue(null);
  device.signOutHere.mockClear();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => { container.remove(); });

async function render() {
  const root = createRoot(container);
  await act(async () => { root.render(<SignOutCard />); });
  return root;
}

const button = () => container.querySelector("button")!;

describe("SignOutCard", () => {
  it("default: one tap signs out the account it was tapped for when nothing is waiting", async () => {
    const root = await render();
    expect(button().textContent).toBe("Sign out");
    await act(async () => { button().click(); });
    expect(device.signOutHere).toHaveBeenCalledWith(expect.anything(), "user-a");
    await act(async () => { root.unmount(); });
  });

  it("unsent notice: says what is waiting first, and signs out on the second tap", async () => {
    device.notice.mockResolvedValue("2 changes are not synced yet.");
    const root = await render();
    await act(async () => { button().click(); });
    expect(container.textContent).toContain("2 changes are not synced yet.");
    expect(device.signOutHere).not.toHaveBeenCalled();
    expect(button().textContent).toBe("Sign out anyway");
    await act(async () => { button().click(); });
    expect(device.signOutHere).toHaveBeenCalledWith(expect.anything(), "user-a");
    await act(async () => { root.unmount(); });
  });
});
