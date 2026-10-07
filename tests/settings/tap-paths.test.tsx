import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AppProfileCard from "@/components/settings/AppProfileCard";
import TargetsSection from "@/components/settings/TargetsSection";
import { defaultSettings } from "@/lib/store";

const settings = {
  ...defaultSettings(),
  heightCm: 165,
  heightUnit: "ft_in" as const,
  weightKg: 60,
  weightUnit: "lb" as const,
  birthYear: 1996,
  sex: "female" as const,
  bodyFatPct: 20,
  activityLevel: "moderate" as const,
  goal: "recomp" as const,
  trainingWeekdays: [1, 3, 4, 5],
};

describe("Settings low-tap edit paths", () => {
  it("shows the body details on the profile card, whose Edit profile edits them", () => {
    // Owner, 2026-10-05: the "Body profile & units" section repeated what Edit profile edits.
    const markup = renderToStaticMarkup(
      <AppProfileCard settings={settings} setup={false} training={null} rest={null} />,
    );
    for (const value of ["Height", "5 ft 5 in", "Weight", "132.3 lb", "Age", "Female", "Body fat", "20%",
      "Edit profile"]) {
      expect(markup).toContain(value);
    }
    expect(markup).not.toContain("Redo setup");
  });

  it("puts goal, activity level and training days directly in Goals and targets", () => {
    const markup = renderToStaticMarkup(
      <TargetsSection settings={settings} onProfileChange={vi.fn()}>{null}</TargetsSection>,
    );
    expect(markup).toContain('aria-label="Goal"');
    expect(markup).toContain('aria-label="Activity level"');
    expect(markup).toContain('aria-label="Training day Monday"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("shows the rate picker under a loss or gain goal, and none for recomp (step D)", () => {
    const recomp = renderToStaticMarkup(
      <TargetsSection settings={settings} onProfileChange={vi.fn()}>{null}</TargetsSection>,
    );
    expect(recomp).not.toContain('aria-label="Goal rate"');
    const losing = renderToStaticMarkup(
      <TargetsSection settings={{ ...settings, goal: "lose_fat", goalRateBpWeek: -50 }}
        onProfileChange={vi.fn()}>{null}</TargetsSection>,
    );
    expect(losing).toContain('aria-label="Goal rate"');
    expect(losing).toMatch(/role="combobox" aria-label="Goal rate"[^>]*>\s*<span[^>]*>Steady · −0\.5% of body weight a week \(recommended\)<\/span>/);
  });
});
