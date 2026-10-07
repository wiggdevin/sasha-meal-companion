/**
 * Design §8.3 — the render spec for Settings' cards: targets unset / ready / needs-profile, the
 * health connection row checking / error / unavailable / unlinked / linked, the protein lock
 * locked and unlocked, the schedule card default / shifted / with a cleared override / shared,
 * the export card, and the health-sources sheet offline / busy / copied / error / revoked.
 *
 * Static renders. The targets branch is written inline in `app/settings/page.tsx`, so the page
 * itself is rendered here on one pinned controller answer — its DOM is what is asserted, never its
 * source. Every other card is a function of its props.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsPage from "@/app/settings/page";
import type { useSettingsController } from "@/components/settings/use-settings-controller";
import Card from "@/components/settings/Card";
import DataAccountSection from "@/components/settings/DataAccountSection";
import { exportHref } from "@/lib/export-client";
import ExportCard from "@/components/ExportCard";
import Section from "@/components/settings/Section";
import HealthConnectionsSection, { healthConnectionStatus }
  from "@/components/settings/HealthConnectionsSection";
import ProteinLockCard from "@/components/settings/ProteinLockCard";
import ScheduleSection from "@/components/settings/ScheduleSection";
import TargetsSection from "@/components/settings/TargetsSection";
import { CopyTokenButton, HealthSourceRecipes, healthSourceLabel }
  from "@/components/HealthSourcesSheet";
import { defaultSettings } from "@/lib/store";
import type { DailyHealthResponse } from "@/lib/health/contract";
import type { Settings } from "@/lib/types";

const RESPONSE = { days: [], sources: [] } as unknown as DailyHealthResponse;
const OURA = { id: "s1", kind: "oura", device_label: "Oura Ring",
  last_received_at: "2026-09-20T06:00:00.000Z", revoked: false };

type ControllerState = NonNullable<ReturnType<typeof useSettingsController>>;

const controller = vi.hoisted(() => ({ state: null as unknown }));

vi.mock("@/components/settings/use-settings-controller", () => ({
  useSettingsController: () => controller.state,
}));

const MACROS = { kcal: 2_200, protein: 135, carbs: 230, fat: 80 };

/**
 * `/settings` on one pinned controller answer. The page's own branch is `trainingResolved` and
 * `restResolved`: both null is an account with no revision, both set is one with targets.
 */
function settingsPage(over: Partial<ControllerState> = {}): string {
  controller.state = {
    store: { version: 1, firstOpenedAt: "2026-09-01", settings: defaultSettings(),
      days: {}, foods: {} },
    settings: defaultSettings(), daily: null, targets: null, targetsLoadFailed: false,
    targetSheetOpen: false, saveError: null, floors: null,
    trainingResolved: null, restResolved: null,
    trainingCaption: null, restCaption: null, proteinCaption: null,
    trainingAlert: null, restAlert: null, anyPinned: false, canOpenTargets: false,
    targetInitial: null, bodySheetOpen: false,
    setBodySheetOpen: () => {}, loadSources: () => {}, writeProfile: () => {},
    setTrainingKcal: () => {}, setRestKcal: () => {}, setProteinG: () => {},
    toggleProteinLock: () => {}, resetTargets: () => {}, setShiftMinutes: () => {},
    setSlotTime: () => {}, openTargetSheet: () => {}, closeTargetSheet: () => {},
    saveTargets: () => {}, ...over,
  } as unknown as ControllerState;
  return renderToStaticMarkup(<SettingsPage />);
}

function targets(settings: Partial<Settings>, children = <p>targets</p>): string {
  return renderToStaticMarkup(
    <TargetsSection settings={{ ...defaultSettings(), ...settings }} onProfileChange={() => {}}>
      {children}
    </TargetsSection>,
  );
}

