import { describe, expect, it } from "vitest";
import { defaultSettings } from "@/lib/store";
import { settingsProfileFromRow, settingsProfileToRow } from "@/lib/sync/user-settings";

describe("height and weight display preferences", () => {
  it("defaults an older or explicitly null row to US display units", () => {
    expect(settingsProfileFromRow({})).toMatchObject({ heightUnit: "ft_in", weightUnit: "lb" });
    expect(settingsProfileFromRow({ height_unit: null, weight_unit: null }))
      .toMatchObject({ heightUnit: "ft_in", weightUnit: "lb" });
  });

  it("round-trips independent unit choices through user_settings", () => {
    const row = settingsProfileToRow({
      ...defaultSettings(),
      heightUnit: "cm",
      weightUnit: "kg",
    });
    expect(row).toMatchObject({ height_unit: "cm", weight_unit: "kg" });
    expect(settingsProfileFromRow(row)).toMatchObject({ heightUnit: "cm", weightUnit: "kg" });
  });

  it("writes defaults when an older phone cache has no unit fields", () => {
    expect(settingsProfileToRow(defaultSettings()))
      .toMatchObject({ height_unit: "ft_in", weight_unit: "lb" });
  });
});
