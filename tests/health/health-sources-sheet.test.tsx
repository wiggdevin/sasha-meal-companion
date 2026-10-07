/**
 * Finding #86: the ingest token sheet's "Copy it now — it is shown once" button fires
 * `void navigator.clipboard.writeText(issued)` and reports nothing back — a denied or
 * rejected write looks identical to a successful one, so a rejected copy can be closed
 * away and the one-time token lost for good. `copyIssuedToken` is the extracted async
 * step so the resolve-vs-reject branch is directly testable without a DOM, and
 * `CopyTokenButton` is the small presentational split (same shape as WaterCard /
 * WaterCardView) so each status label is checkable on its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { copyIssuedToken, CopyTokenButton,
  healthSourceLabel } from "@/components/HealthSourcesSheet";

describe("copyIssuedToken", () => {
  it("resolves 'copied' once the clipboard write succeeds", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await expect(copyIssuedToken("tok-123")).resolves.toBe("copied");
  });

  it("resolves 'error' instead of leaving the reject silent", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await expect(copyIssuedToken("tok-123")).resolves.toBe("error");
  });
});

describe("CopyTokenButton", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it("shows a neutral label before she has tapped it", () => {
    const markup = renderToStaticMarkup(<CopyTokenButton status="idle" onCopy={() => {}} />);
    expect(markup).toContain(">Copy<");
  });

  it("confirms success so a one-time token isn't assumed captured by mistake", () => {
    const markup = renderToStaticMarkup(<CopyTokenButton status="copied" onCopy={() => {}} />);
    expect(markup).toContain("Copied");
  });

  it("tells her to copy it by hand when the clipboard write failed", () => {
    const markup = renderToStaticMarkup(<CopyTokenButton status="error" onCopy={() => {}} />);
    expect(markup).toContain("copy manually");
    expect(markup).toContain("Couldn");
  });
});

describe("healthSourceLabel", () => {
  it("distinguishes Shortcut and Health Auto Export, including revoked rows", () => {
    expect(healthSourceLabel({ id: "shortcut", kind: "apple_health_shortcut",
      device_label: "Apple Watch", last_received_at: null, revoked: false }))
      .toBe("Apple Health Shortcut");
    expect(healthSourceLabel({ id: "hae", kind: "health_auto_export",
      device_label: "Health Auto Export", last_received_at: null, revoked: true }))
      .toBe("Health Auto Export · revoked");
  });
});