describe("the targets section", () => {
  it("is unset: it offers every goal and activity as 'Not set' on a fresh account", () => {
    const markup = targets({});
    expect(markup).toContain('aria-label="Goal"');
    expect(markup).toContain("Not set");
  });

  it("selects the stored goal and activity once the profile has them", () => {
    const markup = targets({ goal: "lose_fat", activityLevel: "moderate" });
    expect(markup).toMatch(/role="combobox" aria-label="Goal"[^>]*>\s*<span[^>]*>Lose fat<\/span>/);
    expect(markup).toMatch(/role="combobox" aria-label="Activity level"[^>]*>\s*<span[^>]*>Moderate<\/span>/);
  });

  /* Design §5.3: with no revision, Settings shows the same "Finish your profile" state Today
     shows — never a fabricated calorie or macro row (app/settings/page.tsx:65-72). */
  it("needs profile: shows the finish-your-profile card, and no numbers, with no revision", () => {
    const markup = settingsPage();
    expect(markup).toContain("Finish your profile");
    expect(markup).toContain("Add your details to get daily targets.");
    expect(markup).not.toContain("Your daily targets");
    expect(markup).not.toContain("Advanced targets");
  });

  it("is ready: draws the calorie and macro cards once a revision resolves", () => {
    const markup = settingsPage({ trainingResolved: MACROS, restResolved: { ...MACROS, kcal: 1_800 } });
    expect(markup).toContain("Your daily targets");
    expect(markup).toContain("Advanced targets");
    expect(markup).not.toContain("Finish your profile");
  });
});

describe("the health connection rows", () => {
  const section = (daily: Parameters<typeof HealthConnectionsSection>[0]["daily"]) =>
    renderToStaticMarkup(<HealthConnectionsSection daily={daily} onManage={() => {}} />);

  it("says it is checking before the first answer", () => {
    expect(section(null)).toContain("Checking…");
  });

  it("says the check failed rather than checking forever", () => {
    expect(section({ response: null, fetchedAt: null, offline: true, disabled: false }))
      .toContain("Couldn’t check · try again online");
  });

  it("says the feature is not available yet when the server has it off", () => {
    expect(healthConnectionStatus("oura", [], true)).toBe("Not available yet");
  });

  it("says a source is not linked when the account has none", () => {
    expect(healthConnectionStatus("oura", [], false)).toBe("Not linked");
  });

  it("names the last sync once a source is linked, and waits honestly before one", () => {
    expect(healthConnectionStatus("oura", [OURA], false)).toContain("Linked · last sync");
    expect(healthConnectionStatus("oura", [{ ...OURA, last_received_at: null }], false))
      .toBe("Linked · waiting for first sync");
  });

  it("does not count a revoked source as linked", () => {
    expect(healthConnectionStatus("oura", [{ ...OURA, revoked: true }], false)).toBe("Not linked");
  });

  it("keeps the body dashboard reachable from the section", () => {
    expect(section({ response: RESPONSE, fetchedAt: null, offline: false, disabled: false }))
      .toContain('href="/body"');
  });
});

describe("the protein lock card", () => {
  const lock = (proteinLocked: boolean) => renderToStaticMarkup(
    <ProteinLockCard proteinLocked={proteinLocked} proteinG={135} proteinCaption={null}
      onToggleLock={() => {}} onProteinChange={() => {}} />);

  it("is locked: it explains the lock and offers to unlock it", () => {
    const markup = lock(true);
    expect(markup).toContain("Locked — based on your body weight, not your calories.");
    expect(markup).toContain("Unlock");
    expect(markup).toMatch(/<button[^>]*\sdisabled(="")?[\s>]/);
  });

  it("warns once unlocked, and only then lets the stepper move", () => {
    const markup = lock(false);
    expect(markup).toContain("Unlocked");
    expect(markup).toContain("Unlock it only when you mean to set a manual target.");
    expect(markup).toContain("Lock");
  });
});

