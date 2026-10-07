"use client";

import { useRef, useState } from "react";
import { browserClient, callbackRedirectUrl, safePath } from "@/lib/supabase/client";
import { SignInCodeForm } from "@/components/SignInCodeForm";
import { PasswordSignInForm } from "@/components/PasswordSignInForm";
import { verifyOtpCode } from "@/app/sign-in/otp";
import { APP_NAME, ASSISTANT_EXPANSION } from "@/lib/brand";
import Button from "@/components/ui/Button";

type Stage = "idle" | "sending" | "sent" | "error";
type Mode = "link" | "password" | "create";

const SEND_FAILED = "That did not send. Check the address and try again.";
const RATE_LIMITED = "Too many tries. Wait a minute, then try again.";

type SendError = { message: string; status?: number };

/**
 * The message a failed send shows, or null when the screen should move on to "sent".
 *
 * Sign in (no account enumeration, PR #246 review r1, finding 3): with shouldCreateUser: false,
 * Supabase answers an address with no account the same way it answers a signup attempt —
 * "Signups not allowed for otp" — so that specific error gets the same "sent" screen as a real
 * send. Any other error (rate limit, network) still shows the generic failure.
 *
 * Create: nothing to hide, since a known address simply gets a sign-in email. A rate limit says
 * to wait; every other error, including sign-up being switched off, is the generic failure.
 */
function sendErrorMessage(mode: Mode, error: SendError | null): string | null {
  if (!error) return null;
  if (mode !== "create") return error.message === "Signups not allowed for otp" ? null : SEND_FAILED;
  const limited = error.status === 429 || /rate limit|only request this after/i.test(error.message);
  return limited ? RATE_LIMITED : SEND_FAILED;
}

function currentNext(): string {
  return safePath(new URLSearchParams(window.location.search).get("next"));
}

/**
 * app/auth/callback/route.ts sends the browser back here with
 * ?error=exchange_failed whenever exchangeCodeForSession fails — the
 * documented normal case on iOS Safari vs. the installed PWA, and on any
 * reused/expired link. Read it once on load so nobody is left on a blank
 * card with no hint the link failed.
 */
function callbackErrorMessage(): string {
  if (typeof window === "undefined") return "";
  const error = new URLSearchParams(window.location.search).get("error");
  if (error !== "exchange_failed") return "";
  return "That link didn't work — try again, or use the code from the email.";
}

/**
 * Leaves /sign-in with a full document load once the session exists.
 *
 * What was observed: after a password grant the server accepted (POST /token
 * 200), `router.replace` did not leave /sign-in, and the button sat on
 * "Signing in…" because the form clears that stage only on error. Why the
 * client router never committed is not established — a cookie @supabase/ssr
 * had not finished writing, a cached RSC response, and the service worker are
 * all consistent with the logs, and it was not reproduced.
 *
 * A document load side-steps all three: the browser re-sends the whole cookie
 * jar and middleware.ts decides, instead of the client router. `replace`, not
 * `assign`, so /sign-in does not stay in history behind the signed-in app.
 */
function leaveSignIn(): void {
  window.location.replace(currentNext());
}

/**
 * One email field, one button, then "check your email" (spec "Client changes").
 * NeuForm shell/surface card on the paper ground (controller Ruling R1).
 * Split into small sub-components to keep SignInPage itself under the
 * 50-line function limit (00-contracts.md §8) while keeping the same markup.
 *
 * No name on the screen (PRD R1): the heading greets whoever is signing in.
 */
