import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilitiesProvider, useCapabilities } from "@/components/CapabilitiesProvider";
import { readAppCapabilities, type AppCapabilities } from "@/lib/capabilities";

vi.mock("server-only", () => ({}));

function CapabilityProbe() {
  const capabilities = useCapabilities();
  return <output>{JSON.stringify(capabilities)}</output>;
}

describe("readAppCapabilities", () => {
  it.each([undefined, "", "0", "false"])("fails coach closed for %s", (value) => {
    expect(readAppCapabilities({ COACH_ENABLED: value }).coach).toBe(false);
  });

  it.each(["1", "true"])("enables coach for %s", (value) => {
    expect(readAppCapabilities({ COACH_ENABLED: value }).coach).toBe(true);
  });

  it.each([undefined, "", "0", "false"])("fails scan closed for %s", (value) => {
    expect(readAppCapabilities({ FEATURE_SCAN: value }).scan).toBe(false);
  });

  it.each(["1", "true"])("enables scan for %s", (value) => {
    expect(readAppCapabilities({ FEATURE_SCAN: value }).scan).toBe(true);
  });

  it("uses the public scan flag only while the server flag is missing", () => {
    expect(readAppCapabilities({ NEXT_PUBLIC_FEATURE_SCAN: "1" }).scan).toBe(true);
    expect(readAppCapabilities({ FEATURE_SCAN: "0", NEXT_PUBLIC_FEATURE_SCAN: "1" }).scan)
      .toBe(false);
  });

  it("fails capture methods closed and keeps only known, deduplicated methods", () => {
    expect(readAppCapabilities({}).captureMethods).toEqual([]);
    expect(readAppCapabilities({ CAPTURE_METHODS: "photo,unknown,label,photo" }).captureMethods)
      .toEqual(["label", "photo"]);
  });

  it("reports device setup only while ingest is on, with Oura only after full server setup", () => {
    expect(readAppCapabilities({ HEALTH_INGEST_ENABLED: "0", OURA_CLIENT_ID: "id" }).device)
      .toEqual({ enabled: false, ouraConfigured: false });
    expect(readAppCapabilities({ HEALTH_INGEST_ENABLED: "1", OURA_CLIENT_ID: "id" }).device)
      .toEqual({ enabled: true, ouraConfigured: false });
    expect(readAppCapabilities({ HEALTH_INGEST_ENABLED: "1", OURA_CLIENT_ID: "id",
      OURA_CLIENT_SECRET: "secret", OURA_REDIRECT_URI: "https://app.test/callback" }).device)
      .toEqual({ enabled: true, ouraConfigured: true });
  });
});

describe("CapabilitiesProvider", () => {
  it("makes the one server-derived capability value available to client chrome", () => {
    const value: AppCapabilities = {
      coach: true,
      scan: false,
      captureMethods: ["photo", "label"],
    };
    const markup = renderToStaticMarkup(
      <CapabilitiesProvider value={value}><CapabilityProbe /></CapabilitiesProvider>,
    );
    expect(markup).toContain(JSON.stringify(value).replaceAll('"', "&quot;"));
  });
});
