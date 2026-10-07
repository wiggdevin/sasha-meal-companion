import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { resetAttemptLimits } from "@/app/sign-in/attempt-limit";
import { signInWithPassword, type PasswordAuth } from "@/app/sign-in/password";
import SignInPage from "@/app/sign-in/page";
import { PasswordSignInForm } from "@/components/PasswordSignInForm";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn() })),
}));

function auth(result: { message: string } | null): PasswordAuth & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    async signInWithPassword(credentials) {
      calls.push(credentials);
      return { error: result };
    },
  };
}

describe("signInWithPassword", () => {
  beforeEach(() => {
    resetAttemptLimits();
  });

  it("returns null and passes the trimmed email when Supabase accepts the password", async () => {
    const a = auth(null);
    expect(await signInWithPassword(a, "  devs@example.com ", "secret")).toBeNull();
    expect(a.calls).toEqual([{ email: "devs@example.com", password: "secret" }]);
  });

  it("returns one plain message when Supabase rejects the pair, without echoing the reason", async () => {
    const a = auth({ message: "Invalid login credentials" });
    const message = await signInWithPassword(a, "devs@example.com", "wrong");
    expect(message).toBe("That email and password did not match.");
    expect(message).not.toContain("Invalid");
  });

  it("refuses an empty email or password before calling Supabase", async () => {
    const a = auth(null);
    expect(await signInWithPassword(a, "", "secret")).toBe("Enter your email and password.");
    expect(await signInWithPassword(a, "devs@example.com", "")).toBe(
      "Enter your email and password.",
    );
    expect(await signInWithPassword(a, "devs@example.com", "   ")).toBe(
      "Enter your email and password.",
    );
    expect(a.calls).toEqual([]);
  });

  it("turns a thrown network error into a message instead of leaving the form stuck", async () => {
    const a: PasswordAuth = {
      async signInWithPassword() {
        throw new TypeError("Failed to fetch");
      },
    };
    expect(await signInWithPassword(a, "devs@example.com", "secret")).toBe(
      "Could not reach the sign-in service. Check your connection and try again.",
    );
  });

  it("locks out repeated wrong-password guesses for one email instead of asking Supabase forever", async () => {
    const a = auth({ message: "Invalid login credentials" });
    for (let i = 0; i < 5; i += 1) {
      await signInWithPassword(a, "devs@example.com", "wrong");
    }
    const message = await signInWithPassword(a, "devs@example.com", "wrong");
    expect(message).toMatch(/too many attempts/i);
    // The 6th guess never reached Supabase.
    expect(a.calls).toHaveLength(5);
  });
});

describe("PasswordSignInForm", () => {
  const markup = renderToStaticMarkup(
    <PasswordSignInForm email="devs@example.com" setEmail={() => {}} onSignedIn={() => {}} onUseLink={() => {}} />,
  );

  it("pairs each label with its field and uses the login autocomplete tokens", () => {
    expect(markup).toContain('for="email"');
    expect(markup).toMatch(/<input[^>]*id="email"[^>]*autocomplete="username"/i);
    expect(markup).toContain('for="password"');
    expect(markup).toMatch(/<input[^>]*id="password"[^>]*type="password"/);
    expect(markup).toMatch(/<input[^>]*id="password"[^>]*autocomplete="current-password"/i);
    expect(markup).toContain('value="devs@example.com"');
  });

  it("offers the way back to the email link and no error until one happens", () => {
    expect(markup).toContain("Back to the email link");
    expect(markup).toContain(">Sign in<");
    expect(markup).not.toContain('role="alert"');
  });
});

describe("SignInPage", () => {
  it("offers the password path next to the email link on first render", () => {
    const markup = renderToStaticMarkup(<SignInPage />);
    expect(markup).toContain("Send me a sign-in link");
    expect(markup).toContain("Use a password instead");
    expect(markup).not.toContain('type="password"');
  });
});
