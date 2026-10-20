/**
 * FluidVoice F01-F09: the shared ActionFeedback contract, finished on every named write surface.
 *
 * Behaviour lives in each surface's own test (NoteSheet, ScanConfirmSheet, CaptureConfirm,
 * LoggedExtras, SlotCard, MyFoods, onboarding, Settings). This file holds the parts a source read
 * proves best: every named surface speaks through the shared component, every enabled button there
 * carries the shared `tap` press treatment, every persistently selected control says so
 * semantically, and the three outcome roles keep their colours.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
/** The code alone: block and whole-line comments name elements (`<button>`) they do not render. */
const code = (path: string): string =>
  source(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Surfaces that run their own write through the hook and render the shared toast. */
const OWNERS = [
  "app/page.tsx",
  "components/LogFoodSheet.tsx",
  "components/NoteSheet.tsx",
  "components/FoodSheet.tsx",
  "components/CaptureConfirm.tsx",
  "components/ScanConfirmSheet.tsx",
  "components/MyFoods.tsx",
  "components/settings/TargetsSection.tsx",
  "components/Onboarding/OnboardingFlow.tsx",
];
/** Surfaces that draw a state their owner hands them, through the same shared props. */
const RENDERERS = ["components/SlotCard.tsx", "components/LoggedExtras.tsx"];
const PRESSABLE_FILES = [...OWNERS, ...RENDERERS, "components/Onboarding/FoodsStep.tsx"];

/** Each JSX opening tag of a native button, read to its closing `>` across nested braces. */
function buttonTags(text: string): string[] {
  const tags: string[] = [];
  const opener = /<(?:motion\.)?button\b/g;
  for (let match = opener.exec(text); match; match = opener.exec(text)) {
    let depth = 0;
    let quote: string | null = null;
    let end = match.index;
    for (let i = match.index + match[0].length; i < text.length; i += 1) {
      const char = text[i];
      if (quote) { if (char === quote && text[i - 1] !== "\\") quote = null; continue; }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") depth += 1;
      else if (char === "}") depth -= 1;
      else if (char === ">" && depth === 0) { end = i; break; }
    }
    tags.push(text.slice(match.index, end + 1));
  }
  return tags;
}

describe("the action-feedback rollout", () => {
  it.each(OWNERS)("%s runs its write through the shared ActionFeedback", (path) => {
    const text = source(path);
    // Settings sections share one wrapper around the hook (components/settings/use-settings-write.ts).
    expect(text).toMatch(/useActionFeedback\(\)|useSettingsWrite\(/);
    expect(text).toMatch(/<ActionFeedbackToast\b/);
  });

  it.each(RENDERERS)("%s draws its owner's state through the shared feedback props", (path) => {
    expect(source(path)).toMatch(/feedbackStateProps\(/);
  });

  it("keys Today's eaten and meal runs to the slot that started them", () => {
    const page = source("app/page.tsx");
    // One owner for Today's writes, so one toast; every run queues rather than joining another.
    expect(page.match(/useActionFeedback\(\)/g)).toHaveLength(1);
    expect(page).toMatch(/todayFeedback\.run\([\s\S]{0,500}?key: `eaten:\$\{slotId\}`/);
    expect(page).toMatch(/eatenFeedback=\{todayFeedback\.phaseFor\(`eaten:\$\{slot\.slot\}`\)\}/);
    expect(page).toMatch(/mealFeedback=\{todayFeedback\.phaseFor\(`meal:\$\{slot\.slot\}`\)\}/);
    expect(page).toMatch(/retryState=\{todayFeedback\.phaseFor\(`retry:\$\{item\.entry\.id\}`\)\}/);
    for (const run of page.match(/todayFeedback\.run\([\s\S]*?\{ kind: "(?:commit|change)"[^}]*/g) ?? []) {
      expect(run).toMatch(/queue: true/);
    }
    // The hand-built Undo pill and inline meal alert gave way to the shared toast.
    expect(page).not.toMatch(/mealActionError/);
    expect(page).not.toMatch(/<Toast\b/);
  });

  it.each(PRESSABLE_FILES)("every button in %s uses the shared tap treatment", (path) => {
    // CaptureConfirm and ScanConfirmSheet delegate their buttons to shared editors
    // and fields; they pass vacuously here and are held by their own behaviour tests.
    const text = code(path);
    // A class constant counts when its own string carries `tap` (OnboardingFlow's PRIMARY_ACTION).
    const tapped = (name: string) => new RegExp(`const ${name} =\\s*"[^"]*\\btap\\b`).test(text);
    const missing = buttonTags(text).filter((tag) => !/\btap\b/.test(tag)
      && ![...tag.matchAll(/\{?\$?\{([A-Z_]+)\}/g)].some((match) => tapped(match[1])));
    expect(missing).toEqual([]);
  });

  it.each(PRESSABLE_FILES)("every persistently selected control in %s says so", (path) => {
    const selectable = buttonTags(code(path))
      .filter((tag) => /chip-on|--color-selected|btn-primary" : "well/.test(tag));
    for (const tag of selectable) expect(tag).toMatch(/aria-(pressed|selected|checked)=|\bchecked=/);
  });
});

describe("blockers", () => {
  it("shows a log sheet's blocker as a red Notice, never a quiet olive status", () => {
    const sheet = code("components/LogFoodSheet.tsx");
    const blockers = sheet.match(/<Notice tone="error" title=\{blocked\}/g) ?? [];
    expect(blockers).toHaveLength(2);
    for (const tag of blockers) {
      expect(tag).not.toMatch(/olive-panel/);
    }
  });
});

describe("the outcome roles", () => {
  it("keeps pending Dijon, failure red, change olive and success sage (2026-10-04)", () => {
    const globals = source("app/globals.css");
    expect(globals).toMatch(/--color-feedback-pending: var\(--color-warning\)/);
    expect(globals).toMatch(/--color-feedback-failure: var\(--color-alert\)/);
    expect(globals).toMatch(/--color-feedback-change: #4f5343/);
    expect(globals).toMatch(/--color-feedback-success: var\(--color-sage\)/);
    const css = source("components/ui/ActionFeedback.module.css");
    expect(css).toMatch(/\[data-feedback-state="pending"\][^}]*--color-feedback-pending/);
    expect(css).toMatch(/\[data-feedback-state="changed"\][^}]*--color-feedback-change/);
    expect(css).toMatch(/\.error \{[^}]*--color-feedback-failure/);
  });

  it("keeps a change marked for four seconds", () => {
    expect(source("components/ui/ActionFeedback.tsx")).toMatch(/const CHANGE_MS = 4_000;/);
  });
});
