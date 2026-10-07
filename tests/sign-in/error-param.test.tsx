import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SignInPage from "@/app/sign-in/page";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ replace: vi.fn() })),
}));

/**
 * app/auth/callback/route.ts sends the browser to
 * /sign-in?error=exchange_failed whenever exchangeCodeForSession fails —
 * the documented normal case on iOS Safari vs. the installed PWA, and on
 * any reused/expired link. Without this, Sasha lands on a blank sign-in
 * card with no hint the link failed or that the code field is the
 * workaround.
 */
function renderWithSearch(search: string): string {
  const realWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    location: { search },
  };
  try {
    return renderToStaticMarkup(<SignInPage />);
  } finally {
    (globalThis as { window?: unknown }).window = realWindow;
  }
}

describe("SignInPage error param", () => {
  it("shows a message when the magic-link callback redirects with ?error=exchange_failed", () => {
    const markup = renderWithSearch("?error=exchange_failed");
    expect(markup).toContain("That link didn&#x27;t work");
    expect(markup).toContain("use the code from the email");
  });

  it("stays quiet when there is no error param", () => {
    const markup = renderWithSearch("");
    expect(markup).not.toContain("That link didn&#x27;t work");
  });
});
