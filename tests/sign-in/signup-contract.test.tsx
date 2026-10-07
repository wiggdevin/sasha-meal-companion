// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetAttemptLimits } from "@/app/sign-in/attempt-limit";
import SignInPage from "@/app/sign-in/page";

type OtpArgs = { email: string; options: { emailRedirectTo: string; shouldCreateUser: boolean } };

const signInWithOtp = vi.fn(async (_args: OtpArgs) => ({ error: null as { message: string } | null }));
const verifyOtp = vi.fn(async (_args: unknown) => ({ error: { message: "Token has expired or is invalid" } }));

vi.mock("next/navigation", () => ({ useRouter: vi.fn(() => ({ replace: vi.fn() })) }));
vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => ({ auth: { signInWithOtp, verifyOtp } }),
  callbackRedirectUrl: (origin: string, next: string) => `${origin}/auth/callback?next=${next}`,
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
    expect(lastOtpArgs().options.shouldCreateUser).toBe(false);
  });

  it("goes back to sign-in from create mode and stops creating accounts", async () => {
    render(<SignInPage />);
    openCreateMode();
    fireEvent.click(screen.getByRole("button", { name: "Already have an account? Sign in" }));
    await submit("tester@example.com");
    expect(lastOtpArgs().options.shouldCreateUser).toBe(false);
  });

  // GPT-6 Sol review, slice 8: a send still in flight when the mode changes must not land in the
  // new mode. A sign-in for an unknown address resolves "Signups not allowed for otp"; had it
  // landed in create mode it would claim "We sent a link and a code" when nothing was sent.
  it("drops a send that resolves after the mode has changed", async () => {
    let resolveSend: (value: { error: { message: string } | null }) => void = () => {};
    signInWithOtp.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
    render(<SignInPage />);
    await submit("no-account@example.com");
    openCreateMode();
    await act(async () => resolveSend({ error: { message: "Signups not allowed for otp" } }));
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

  it("sends shouldCreateUser true with the trimmed address and the callback redirect", async () => {
    render(<SignInPage />);
    openCreateMode();
    await submit("  new-person@example.com ");
    expect(lastOtpArgs()).toEqual({
      email: "new-person@example.com",
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/`,
        shouldCreateUser: true,
      },
    });
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
    signInWithOtp.mockResolvedValueOnce({ error: { message: "Signups not allowed for otp" } });
    render(<SignInPage />);
    openCreateMode();
    await submit("new-person@example.com");
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use the code instead" })).toBeNull();
  });

  it("tells a rate-limited person to wait instead of the generic failure", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { message: "Email rate limit exceeded" } });
    render(<SignInPage />);
    openCreateMode();
    await submit("new-person@example.com");
    expect(await screen.findByText("Too many tries. Wait a minute, then try again.")).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
  });
});

// Narrowed per PR #246 review r2, finding 3: this closes enumeration in the app's own UI only.
// The public Supabase Auth REST endpoint can still distinguish a known address from an unknown
// one on a direct request outside this UI — documented as a residual in the plan and PR body,
// not claimed as solved here.
describe("no account enumeration in the sign-in UI (PR #246 review r1 finding 3)", () => {
  beforeEach(reset);

  const sentCopy = "If this email has an account, we sent a sign-in link. Check your inbox.";

  it("shows the neutral sent copy for an address that has an account", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: null });
    render(<SignInPage />);
    await submit("has-account@example.com");
    expect(screen.getByText(sentCopy)).toBeTruthy();
  });

  it("shows the same neutral sent copy for an address with no account", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { message: "Signups not allowed for otp" } });
    render(<SignInPage />);
    await submit("no-account@example.com");
    expect(screen.getByText(sentCopy)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
  });

  it("still shows the generic error for a failure unrelated to account existence", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: { message: "Email rate limit exceeded" } });
    render(<SignInPage />);
    await submit("someone@example.com");
    expect(screen.getByText(FAILED)).toBeTruthy();
  });
});
