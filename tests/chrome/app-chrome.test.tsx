import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AppChrome from "@/components/AppChrome";
import { CapabilitiesProvider } from "@/components/CapabilitiesProvider";
import type { AppCapabilities } from "@/lib/capabilities";

const navigation = vi.hoisted(() => ({ pathname: "/", push: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}));

vi.mock("@/lib/health/capability-client", () => ({
  useBodyCapability: () => "unknown",
}));

const ON: AppCapabilities = { coach: true, scan: true, captureMethods: ["photo"] };

function renderChrome(pathname: string, capabilities: AppCapabilities = ON): string {
  navigation.pathname = pathname;
  return renderToStaticMarkup(
    <CapabilitiesProvider value={capabilities}><AppChrome /></CapabilitiesProvider>,
  );
}

function expectChrome(markup: string): void {
  expect(markup).toContain('aria-label="Primary"');
  expect(
    markup.includes('href="/coach"') || markup.includes('aria-label="Ask Sasha"'),
  ).toBe(true);
  expect(markup).not.toContain('aria-label="Open Sasha"');
}

function expectNoChrome(markup: string): void {
  expect(markup).not.toContain('aria-label="Primary"');
  expect(markup).not.toContain('aria-label="Open Sasha"');
}

describe("AppChrome route allowlist", () => {
  it.each(["/", "/body", "/body/history", "/foods", "/foods/recipes", "/coach", "/coach/thread/1", "/settings", "/settings/profile"])(
    "shows the persistent dock on %s",
    (pathname) => expectChrome(renderChrome(pathname)),
  );

  it.each(["/sign-in", "/sign-in/help", "/onboarding", "/onboarding/profile", "/week", "/foodstuff"])(
    "shows no app chrome on %s",
    (pathname) => expectNoChrome(renderChrome(pathname)),
  );

  it("keeps Sasha's bubble in the fixed dock when coach is off", () => {
    const markup = renderChrome("/foods", { ...ON, coach: false });
    expect(markup).toContain('aria-label="Primary"');
    expect(markup).toContain('data-dock-assistant="true"');
    expect(markup).toContain('aria-label="Ask Sasha"');
  });
});
