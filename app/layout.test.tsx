import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import RootLayout, { metadata } from "./layout";

// lib/capabilities is server-only; the layout reads it once at render.
vi.mock("server-only", () => ({}));
// next/font is compiled by Next; outside it the module is empty, so the two families are stubbed.
vi.mock("next/font/google", () => ({
  Fraunces: () => ({ variable: "font-display-face", className: "", style: {} }),
  Plus_Jakarta_Sans: () => ({ variable: "font-text-face", className: "", style: {} }),
}));
// AppChrome reads the pathname for its tab allowlist; there is no app router in a static render.
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/components/AuthGate", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="auth-gate">
      {children}
      <span data-testid="gate-end"></span>
    </div>
  ),
}));

vi.mock("@/components/TabBar", () => ({
  default: () => <nav data-testid="tab-bar" />,
}));

describe("RootLayout", () => {
  // The gate wraps BOTH the children and the chrome: AuthGate renders a shell instead of
  // children while the account's disposition resolves or when signed out, so the tab bar
  // is inside it (b4bfce5) and no longer visible to a signed-out visitor.
  it("wraps the children and the chrome in AuthGate; the children render first", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <div data-testid="page-content">hello</div>
      </RootLayout>,
    );

    const gateOpen = markup.indexOf('data-testid="auth-gate"');
    const gateClose = markup.indexOf('data-testid="gate-end"');
    const childIndex = markup.indexOf('data-testid="page-content"');
    const tabBarIndex = markup.indexOf('data-testid="tab-bar"');

    expect(gateOpen).toBeGreaterThan(-1);
    expect(childIndex).toBeGreaterThan(gateOpen);
    expect(childIndex).toBeLessThan(gateClose);
    expect(tabBarIndex).toBeGreaterThan(childIndex);
    expect(tabBarIndex).toBeLessThan(gateClose);
  });

  it("keeps a light status bar with dark icons over the oat Harvest ground", () => {
    expect(metadata.appleWebApp).toMatchObject({ statusBarStyle: "default" });
  });
});
