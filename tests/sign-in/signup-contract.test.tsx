// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetAttemptLimits } from "@/app/sign-in/attempt-limit";
import SignInPage from "@/app/sign-in/page";

type OtpArgs = { email: string; create: boolean; next: string };

const signInWithOtp = vi.fn(async (_args: OtpArgs) => ({ error: null as { code: string } | null }));
const verifyOtp = vi.fn(async (_args: unknown) => ({ error: { code: "invalid_code" } }));

vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ replace: vi.fn() })) }));
// W052: the screen talks to the app's IP-limited routes, never to Supabase Auth directly. The
// server-side half of this contract (the redirect, the masking) is tests/server/sign-in-limits.test.ts.
vi.mock("@/lib/sign-in-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sign-in-client")>();
  return {
    LIMITED_CODES: actual.LIMITED_CODES,
    UNAVAILABLE_CODES: actual.UNAVAILABLE_CODES,
    signInAuth: () => ({ signInWithOtp, verifyOtp }),
  };
});
vi.mock("@/lib/supabase/client", () => ({
  safePath: (p: string | null) => p ?? "/",
}));

const FAILED = "That did not send. Check the address and try again.";

function openCreateMode(): void {
  fireEvent.click(screen.getByRole("button", { name: "New here? Create an account" }));
}

async function submit(address: string): Promise<void> {
  const email = screen.getByRole("textbox");
  fireEvent.change(email, { target: { value: address } });
  fireEvent.submit(email.closest("form")!);
  await waitFor(() => expect(signInWithOtp).toHaveBeenCalledTimes(1));
}

function lastOtpArgs(): OtpArgs {
  return signInWithOtp.mock.calls[0][0];
}

function reset(): void {
  cleanup();
  // mockReset, not mockClear: a queued mockResolvedValueOnce a failed test never consumed must
  // not leak into the next test.
  signInWithOtp.mockReset().mockResolvedValue({ error: null });
  verifyOtp.mockClear();
  resetAttemptLimits();
}

