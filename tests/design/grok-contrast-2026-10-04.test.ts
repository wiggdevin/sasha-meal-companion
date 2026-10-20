import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, GLOBALS_CSS, hexToRgb, luminance, MIN, over, ROOT, SECTIONS, token } from "./contrast-table";
import { MEAL_TITLE } from "@/lib/design/meal-type";

/**
 * A 2026-10-04 Grok audit claimed three contrast blockers, none of which hold up against the real
 * CSS: it read `logged-card-in`, `olive-panel` and the InstallPrompt/ProposalCard panels as dark
 * surfaces (matte charcoal, dark olive) without seeing app/globals.css, where every one of them is
 * an ivory tint. This file re-derives each background from the actual CSS (never a hardcoded hex)
 * and checks the exact text role each component uses against it, so the false-positive pattern —
 * "assume a card is dark because its neighbour (.matte meal card / the olive fill) is" — cannot
 * regress unnoticed. tests/design/contrast-table.ts and contrast-scan.test.ts already guard the
 * design system generally; this file pins the specific claims and their file:line evidence.
 */
const read = (relPath: string) => readFileSync(join(ROOT, relPath), "utf8");
const AFTER_DARK_CSS = read("components/AfterDarkCards.module.css");
const LOGGED_EXTRAS = read("components/LoggedExtras.tsx");
const COACH_ACTION_CARD = read("components/CoachActionCard.tsx");
const NOTE_SHEET = read("components/NoteSheet.tsx");
const ONBOARDING_STEPS = read("components/Onboarding/OnboardingSteps.tsx");
const INSTALL_PROMPT = read("components/InstallPrompt.tsx");
const PROPOSAL_CARD = read("components/ProposalCard.tsx");

/** The declarations of the first `{...}` block after `marker` — anchoring on a comment or a
 *  unique substring, since several components share a bare selector name (`.logged-card-in {}`
 *  also appears in a combined `position: relative` rule). */
