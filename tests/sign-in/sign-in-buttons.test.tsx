// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The sign-in and gate screens use the button system (DESIGN.md §Buttons, PRD U4, stream F2 2026-10-04):
 * the panel's one action is the 52 px primary (`size="lg"`, full width), its pending state holds the
 * label's width behind three dots instead of swapping the words, and a disabled button fades to the
 * system's 40 % (the old recipe used 60 %). The small links under the form are ghost buttons.
 */
vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ replace: vi.fn() })) }));
vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({ auth: {} }),
  callbackRedirectUrl: () => "http://localhost/auth/callback",
  safePath: (path: string | null) => path ?? "/",
}));
vi.mock("@/app/sign-in/password", () => ({ signInWithPassword: vi.fn(() => new Promise(() => {})) }));

import SignInPage from "@/app/sign-in/page";
import { PasswordSignInForm } from "@/components/PasswordSignInForm";
import { SignInCodeForm } from "@/components/SignInCodeForm";
import { OtherTabCard, SignedOutCard, UnsavedChangesCard } from "@/components/GateShell";

afterEach(cleanup);

describe("sign-in buttons", () => {
  it("draws the send as the lg primary and the mode switches as ghost buttons", () => {
    render(<SignInPage />);
    const send = screen.getByRole("button", { name: "Send me a sign-in link" });
    expect(send.className.split(/\s+/)).toEqual(expect.arrayContaining(["btn", "btn-primary", "btn-lg", "btn-block"]));
    for (const name of ["Use a password instead", "New here? Create an account"]) {
      expect(screen.getByRole("button", { name }).className.split(/\s+/))
        .toEqual(expect.arrayContaining(["btn-ghost", "btn-sm"]));
    }
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).not.toMatch(/h-\[52px\]|btn-ink|pill-in|opacity-60/);
    }
  });

  it("keeps the password submit's label and width while it checks", async () => {
    render(<PasswordSignInForm email="a@example.com" setEmail={() => {}} onSignedIn={() => {}} onUseLink={() => {}} />);
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
    await act(async () => { fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!); });
    const busy = screen.getByRole("button", { name: "Sign in", busy: true }) as HTMLButtonElement;
    expect(busy.dataset.status).toBe("pending");
    expect(busy.disabled).toBe(true);
    expect(busy.querySelector(".btn-dots")).not.toBeNull();
  });

  it("opens the code field from a tertiary button, then offers the lg primary", () => {
    render(<SignInCodeForm onVerify={async () => null} />);
    const toggle = screen.getByRole("button", { name: "Use the code instead" });
    expect(toggle.className.split(/\s+/)).toEqual(expect.arrayContaining(["btn-tertiary", "btn-block"]));
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Use the code" }).className.split(/\s+/))
      .toEqual(expect.arrayContaining(["btn-primary", "btn-lg", "btn-block"]));
  });
});

describe("gate cards", () => {
  it("give each gate's one action the lg primary, links included", () => {
    for (const card of [<UnsavedChangesCard key="u" onRetry={() => {}} />, <OtherTabCard key="o" waiting={false} onUseHere={() => {}} />]) {
      expect(renderToStaticMarkup(card)).toMatch(/<button[^>]*class="btn btn-primary btn-lg btn-block mt-2"/);
    }
    expect(renderToStaticMarkup(<SignedOutCard href="/sign-in" />))
      .toMatch(/<a href="\/sign-in" class="btn btn-primary btn-lg btn-block mt-2">Sign in<\/a>/);
  });
});
