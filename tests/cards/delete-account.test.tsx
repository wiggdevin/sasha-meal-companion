// @vitest-environment jsdom
/**
 * Settings → Data & account → Delete account (W057). Hidden unless the server says the switch is
 * on; never one tap: the row explains what is deleted, the button stays off until DELETE is
 * typed, a sheet asks once more, and a stale session is confirmed with a sign-in code first.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  enabled: vi.fn(async (): Promise<boolean> => true),
  request: vi.fn(async (): Promise<string> => "deleted"),
  erase: vi.fn(async () => "leaving"),
  otp: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/lib/account-delete-client", () => ({
  readAccountDeletionEnabled: () => calls.enabled(),
  requestAccountDeletion: () => calls.request(),
}));
vi.mock("@/lib/device/erase", () => ({ eraseDeletedAccountHere: () => calls.erase() }));
vi.mock("@/lib/sign-in-client", async (original) => ({
  ...(await original<typeof import("@/lib/sign-in-client")>()),
  signInAuth: () => ({ signInWithOtp: calls.otp, verifyOtp: vi.fn(), signInWithPassword: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({ auth: { getSession: async () => ({ data: { session: { user: { email: "a@example.test" } } } }) } }),
}));

import DeleteAccountCard from "@/components/settings/DeleteAccountCard";
import { bindAccount, unbindAccount } from "@/lib/device/account";

let container: HTMLDivElement;

beforeEach(() => {
  unbindAccount();
  bindAccount("user-a");
  calls.enabled.mockReset().mockResolvedValue(true);
  calls.request.mockReset().mockResolvedValue("deleted");
  calls.erase.mockClear();
  calls.otp.mockClear();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => { container.remove(); });

async function render() {
  const root = createRoot(container);
  await act(async () => { root.render(<DeleteAccountCard />); });
  return root;
}

const buttonNamed = (name: string) =>
  [...container.ownerDocument.querySelectorAll("button")].find((b) => b.textContent === name);

async function type(value: string) {
  const input = container.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openAndConfirm() {
  await act(async () => { buttonNamed("Delete account")!.click(); });
  await type("DELETE");
  await act(async () => { container.querySelector("form")!.requestSubmit(); });
  await act(async () => { buttonNamed("Delete forever")!.click(); });
}

describe("DeleteAccountCard", () => {
  it("hidden: renders nothing while the server switch is off", async () => {
    calls.enabled.mockResolvedValue(false);
    const root = await render();
    expect(container.textContent).toBe("");
    await act(async () => { root.unmount(); });
  });

  it("explain: lists what is deleted, keeps Delete off until DELETE is typed, then erases this phone", async () => {
    const root = await render();
    await act(async () => { buttonNamed("Delete account")!.click(); });
    expect(container.textContent).toContain("It cannot be undone");
    const submit = container.querySelector<HTMLButtonElement>("form button[type=submit]")!;
    expect(submit.disabled).toBe(true);
    await type("DELETE");
    expect(submit.disabled).toBe(false);
    await act(async () => { container.querySelector("form")!.requestSubmit(); });
    expect(calls.request).not.toHaveBeenCalled();
    await act(async () => { buttonNamed("Delete forever")!.click(); });
    expect(calls.request).toHaveBeenCalledTimes(1);
    expect(calls.erase).toHaveBeenCalledTimes(1);
    await act(async () => { root.unmount(); });
  });

  it("reauth: a stale session sends a sign-in code through the app's route and asks for it", async () => {
    calls.request.mockResolvedValue("reauth_required");
    const root = await render();
    await openAndConfirm();
    expect(calls.otp).toHaveBeenCalledWith({ email: "a@example.test", create: false, next: "/settings" });
    expect(container.textContent).toContain("We sent a sign-in code to a@example.test");
    expect(calls.erase).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });
});