function blockAfter(css: string, marker: string): string {
  const at = css.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

function hexesIn(text: string): string[] {
  const found = Array.from(text.matchAll(/#[0-9a-f]{6}/gi), (m) => m[0].toLowerCase());
  if (found.length === 0) throw new Error(`no hex colour in: ${text}`);
  return found;
}

function gradientStops(name: string): string[] {
  const match = new RegExp(`--grad-${name}:\\s*linear-gradient\\(([^;]*)\\);`).exec(GLOBALS_CSS);
  if (!match) throw new Error(`no gradient --grad-${name}`);
  return hexesIn(match[1]);
}

const rgbToHex = (rgb: readonly [number, number, number]) =>
  `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/** Worst (lowest) contrast of `fg` against every shade in `bgHexes`. */
const worst = (fg: readonly [number, number, number], bgHexes: string[]) =>
  Math.min(...bgHexes.map((hex) => contrast(fg, hexToRgb(hex))));

const CHARCOAL = token("charcoal");
const GRAPHITE = token("graphite");
const MUTED = token("muted");
const ON_CHARCOAL = token("on-charcoal");

describe("Grok audit 2026-10-04: logged-card-in is ivory, not matte", () => {
  const loggedCardIn = hexesIn(blockAfter(GLOBALS_CSS, "Ivory with a hairline"));

  it("the CSS background is light (app/globals.css, the .logged-card-in rule after that comment)", () => {
    for (const hex of loggedCardIn) expect(luminance(hexToRgb(hex))).toBeGreaterThan(0.5);
  });

  it("LoggedExtras.tsx renders the title, time, kcal, check-this and note in ink roles that pass on it", () => {
    // file:line evidence for each role this test locks in.
    // The title is the compact meal-title role (KIT §14), whose colour role is text-charcoal.
    expect(LOGGED_EXTRAS).toMatch(/\$\{MEAL_TITLE\.compact\}/); // title, ~line 172
    expect(MEAL_TITLE.compact).toMatch(/\btext-charcoal\b/);
    expect(LOGGED_EXTRAS).toMatch(/shrink-0 text-tiny font-normal tabular-nums text-muted/); // time, ~line 182
    expect(LOGGED_EXTRAS).toMatch(/text-tiny font-normal leading-body-sm tabular-nums text-muted/); // kcal line, ~line 187
    expect(LOGGED_EXTRAS).toMatch(/text-tiny font-normal text-muted">Best guess\. Check it\./); // "Best guess. Check it.", ~line 198
    expect(LOGGED_EXTRAS).toMatch(/italic text-muted/); // note, ~line 201
    expect(worst(CHARCOAL, loggedCardIn)).toBeGreaterThanOrEqual(MIN.text);
    expect(worst(MUTED, loggedCardIn)).toBeGreaterThanOrEqual(MIN.text);
  });

  it("LoggedExtras never falls back to a dark-surface-only role (text-on-charcoal/text-on-olive) on this card", () => {
    // The row's text column (EntryText — the function this claim is about) only ever uses
    // text-charcoal/text-muted/text-alert, never a role meant for .matte or the olive fill. The
    // file does use text-on-primary elsewhere (the drag-reschedule pill, which paints bg-primary
    // itself), so this is scoped to EntryText's own body, not the whole file.
    const entryText = LOGGED_EXTRAS.slice(
      LOGGED_EXTRAS.indexOf("function EntryText"), LOGGED_EXTRAS.indexOf("function EntryPills"));
    expect(entryText).not.toMatch(/text-on-(olive|primary|selected)/);
  });

  it("the after-dark snack ticket overrides the card to --grad-card, still ivory, never --grad-matte", () => {
    const snackTicketBlock = blockAfter(AFTER_DARK_CSS, ".snackTicket :global(.logged-card-in)");
    expect(snackTicketBlock).toMatch(/background:\s*var\(--grad-card\)/);
    expect(snackTicketBlock).not.toMatch(/--grad-matte|charcoal/);
    const gradCard = gradientStops("card");
    expect(worst(CHARCOAL, gradCard)).toBeGreaterThanOrEqual(MIN.text);
    expect(worst(MUTED, gradCard)).toBeGreaterThanOrEqual(MIN.text);
  });

  it("LoggedExtraCard never applies the .matte scope (the only way its ink roles would turn cream)", () => {
    expect(LOGGED_EXTRAS).not.toMatch(/\bmatte\b/);
  });
});

describe("Grok audit 2026-10-04: .olive-panel is a light tint, not dark olive", () => {
  const ivoryBackdrops = [...gradientStops("card"), ...gradientStops("panel"), ...gradientStops("sheet"),
    rgbToHex(token("surface"))];
  const panelAlpha = Number(/background:\s*rgb\(var\(--section-rgb\) \/ ([\d.]+)\)/.exec(
    blockAfter(GLOBALS_CSS, "Never `text-on-olive` here"))![1]);

  it("the panel's own CSS sets ink text and a translucent section tint, never cream (app/globals.css .olive-panel)", () => {
    const panelBlock = blockAfter(GLOBALS_CSS, "Never `text-on-olive` here");
    expect(panelBlock).toMatch(/color:\s*var\(--color-text-primary\)/);
    expect(panelBlock).not.toMatch(/on-olive/);
    expect(panelAlpha).toBeLessThanOrEqual(0.1); // a wash, not a fill
  });

  it("every section hue composited at that alpha over every ivory card body stays light enough for ink text", () => {
    for (const hue of Object.values(SECTIONS)) {
      for (const base of ivoryBackdrops) {
        const composite = over(hue, panelAlpha, hexToRgb(base));
        expect(luminance(composite)).toBeGreaterThan(0.5);
        expect(contrast(CHARCOAL, composite)).toBeGreaterThanOrEqual(MIN.text);
        expect(contrast(MUTED, composite)).toBeGreaterThanOrEqual(MIN.text);
      }
    }
  });

  it("CoachActionCard.tsx:99 pairs olive-panel with text-charcoal, inside .meal-card-in (ivory), never .matte", () => {
    expect(COACH_ACTION_CARD).toMatch(/olive-panel px-3 py-2 text-tiny font-normal tabular-nums text-charcoal/);
    expect(COACH_ACTION_CARD).not.toMatch(/\bmatte\b/);
    // The worst case this card can produce: a meal-card-in top gradient stop (its own section tint,
    // alpha .10 — app/globals.css .meal-card-in) with the olive-panel's .07 wash stacked on top, at
    // the most saturated section hue. The ivory base is read from that same rule, never hardcoded.
    const mealCardBlock = blockAfter(GLOBALS_CSS, "\n.meal-card-in {");
    const mealCardAlpha = Number(/rgb\(var\(--section-rgb\) \/ ([\d.]+)\) 0%/.exec(mealCardBlock)![1]);
    const [mealCardBase] = hexesIn(mealCardBlock);
    for (const hue of Object.values(SECTIONS)) {
      const step1 = over(hue, mealCardAlpha, hexToRgb(mealCardBase));
      const step2 = over(hue, panelAlpha, step1);
      expect(contrast(CHARCOAL, step2)).toBeGreaterThanOrEqual(MIN.text);
      expect(contrast(MUTED, step2)).toBeGreaterThanOrEqual(MIN.text);
    }
  });

  it("NoteSheet.tsx: ON_OLIVE rows (text-charcoal) and the kcal line (text-on-charcoal) both resolve to ink", () => {
    expect(NOTE_SHEET).toMatch(/const ON_OLIVE = "text-caption font-normal text-charcoal"/);
    expect(NOTE_SHEET).toMatch(/text-body font-medium text-on-charcoal tabular-nums/); // kcal line
    expect(NOTE_SHEET).not.toMatch(/\bmatte\b/);
    // --color-on-charcoal at :root (outside .matte) is ink, identical to --color-charcoal there.
    expect(ON_CHARCOAL).toEqual(CHARCOAL);
    expect(worst(ON_CHARCOAL, ivoryBackdrops)).toBeGreaterThanOrEqual(MIN.text);
  });

  it("OnboardingSteps.tsx MacroPanel (olive-panel, text-muted title) sits on .surface (--color-surface, ivory)", () => {
    expect(ONBOARDING_STEPS).toMatch(/function MacroPanel[\s\S]{0,150}olive-panel flex flex-col gap-2 p-4/);
    expect(ONBOARDING_STEPS).toMatch(/text-tiny font-normal leading-body-sm text-muted">\{title\}/);
    expect(ONBOARDING_STEPS).not.toMatch(/\bmatte\b/);
    expect(worst(MUTED, ivoryBackdrops)).toBeGreaterThanOrEqual(MIN.text);
  });
});

describe("Grok audit 2026-10-04: InstallPrompt and ProposalCard paint --grad-panel, not a charcoal banner", () => {
  const gradPanel = gradientStops("panel");

  it("the gradient both components reference is ivory, and lighter than the matte gradient it is not", () => {
    for (const hex of gradPanel) expect(luminance(hexToRgb(hex))).toBeGreaterThan(0.5);
    const gradMatte = gradientStops("matte");
    for (const hex of gradMatte) expect(luminance(hexToRgb(hex))).toBeLessThan(0.15); // the real dark surface
  });

  /**
   * 2026-10-08: InstallPrompt stopped being one hand-rolled floating card with its own inline
   * `background: "var(--grad-panel)"` — it is now several inline Today-list cards built from the
   * house `.shell`/`.surface` wrapper (same ivory family, `--grad-card`) and `components/ui/Notice`
   * (a light tone wash, already guarded by tests/design/contrast.test.ts), so this test was updated
   * — rather than kept passing by re-adding an inline style the new structure does not need — to
   * check the same rule (ivory panel, never the matte gradient or scope) against what it actually
   * renders now.
   */
  it("InstallPrompt.tsx paints the ivory card system (.shell/.surface, --grad-card) and never the matte gradient or scope", () => {
    expect(INSTALL_PROMPT).toMatch(/className="shell"/);
    expect(INSTALL_PROMPT).toMatch(/className="surface /); // the hand-built iOS Share guide's own panel
    expect(INSTALL_PROMPT).not.toMatch(/--grad-matte|\bmatte\b/);
    expect(INSTALL_PROMPT).not.toMatch(/background:\s*"var\(--grad-matte\)"/);
    expect(INSTALL_PROMPT).toMatch(/text-charcoal/); // the guide's own title and labelled words
    expect(INSTALL_PROMPT).toMatch(/text-graphite/); // the guide's own body copy
    const gradCard = gradientStops("card");
    expect(worst(CHARCOAL, gradCard)).toBeGreaterThanOrEqual(MIN.text);
    expect(worst(GRAPHITE, gradCard)).toBeGreaterThanOrEqual(MIN.text);
  });

  /**
   * 2026-10-19 (UI makeover card sweep): ProposalCard stopped painting its own `--grad-panel` inner
   * style and became one ivory CardFrame (the raised face, `.card-ivory`, `--grad-card`) inside a
   * pending-hue outline. The rule this claim is about holds the same way: an ivory face, never the
   * matte gradient, scope or the ink tone, with ink text roles that pass on it.
   */
  it("ProposalCard.tsx is an ivory CardFrame (--grad-card), with text-charcoal/text-graphite body text", () => {
    expect(PROPOSAL_CARD).toMatch(/<CardFrame\b/);
    expect(PROPOSAL_CARD).not.toMatch(/tone="(ink|olive)"/);
    expect(PROPOSAL_CARD).not.toMatch(/--grad-matte|\bmatte\b/);
    expect(PROPOSAL_CARD).toMatch(/text-caption font-normal text-charcoal/); // body
    expect(PROPOSAL_CARD).toMatch(/text-tiny font-normal leading-body-sm text-graphite/); // detail line
    const gradCard = gradientStops("card");
    expect(worst(CHARCOAL, gradCard)).toBeGreaterThanOrEqual(MIN.text);
    expect(worst(GRAPHITE, gradCard)).toBeGreaterThanOrEqual(MIN.text);
    expect(worst(CHARCOAL, gradPanel)).toBeGreaterThanOrEqual(MIN.text);
  });
});

describe("Grok audit 2026-10-04: no dark-mode/after-dark scope remaps these tokens", () => {
  it("app/globals.css defines no prefers-color-scheme or [data-theme] remap at all", () => {
    expect(GLOBALS_CSS).not.toMatch(/prefers-color-scheme|\[data-theme/);
  });

  it("data-after-dark-snack carries no CSS rule of its own — it is a marker, not a dark scope", () => {
    expect(GLOBALS_CSS).not.toMatch(/data-after-dark-snack/);
    expect(AFTER_DARK_CSS).not.toMatch(/data-after-dark-snack/);
  });

  it("none of the six audited components ever apply the .matte class that would turn their ink roles cream", () => {
    for (const source of [LOGGED_EXTRAS, COACH_ACTION_CARD, NOTE_SHEET, ONBOARDING_STEPS, INSTALL_PROMPT, PROPOSAL_CARD]) {
      expect(source).not.toMatch(/\bmatte\b/);
    }
  });
});
