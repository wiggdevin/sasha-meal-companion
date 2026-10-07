import { describe, expect, it } from "vitest";
import { healthTimeZone, isIanaTimeZone } from "@/lib/health/contract";
import { normalizeShortcut } from "@/lib/health/normalize";
import { localDateOf } from "@/lib/health/daily";

describe("health time zones", () => {
  it("uses source, then user, then HEALTH_TZ, then the neutral default", () => {
    expect(healthTimeZone("America/Denver", "America/Chicago", "America/Los_Angeles"))
      .toBe("America/Denver");
    expect(healthTimeZone(null, "America/Chicago", "America/Los_Angeles"))
      .toBe("America/Chicago");
    expect(healthTimeZone(null, null, "America/Los_Angeles")).toBe("America/Los_Angeles");
    // D1 §6.4: the server's default is UTC — no region is authored in code.
    expect(healthTimeZone(null, null, null)).toBe("UTC");
  });

  it("skips invalid zones instead of handing Intl a runtime failure", () => {
    expect(isIanaTimeZone("America/Denver")).toBe(true);
    expect(isIanaTimeZone("Not/A_Time_Zone")).toBe(false);
    expect(healthTimeZone("Not/A_Time_Zone", "America/Chicago", "Also/Bad"))
      .toBe("America/Chicago");
  });

  it("keeps each Shortcut payload in its authoritative travel zone", () => {
    const sample = (tz: string, start: string) => normalizeShortcut({ samples: [{
      type: "step_count", value: 1000, unit: "count", start_time: start, end_time: start,
      vendor_sample_id: `shortcut:step_count:${start.slice(0, 10)}`,
      vendor_updated_at: "2026-09-20T12:00:00Z",
    }] }, tz).samples[0];
    const denver = sample("America/Denver", "2026-09-17T05:30:00Z");
    const london = sample("Europe/London", "2026-09-18T00:30:00Z");
    expect(localDateOf(denver.start_time, denver.tz)).toBe("2026-09-16");
    expect(localDateOf(london.start_time, london.tz)).toBe("2026-09-18");
  });
});