// Sign-in and sign-up contract (docs/decisions/2026-09-25-self-serve-signup.md): plain sign-in
// never creates an account, so a mistyped address cannot mint one; only the explicit
// "Create an account" path asks Supabase to create a user.
describe("sign in never creates an account", () => {
  beforeEach(reset);

  it("sends the code or link only to an existing account", async () => {
    render(<SignInPage />);
    await submit(" tester@example.com ");
    expect(lastOtpArgs().email).toBe("tester@example.com");
    expect(lastOtpArgs().create).toBe(false);
  });

  it("goes back to sign-in from create mode and stops creating accounts", async () => {
    render(<SignInPage />);
    openCreateMode();
    fireEvent.click(screen.getByRole("button", { name: "Already have an account? Sign in" }));
    await submit("tester@example.com");
    expect(lastOtpArgs().create).toBe(false);
  });

  // GPT-6 Sol review, slice 8: a send still in flight when the mode changes must not land in the
  // new mode. A sign-in for an unknown address answers like a sent one (the server masks it); had
  // it landed in create mode it would claim "We sent a link and a code" when nothing was sent.
  it("drops a send that resolves after the mode has changed", async () => {
    let resolveSend: (value: { error: { code: string } | null }) => void = () => {};
    signInWithOtp.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
    render(<SignInPage />);
    await submit("no-account@example.com");
    openCreateMode();
    await act(async () => resolveSend({ error: null }));
    expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
    expect(screen.queryByText(/we sent/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Use the code instead" })).toBeNull();
  });
});

describe("create an account", () => {
  beforeEach(reset);

  it("shows create-account copy on the heading and the button", () => {
    render(<SignInPage />);
    openCreateMode();
    expect(screen.getByRole("heading", { name: "Create your account." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use a password instead" })).toBeNull();
  });

  it("asks the server to create the account, with the trimmed address and the next path", async () => {
    render(<SignInPage />);
    openCreateMode();
    await submit("  new-person@example.com ");
    expect(lastOtpArgs()).toEqual({ email: "new-person@example.com", create: true, next: "/" });
  });

  it("shows the code form after the send, and the code is checked as an email OTP", async () => {
    render(<SignInPage />);
    openCreateMode();
    await submit("new-person@example.com");
    fireEvent.click(await screen.findByRole("button", { name: "Use the code instead" }));
    const code = screen.getByLabelText("Code from the email");
    fireEvent.change(code, { target: { value: "12345678" } });
    fireEvent.submit(code.closest("form")!);
    await waitFor(() => expect(verifyOtp).toHaveBeenCalledTimes(1));
    expect(verifyOtp.mock.calls[0][0]).toEqual({
      email: "new-person@example.com", token: "12345678", type: "email",
    });
  });

  it("shows the generic failure when sign-up is refused, never the sent screen", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { code: "send_failed" } });
    render(<SignInPage />);
    openCreateMode();
    await submit("new-person@example.com");
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use the code instead" })).toBeNull();
  });

  it("tells a rate-limited person to wait instead of the generic failure", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { code: "auth_rate_limited" } });
    render(<SignInPage />);
    openCreateMode();
    await submit("new-person@example.com");
    expect(await screen.findByText("Too many tries. Wait a few minutes, then try again.")).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});

// Narrowed per PR #246 review r2, finding 3: this closes enumeration in the app's own UI only.
// The public Supabase Auth REST endpoint can still distinguish a known address from an unknown
// one on a direct request outside this UI — documented as a residual in the plan and PR body,
// not claimed as solved here.
describe("no account enumeration in the sign-in UI (PR #246 review r1 finding 3)", () => {
  beforeEach(reset);

  // The sent copy names the typed address (UI audit 2026-10-18 §9) and says nothing about whether it
  // has an account. textContent, since the address is its own element inside the line.
  const sentCopy = (address: string): string =>
    `If ${address} has an account, we sent a sign-in link. Check your inbox.`;

  it("shows the neutral sent copy for an address that has an account", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: null });
    render(<SignInPage />);
    await submit("has-account@example.com");
    expect(screen.getByRole("status").textContent).toBe(sentCopy("has-account@example.com"));
  });

  it("shows the same neutral sent copy for an address with no account", async () => {
    // The server answers an unknown address exactly like a real send (otpFailure).
    signInWithOtp.mockResolvedValueOnce({ error: null });
    render(<SignInPage />);
    await submit("no-account@example.com");
    expect(screen.getByRole("status").textContent).toBe(sentCopy("no-account@example.com"));
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it("still shows the generic error for a failure unrelated to account existence", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { code: "send_failed" } });
    render(<SignInPage />);
    await submit("someone@example.com");
    expect(screen.getByText(FAILED)).toBeTruthy();
  });

  // W052: the app's own limiter counts this device's IP, never an address, so saying "wait" tells
  // nobody whether the address has an account.
  it("tells a person the app's IP limiter stopped to wait", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { code: "rate_limited" } });
    render(<SignInPage />);
    await submit("someone@example.com");
    expect(screen.getByText("Too many tries. Wait a few minutes, then try again.")).toBeTruthy();
  });

  // UI audit 2026-10-18 §9: nothing judged the address, so the screen never says to check it.
  it.each(["offline", "auth_unavailable", "rate_limit_unavailable", "failed", "internal"])(
    "says the service could not be reached on %s, never to check the address",
    async (code) => {
      signInWithOtp.mockResolvedValueOnce({ error: { code } });
      render(<SignInPage />);
      await submit("someone@example.com");
      expect(screen.getByText("Could not reach the sign-in service. Check your connection and try again.")).toBeTruthy();
      expect(screen.queryByText(FAILED)).toBeNull();
    },
  );

  it("moves focus to the sent line so it is announced and focus is not lost", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: null });
    render(<SignInPage />);
    await submit("someone@example.com");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
  });
});
