"use client";

import { useState } from "react";
import { isValidCode, normalizeCode, toCodeInput } from "@/app/sign-in/code";
import Button from "@/components/ui/Button";

type Stage = "collapsed" | "entering" | "checking" | "error";

type SignInCodeFormProps = {
  /** Verifies the code against Supabase. Returns an error message on
   * failure, or null on success (the caller handles the redirect). */
  onVerify: (code: string) => Promise<string | null>;
  /** Show the code field at once (a re-auth step, where the code is the only way on). */
  startOpen?: boolean;
};

/**
 * The typed one-time-code fallback under "check your email" (Phase 0 Lane B
 * open question 4): on iOS the magic link opens in Safari rather than the
 * installed PWA, so its session cookie can land in the wrong cookie store.
 * Typing the code Supabase emails alongside the link verifies the OTP
 * directly in the PWA's own browser context instead.
 *
 * The field accepts 6 to 8 digits because this project's Supabase mailer
 * sends 8 (mailer_otp_length, matching app/sign-in/code.ts). A 6-digit cap
 * here silently refused every real code before it could be submitted.
 */
export function SignInCodeForm({ onVerify, startOpen = false }: SignInCodeFormProps) {
  const [stage, setStage] = useState<Stage>(startOpen ? "entering" : "collapsed");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");

  if (stage === "collapsed") {
    return <CodeToggle onOpen={() => setStage("entering")} />;
  }

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const clean = normalizeCode(code);
    if (!isValidCode(clean)) {
      setStage("error");
      setMessage("Enter the code from the email.");
      return;
    }
    setStage("checking");
    const error = await onVerify(clean);
    if (error) {
      setStage("error");
      setMessage(error);
      return;
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5">
      <label htmlFor="otp" className=" pl-1.5 text-tiny text-graphite">
        Code from the email
      </label>
      <input
        id="otp"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(toCodeInput(e.target.value))}
        placeholder="12345678"
        className="well tap h-[52px] w-full rounded-[16px] bg-transparent px-4 text-body-sm font-normal text-charcoal outline-none placeholder:text-muted"
      />
      <Button type="submit" variant="primary" size="lg" block status={stage === "checking" ? "pending" : undefined}>
        Use the code
      </Button>
      {stage === "error" && <p role="alert" className="text-tiny text-alert">{message}</p>}
    </form>
  );
}

/** The quieter neighbour of the sign-in card's actions (tertiary): it opens the code field. */
function CodeToggle({ onOpen }: { onOpen: () => void }) {
  return <Button variant="tertiary" block onClick={onOpen}>Use the code instead</Button>;
}