describe("the schedule cards", () => {
  const schedule = (shiftMinutes: number, slotTimes: Record<string, string> = {}) =>
    renderToStaticMarkup(<ScheduleSection shiftMinutes={shiftMinutes} slotTimes={slotTimes}
      onShiftChange={() => {}} onSlotTimeChange={() => {}} />);

  it("reads 'On schedule' with no shift, and offers no reset to press", () => {
    const markup = schedule(0);
    expect(markup).toContain("On schedule");
    expect(markup).not.toContain("Reset to on schedule");
  });

  it("is shifted: it names the shift and offers the way back once the day has moved", () => {
    const markup = schedule(30);
    expect(markup).toContain("30 minutes later");
    expect(markup).toContain("Reset to on schedule");
  });

  it("offers the control that gets a slot override cleared, only where one is set", () => {
    const markup = schedule(0, { "meal-1": "12:30" });
    expect(markup).toContain('aria-label="Clear Meal 1 override"');
    expect(markup).not.toContain('aria-label="Clear Meal 2 override"');
  });

  it("offers the calendar share under a name that belongs to no one person", () => {
    const source = readFileSync(
      new URL("../../components/settings/ScheduleSection.tsx", import.meta.url), "utf8");
    expect(schedule(0)).toContain("Add to Calendar");
    expect(source).toContain("const ICS_CALENDAR_NAME = APP_CALENDAR_NAME;");
    expect(source).toContain("title: ICS_CALENDAR_NAME");
  });
});

describe("the export card", () => {
  it("offers both files, and says the default range — an empty one — means everything", () => {
    const markup = renderToStaticMarkup(<ExportCard />);
    expect(markup).toContain("Leave the dates empty for the whole log.");
    expect(markup).toContain("Download meals CSV");
    expect(markup).toContain("Download daily progress CSV");
    // Phase 9 slice 1: the files are fetched for the card's own account (lib/export-client.ts),
    // so the query lives in exportHref rather than in a link.
    expect(exportHref("meals", "", "")).toContain("kind=meals");
    expect(exportHref("progress", "", "")).toContain("kind=progress");
  });
});

describe("the health-sources sheet", () => {
  const recipes = (busy: boolean, online: boolean) => renderToStaticMarkup(
    <HealthSourceRecipes shortcutUrl={null} busy={busy} online={online} onIssue={() => {}} />);

  it("disables the code buttons while offline", () => {
    expect(recipes(false, false)).toMatch(/<button[^>]*\sdisabled(="")?[\s>]/);
    expect(recipes(false, true)).not.toMatch(/<button[^>]*\sdisabled(="")?[\s>]/);
  });

  it("is busy: it disables them again while one request is in flight", () => {
    expect(recipes(true, true)).toMatch(/<button[^>]*\sdisabled(="")?[\s>]/);
  });

  it.each([
    ["idle", "Copy"],
    ["copied", "Copied"],
    ["error", "Couldn't copy — select and copy manually"],
  ])("labels the copy button %s, whether idle, copied or a copy error", (status, label) => {
    expect(renderToStaticMarkup(
      <CopyTokenButton status={status as "idle" | "copied" | "error"} onCopy={() => {}} />,
    )).toContain(label.replace("'", "&#x27;"));
  });

  it("says a revoked source is revoked in its own label", () => {
    expect(healthSourceLabel({ ...OURA, revoked: true })).toContain("· revoked");
    expect(healthSourceLabel(OURA)).not.toContain("revoked");
  });
});

/**
 * The three shells every Settings card is drawn in, and the two link-only sections. They have no
 * state of their own, which is exactly why they need one assertion each: the inventory gate in
 * `tests/cards/inventory.test.ts` treats an unreachable or unspecified card-like file as a defect,
 * and a shell nobody asserts is how one goes unnoticed.
 */
describe("the shared Settings shells", () => {
  it("Card is the glass shell: it wraps its children in the glass surface", () => {
    const markup = renderToStaticMarkup(<Card><p>inside</p></Card>);
    expect(markup).toContain("inside");
    expect(markup).toContain("surface");
  });

  it("Section is a titled group, labelled for a screen reader", () => {
    const markup = renderToStaticMarkup(<Section title="Schedule"><p>rows</p></Section>);
    expect(markup).toContain('aria-label="Schedule"');
    expect(markup).toContain("rows");
  });

  it("DataAccountSection is one card: its rows share one shell, split by hairlines", () => {
    const markup = renderToStaticMarkup(
      <DataAccountSection><p>export</p><p>sync</p><p>sign out</p></DataAccountSection>);
    expect(markup).toContain('aria-label="Data &amp; account"');
    expect(markup.match(/class="shell"/g)).toHaveLength(1);
    expect(markup).toMatch(/class="surface[^"]*divide-y divide-hairline/);
  });
});
