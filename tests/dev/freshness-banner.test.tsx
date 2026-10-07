// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DevFreshnessBanner from "@/components/DevFreshnessBanner";

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("DevFreshnessBanner", () => {
  it("flows in the document so it never covers the header", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_DEV_FRESHNESS", JSON.stringify({ branch: "feat/x", behind: 3 }));
    render(<DevFreshnessBanner />);
    const banner = screen.getByRole("alert");
    expect(banner.className).not.toMatch(/\b(fixed|absolute|sticky)\b/);
    expect(banner.textContent).toContain("feat/x is 3 commits behind main");
  });
  it("renders nothing outside next dev", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_DEV_FRESHNESS", JSON.stringify({ branch: "feat/x", behind: 3 }));
    const { container } = render(<DevFreshnessBanner />);
    expect(container.innerHTML).toBe("");
  });
});
