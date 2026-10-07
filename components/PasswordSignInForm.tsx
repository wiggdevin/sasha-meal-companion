"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/client";
import { signInWithPassword } from "@/app/sign-in/password";
import Button from "@/components/ui/Button";

type Stage = "idle" | "checking" | "error";

type PasswordSignInFormProps = {
  email: string;
  setEmail: (value: string) => void;
  /** Called once the session cookie is set; the caller redirects. */
  onSignedIn: () => void;
  onUseLink: () => void;
};

/** Email plus password, the alternative to the emailed link on the sign-in screen. */
export function PasswordSignInForm({ email, setEmail, onSignedIn, onUseLink }: PasswordSignInFormProps) {
  const [password, setPassword] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [message, setMessage] = useState("");

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setStage("checking");
    const error = await signInWithPassword(browserClient().auth, email, password);
    if (error) {
      setStage("error");
      setMessage(error);
      return;
    }
    onSignedIn();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3.5">
      <PasswordFields email={email} setEmail={setEmail} password={password} setPassword={setPassword} />
      <Button type="submit" variant="primary" size="lg" block status={stage === "checking" ? "pending" : undefined}>
        Sign in
      </Button>
      {stage === "error" && (
        <p role="alert" className="text-tiny text-alert">
          {message}
        </p>
      )}
      <Button variant="ghost" size="sm" className="self-center" onClick={onUseLink}>
        Back to the email link
      </Button>
    </form>
  );
}

type PasswordFieldsProps = {
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
};

const fieldClass =
  "well tap h-[52px] w-full rounded-[16px] bg-transparent px-4 text-body-sm font-light text-charcoal outline-none placeholder:text-muted";

function PasswordFields({ email, setEmail, password, setPassword }: PasswordFieldsProps) {
  return (
    <>
      <label htmlFor="email" className=" pl-1.5 text-tiny text-graphite">
        Email
      </label>
      <input
        id="email"
        type="email"
        inputMode="email"
        autoComplete="username"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className={fieldClass}
      />
      <label htmlFor="password" className=" pl-1.5 text-tiny text-graphite">
        Password
      </label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className={fieldClass}
      />
    </>
  );
}