export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [callbackError] = useState<string>(callbackErrorMessage);
  const [stage, setStage] = useState<Stage>(callbackError ? "error" : "idle");
  const [message, setMessage] = useState(callbackError);
  const [mode, setMode] = useState<Mode>("link");
  // Bumped on every send and every mode switch, so a send still in flight when the mode changes
  // cannot land in the new mode and show its "sent" copy for an email that was never sent.
  const sendId = useRef(0);

  async function send(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const address = email.trim();
    if (address.length === 0) return;
    setStage("sending");
    const id = ++sendId.current;
    const next = currentNext();
    const { error } = await browserClient().auth.signInWithOtp({
      email: address,
      options: {
        emailRedirectTo: callbackRedirectUrl(window.location.origin, next),
        // Sign in never creates an account, so a mistyped address cannot mint one. Only the
        // explicit "Create an account" mode does (docs/decisions/2026-09-25-self-serve-signup.md,
        // superseding Phase 9 §1.4 step 8 for that path only).
        shouldCreateUser: mode === "create",
      },
    });
    if (id !== sendId.current) return;
    const failure = sendErrorMessage(mode, error);
    if (failure) {
      setStage("error");
      setMessage(failure);
      return;
    }
    setStage("sent");
  }

  function switchMode(to: Mode): void {
    sendId.current += 1;
    setMode(to);
    setStage("idle");
    setMessage("");
  }

  async function verifyCode(code: string): Promise<string | null> {
    const error = await verifyOtpCode(browserClient().auth, email, code);
    if (error) return error;
    leaveSignIn();
    return null;
  }

  return (
    <main className="flex min-h-dvh flex-col justify-center gap-6 px-5 text-charcoal">
      <SignInHeading creating={mode === "create"} />

      <div className="shell">
        <div className="surface flex flex-col gap-3.5 p-6">
          {stage === "sent" ? (
            <>
              <SentMessage creating={mode === "create"} />
              <SignInCodeForm onVerify={verifyCode} />
              <Button variant="ghost" size="sm" className="self-center" onClick={() => setStage("idle")}>
                Back
              </Button>
            </>
          ) : mode === "password" ? (
            <PasswordSignInForm
              email={email}
              setEmail={setEmail}
              onSignedIn={leaveSignIn}
              onUseLink={() => switchMode("link")}
            />
          ) : (
            <>
              <SignInForm
                email={email} setEmail={setEmail} stage={stage} message={message} onSubmit={send}
                submitLabel={mode === "create" ? "Create account" : "Send me a sign-in link"}
              />
              <ModeLinks mode={mode} onSwitch={switchMode} />
            </>
          )}
        </div>
      </div>

      <p className="ground-muted ts text-center text-tiny text-graphite">Only you see your data</p>
    </main>
  );
}

function SignInHeading({ creating }: { creating: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="ground-muted text-tiny uppercase tracking-[0.08em]">{APP_NAME}</p>
      <p className="ground-muted text-tiny">{ASSISTANT_EXPANSION}</p>
      <h1 className="ground text-display font-light leading-none tracking-tight">
        {creating ? "Create your account." : "Welcome back."}
      </h1>
      <p className="ground-muted text-caption font-normal">
        {creating
          ? "Enter your email. We send a link and a code to finish setting up."
          : "Sign in once and stay signed in. Use the link in the email, or your password."}
      </p>
    </div>
  );
}

function SentMessage({ creating }: { creating: boolean }) {
  // Sign in: neutral copy, true for both cases (PR #246 review r3, finding 2): an unknown address
  // never actually gets a link — Supabase refuses the request server-side — so the old "Check
  // your email. Tap the link…" claim was false for it. This wording holds either way.
  // Create: every address gets an email (a known one simply gets a sign-in email).
  return (
    <p className="text-body-sm font-normal text-graphite">
      {creating
        ? "We sent a link and a code to this email. Check your inbox to finish."
        : "If this email has an account, we sent a sign-in link. Check your inbox."}
    </p>
  );
}

/** The small links under the email form: password or create account, or back to sign in. Ghost
 *  buttons (DESIGN.md §Buttons): words in the card, a wash under the finger, never a second fill
 *  competing with the primary above them. */
function ModeLinks({ mode, onSwitch }: { mode: Mode; onSwitch: (to: Mode) => void }) {
  if (mode === "create") {
    return (
      <Button variant="ghost" size="sm" className="self-center" onClick={() => onSwitch("link")}>
        Already have an account? Sign in
      </Button>
    );
  }
  return (
    <div className="flex flex-col items-center gap-2">
      <Button variant="ghost" size="sm" onClick={() => onSwitch("password")}>
        Use a password instead
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onSwitch("create")}>
        New here? Create an account
      </Button>
    </div>
  );
}

type SignInFormProps = {
  email: string;
  setEmail: (value: string) => void;
  stage: Stage;
  message: string;
  onSubmit: (e: React.FormEvent) => void;
  submitLabel: string;
};

function SignInForm({ email, setEmail, stage, message, onSubmit, submitLabel }: SignInFormProps) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3.5">
      <label htmlFor="email" className=" pl-1.5 text-tiny text-graphite">
        Email
      </label>
      <input
        id="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="well tap h-[52px] w-full rounded-[16px] bg-transparent px-4 text-body-sm font-normal text-charcoal outline-none placeholder:text-muted"
      />
      {/* The panel's one primary (DESIGN.md §Buttons, lg): while the send is in flight its dots hold
          the label's width, so the card never jumps. */}
      <Button type="submit" variant="primary" size="lg" block status={stage === "sending" ? "pending" : undefined}>
        {submitLabel}
      </Button>
      {stage === "error" && <p role="alert" className="text-tiny text-alert">{message}</p>}
    </form>
  );
}
