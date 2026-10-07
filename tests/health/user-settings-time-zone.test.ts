import { describe, expect, it } from "vitest";
import { settingsProfileFromRow, settingsProfileToRow } from "@/lib/sync/user-settings";

describe("user_settings time_zone mapping", () => {
  it("preserves omitted versus explicit null columns", () => {
    expect(settingsProfileFromRow({})).not.toHaveProperty("timeZone");
    expect(settingsProfileFromRow({ time_zone: null })).toHaveProperty("timeZone", null);
    expect(settingsProfileToRow({})).not.toHaveProperty("time_zone");
    expect(settingsProfileToRow({ timeZone: null })).toHaveProperty("time_zone", null);
  });

  it("round-trips an IANA zone", () => {
    expect(settingsProfileFromRow(settingsProfileToRow({ timeZone: "America/Denver" })))
      .toHaveProperty("timeZone", "America/Denver");
  });
});
