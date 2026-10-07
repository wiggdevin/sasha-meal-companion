/**
 * The dock reserves all four capsule destinations and the Sasha bubble on every render. Body
 * capability can change the page's content, but it must never change dock geometry during hydration.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import TabBar from "@/components/TabBar";

vi.mock("next/navigation", () => ({ usePathname: vi.fn(() => "/"), useRouter: () => ({ push: vi.fn() }) }));

const LINKS = ['href="/"', 'href="/body"', 'href="/foods"', 'href="/settings"'];

describe("TabBar's first render stays geometry-stable", () => {
  it("always renders the four fixed destinations and the Sasha bubble", () => {
    const markup = renderToStaticMarkup(<TabBar />);
    for (const href of LINKS) expect(markup).toContain(href);
    expect(markup.match(/<a /g)).toHaveLength(4);
    expect(markup).toContain('data-dock-assistant="true"');
  });

  it("does not vary when a caller passes a Body capability result", () => {
    const serverMarkup = renderToStaticMarkup(<TabBar />);
    const enabledMarkup = renderToStaticMarkup(<TabBar bodyCapability="enabled" />);
    expect(enabledMarkup).toBe(serverMarkup);
  });
});
