/**
 * The onboarding v2 flag gate (`app/onboarding/page.tsx`): default off renders the existing form,
 * and only the exact value "1" switches to the new shell — any other value (unset, "0", "true",
 * garbage) keeps the fallback reachable, per the brief's "dark behind the flag, form stays the
 * fallback" rule. The two real components are mocked out: this test is about the routing decision,
 * not about re-asserting what each component itself renders (OnboardingDock.test.tsx,
 * ConversationalOnboarding.test.tsx and the existing onboarding card specs already do that).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/Onboarding/ConversationalOnboarding", () => ({
  default: () => createElement("div", { "data-testid": "onboarding-v2" }),
}));
vi.mock("@/components/Onboarding/OnboardingFlow", () => ({
  default: () => createElement("div", { "data-testid": "onboarding-form" }),
}));

const ORIGINAL = process.env.NEXT_PUBLIC_CHAT_ONBOARDING;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_CHAT_ONBOARDING;
  else process.env.NEXT_PUBLIC_CHAT_ONBOARDING = ORIGINAL;
  vi.resetModules();
});

async function renderPage(): Promise<string> {
  const { default: OnboardingPage } = await import("@/app/onboarding/page");
  return renderToStaticMarkup(createElement(OnboardingPage));
}

describe("the onboarding v2 flag gate", () => {
  it("defaults to the existing form when the flag is unset", async () => {
    delete process.env.NEXT_PUBLIC_CHAT_ONBOARDING;
    vi.resetModules();
    const markup = await renderPage();
    expect(markup).toContain("onboarding-form");
    expect(markup).not.toContain("onboarding-v2");
  });

  it.each(["0", "true", "garbage", ""])("keeps the form reachable for an unrecognised value %j", async (value) => {
    process.env.NEXT_PUBLIC_CHAT_ONBOARDING = value;
    vi.resetModules();
    const markup = await renderPage();
    expect(markup).toContain("onboarding-form");
  });

  it("switches to the conversational shell only when the flag is exactly \"1\"", async () => {
    process.env.NEXT_PUBLIC_CHAT_ONBOARDING = "1";
    vi.resetModules();
    const markup = await renderPage();
    expect(markup).toContain("onboarding-v2");
    expect(markup).not.toContain("onboarding-form");
  });
});
