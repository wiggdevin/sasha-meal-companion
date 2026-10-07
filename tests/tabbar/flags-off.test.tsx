import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TabBar from "@/components/TabBar";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/"),
  useRouter: () => ({ push: vi.fn() }),
}));

function tabCount(markup: string): number {
  return (markup.match(/<a /g) ?? []).length;
}

describe("TabBar with NEXT_PUBLIC_COACH_ENABLED unset", () => {
  const markup = renderToStaticMarkup(<TabBar />);

  it("keeps four stable capsule destinations and the Sasha bubble beside them", () => {
    expect(tabCount(markup)).toBe(4);
    for (const href of ['href="/"', 'href="/body"', 'href="/foods"', 'href="/settings"']) {
      expect(markup).toContain(href);
    }
    expect(markup).not.toContain('href="/coach"');
    expect(markup).toContain('data-dock-assistant="true"');
    expect(markup.indexOf('href="/settings"')).toBeLessThan(markup.indexOf('data-dock-assistant="true"'));
  });

  it("shows text only for the selected destination", () => {
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain(">Today</span>");
    expect(markup).not.toContain(">Body</span>");
    expect(markup).not.toContain(">Foods</span>");
    expect(markup).not.toContain(">Settings</span>");
  });
});

describe("TabBar with NEXT_PUBLIC_COACH_ENABLED set", () => {
  it("does not change the dock geometry", async () => {
    vi.stubEnv("NEXT_PUBLIC_COACH_ENABLED", "1");
    vi.resetModules();
    const { default: EnabledTabBar } = await import("@/components/TabBar");
    const markup = renderToStaticMarkup(<EnabledTabBar />);
    vi.unstubAllEnvs();

    expect(tabCount(markup)).toBe(4);
    expect(markup).toContain('data-dock-assistant="true"');
  });
});
