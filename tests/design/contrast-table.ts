/**
 * The contrast table (2026-10-04, owner: the Settings protein card's explanation was "unreadable" —
 * cream `text-on-olive` on a 7 % tint over ivory, 1.1:1). Every text role the design system defines,
 * on every surface it defines, with the WCAG 2.2 contrast computed from the token hex values in
 * app/design-tokens.css and app/globals.css — never from numbers copied here — so a token edit that
 * breaks a pair fails tests/design/contrast.test.ts.
 *
 * `use` says what the pair is for: "text" (body and small text, ≥ 4.5:1), "large" (≥ 24 px, or
 * ≥ 18.66 px at 700, ≥ 3:1) or "icon" (glyphs, rims a person must see, ≥ 3:1). `allowed: false`
 * rows are pairs the system forbids; the test proves they really fail, and
 * tests/design/contrast-scan.test.ts keeps the class combinations that would produce them out of
 * components. DESIGN.md §Contrast embeds the rendered table (between the contrast-table markers).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = new URL("../../", import.meta.url).pathname;
const TOKENS_CSS = readFileSync(join(ROOT, "app/design-tokens.css"), "utf8");
export const GLOBALS_CSS = readFileSync(join(ROOT, "app/globals.css"), "utf8");

export const MIN = { text: 4.5, large: 3, icon: 3 } as const;
export type Use = keyof typeof MIN;

// ---- WCAG 2.2 relative luminance and contrast ----

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` at `alpha` over an opaque `base`. */
export function over(top: Rgb, alpha: number, base: Rgb): Rgb {
  return top.map((c, i) => Math.round(c * alpha + base[i] * (1 - alpha))) as unknown as Rgb;
}

// ---- Token values, read from the CSS ----

/** The declarations of the rule whose selector line starts with `selector`. */
function block(selector: string): string {
  const start = GLOBALS_CSS.indexOf(`\n${selector}`);
  if (start < 0) throw new Error(`no CSS block for ${selector}`);
  const open = GLOBALS_CSS.indexOf("{", start);
  return GLOBALS_CSS.slice(open + 1, GLOBALS_CSS.indexOf("}", open));
}

function hexVars(css: string): Map<string, string> {
  return new Map(Array.from(css.matchAll(/--color-([a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,6})\b/gi),
    (m) => [m[1], m[2]] as [string, string]));
}

/** Light-scope colour tokens: the exported tokens, then globals.css @theme (which wins). */
const THEME = new Map([...hexVars(TOKENS_CSS), ...hexVars(GLOBALS_CSS.split(/\n:root \{/)[0])]);
const MATTE = new Map([...THEME, ...hexVars(block(".matte {"))]);
const RESET = new Map([...THEME, ...hexVars(block(".matte-reset,"))]);

/** Light text roles `.matte-reset` (and `.notice`) must map back to their ink values. */
export const RESET_ROLES = ["charcoal", "graphite", "muted", "text-primary", "text-secondary", "text-muted",
  "text-faint", "text-hint", "icon"] as const;

/** [role, the light value, the .matte-reset value]. */
export function resetValues(): [string, string | undefined, string | undefined][] {
  return RESET_ROLES.map((name) => [name, THEME.get(name)?.toLowerCase(), RESET.get(name)?.toLowerCase()]);
}

export function token(name: string, scope: Map<string, string> = THEME): Rgb {
  const hex = scope.get(name);
  if (!hex) throw new Error(`no colour token --color-${name}`);
  return hexToRgb(hex);
}

/** Every hex stop of a `--grad-*` recipe in :root. */
export function gradient(name: string): Rgb[] {
  const match = new RegExp(`--grad-${name}:\\s*linear-gradient\\(([^;]*)\\);`).exec(GLOBALS_CSS);
  if (!match) throw new Error(`no gradient --grad-${name}`);
  return Array.from(match[1].matchAll(/#[0-9a-f]{6}/gi), (m) => hexToRgb(m[0]));
}

function alphaIn(selector: string, pattern: RegExp): number {
  const match = pattern.exec(block(selector));
  if (!match) throw new Error(`no alpha in ${selector}`);
  return Number(match[1]);
}

export const SECTIONS: Record<string, Rgb> = Object.fromEntries(
  Array.from(GLOBALS_CSS.matchAll(/\[data-section="([a-z]+)"\]\s*\{\s*--section-rgb:\s*(\d+) (\d+) (\d+);/g),
    (m) => [m[1], [Number(m[2]), Number(m[3]), Number(m[4])] as Rgb]));

const MEALS: Record<string, Rgb> = Object.fromEntries(
  Array.from(GLOBALS_CSS.matchAll(/\.plan-head\[data-meal="([a-z]+)"\]\s*\{\s*--meal-rgb:\s*(\d+) (\d+) (\d+);/g),
    (m) => [m[1], [Number(m[2]), Number(m[3]), Number(m[4])] as Rgb]));

export const PANEL_ALPHA = alphaIn(".olive-panel {", /background: rgb\(var\(--section-rgb\) \/ ([\d.]+)\)/);
const BAND_ALPHA = alphaIn(".plan-head {", /rgb\(var\(--meal-rgb\) \/ ([\d.]+)\) 0%/);
const GLYPH_ALPHA = alphaIn(".plan-head-glyph {", /background: rgb\(var\(--meal-rgb\) \/ ([\d.]+)\)/);
const CHIP_ALPHA = alphaIn(".plan-chip {", /background: rgb\(255 255 255 \/ ([\d.]+)\)/);
const WHITE: Rgb = [255, 255, 255];

// ---- Surfaces: every shade a text role may sit on ----

export type Surface = { id: string; scope: "light" | "matte" | "olive"; shades: Rgb[] };

const ivory = [...gradient("card"), ...gradient("panel"), ...gradient("sheet"), token("surface")];
const matte = gradient("matte");
/** The plan header sits in the attached panel or the pop-up: every ivory shade under each tint. */
const bandsOf = (meal: Rgb) => ivory.map((shade) => over(meal, BAND_ALPHA, shade));
const bands = Object.values(MEALS).flatMap(bandsOf);

export const SURFACES: Surface[] = [
  { id: "oat ground", scope: "light", shades: [token("paper"), token("background")] },
  { id: "ivory card (.surface, sheets)", scope: "light", shades: ivory },
  { id: "lifted card (CardFrame raised)", scope: "light", shades: gradient("card") },
  { id: "inset card (nested .surface, CardFrame recess)", scope: "light", shades: gradient("card-inset") },
  { id: "beige recess (.well, trays)", scope: "light", shades: [...gradient("recess"), token("fog")] },
  { id: "field", scope: "light", shades: [token("field")] },
  { id: "sage wash", scope: "light", shades: [token("sage-wash")] },
  { id: "Dijon wash", scope: "light", shades: [token("yellow-wash")] },
  { id: "persimmon wash", scope: "light", shades: [token("orange-wash")] },
  { id: "red wash", scope: "light", shades: [token("red-wash")] },
  { id: ".olive-panel on ivory", scope: "light",
    shades: Object.values(SECTIONS).flatMap((hue) => ivory.map((shade) => over(hue, PANEL_ALPHA, shade))) },
  { id: "plan header band", scope: "light", shades: bands },
  { id: "plan header chip", scope: "light", shades: bands.map((band) => over(WHITE, CHIP_ALPHA, band)) },
  { id: "plan header glyph", scope: "light",
    shades: Object.values(MEALS).flatMap((meal) => bandsOf(meal).map((band) => over(meal, GLYPH_ALPHA, band))) },
  { id: ".matte-reset tray", scope: "light", shades: gradient("recess") },
  { id: "olive fill (primary)", scope: "olive", shades: [...gradient("ink"), token("primary")] },
  { id: "charcoal matte", scope: "matte", shades: [...matte, token("charcoal")] },
  { id: ".olive-panel in .matte", scope: "matte",
    shades: Object.values(SECTIONS).flatMap((hue) => matte.map((shade) => over(hue, PANEL_ALPHA, shade))) },
];

// ---- Text roles ----

export type Role = { id: string; use: Use; color: Rgb; scope: Surface["scope"] };

const sectionRoles = (use: Use): Role[] => Object.entries(SECTIONS)
  .map(([name, hue]) => ({ id: `section hue: ${name}`, use, color: hue, scope: "light" as const }));

export const ROLES: Role[] = [
  // Light scope (ivory, oat, beige, field, washes, panels, .matte-reset trays)
  { id: "text-charcoal / text-text-primary", use: "text", color: token("charcoal"), scope: "light" },
  { id: "text-graphite / text-text-secondary", use: "text", color: token("graphite"), scope: "light" },
  { id: "text-muted / text-text-muted / text-text-hint", use: "text", color: token("muted"), scope: "light" },
  { id: "text-text-faint", use: "text", color: token("text-faint"), scope: "light" },
  { id: "text-alert / text-red-ink", use: "text", color: token("alert"), scope: "light" },
  { id: "text-warning / text-amber / text-yellow-ink", use: "text", color: token("yellow-ink"), scope: "light" },
  { id: ".kcal / .macro-ink-kcal (persimmon ink)", use: "text", color: token("orange-ink"), scope: "light" },
  { id: "text-sage-ink / .macro-ink-carbs", use: "text", color: token("sage-ink"), scope: "light" },
  { id: "text-plum / .macro-ink-protein", use: "text", color: token("plum"), scope: "light" },
  { id: "text-primary (olive as text)", use: "text", color: token("primary"), scope: "light" },
  ...sectionRoles("text"),
  { id: "text-icon (line icons)", use: "icon", color: token("icon"), scope: "light" },
  // On the olive fill
  { id: "text-on-primary / text-on-selected", use: "text", color: token("on-primary"), scope: "olive" },
  { id: "text-on-olive on the olive fill", use: "text", color: token("on-olive"), scope: "olive" },
  { id: "text-on-olive-muted (glyphs only)", use: "icon", color: token("on-olive-muted"), scope: "olive" },
  // Inside .matte (the meal card, the dock, toasts): the remapped roles
  { id: ".matte text-charcoal", use: "text", color: token("charcoal", MATTE), scope: "matte" },
  { id: ".matte text-graphite", use: "text", color: token("graphite", MATTE), scope: "matte" },
  { id: ".matte text-muted", use: "text", color: token("muted", MATTE), scope: "matte" },
  { id: ".matte text-text-faint", use: "text", color: token("text-faint", MATTE), scope: "matte" },
  { id: ".matte text-on-olive", use: "text", color: token("on-olive", MATTE), scope: "matte" },
  { id: ".matte .kcal / .macro-ink-kcal", use: "text", color: token("gauge-calories"), scope: "matte" },
  { id: ".matte .olive-panel .kcal", use: "text", color: token("gauge-calories-end"), scope: "matte" },
  { id: ".matte .macro-ink-protein", use: "text", color: token("gauge-protein-end"), scope: "matte" },
  { id: ".matte .macro-ink-carbs", use: "text", color: token("gauge-carbs"), scope: "matte" },
  { id: ".matte .macro-ink-fat", use: "text", color: token("gauge-fat"), scope: "matte" },
  { id: ".matte text-icon", use: "icon", color: token("icon", MATTE), scope: "matte" },
];

/** A light role that is only for some light surfaces (DESIGN.md §Colors: faint is for ivory). */
const ONLY_ON: Record<string, string[]> = {
  "text-text-faint": ["ivory card (.surface, sheets)", "field"],
  ".matte .kcal / .macro-ink-kcal": ["charcoal matte"],
  ".matte .olive-panel .kcal": [".olive-panel in .matte"],
};

/** The plan header's glyph tile shows only its own meal ink, checked in GLYPHS below. */
const NOT_A_TEXT_SURFACE = new Set(["plan header glyph"]);

export type Pair = { role: string; surface: string; use: Use; ratio: number; allowed: boolean; why?: string };

function worst(color: Rgb, shades: Rgb[]): number {
  return Math.min(...shades.map((shade) => contrast(color, shade)));
}

/** Every allowed role × surface pair, at its worst shade. */
export function allowedPairs(): Pair[] {
  return ROLES.flatMap((role) => SURFACES
    .filter((surface) => surface.scope === role.scope && !NOT_A_TEXT_SURFACE.has(surface.id))
    .filter((surface) => !ONLY_ON[role.id] || ONLY_ON[role.id].includes(surface.id))
    .map((surface) => ({ role: role.id, surface: surface.id, use: role.use,
      ratio: worst(role.color, surface.shades), allowed: true })));
}

/** The plan header glyph: each meal's ink on its own tinted tile (an icon, ≥ 3:1). */
export function glyphPairs(): Pair[] {
  const inks: Record<string, Rgb> = {
    breakfast: token("yellow-ink"), lunch: token("sage-ink"), dinner: token("primary"),
    snack: token("plum"), other: token("muted"),
  };
  return Object.entries(MEALS).map(([meal, hue]) => ({
    role: `plan glyph ink: ${meal}`, surface: "plan header glyph", use: "icon" as const,
    ratio: worst(inks[meal], bandsOf(hue).map((band) => over(hue, GLYPH_ALPHA, band))), allowed: true,
  }));
}

/** Notice tones: the title ink and body graphite on each wash (components/ui/Notice). */
export function noticePairs(): Pair[] {
  const tones: [string, Rgb, Rgb][] = [
    ["info / success", token("sage-wash"), token("sage-ink")],
    ["attention", token("yellow-wash"), token("yellow-ink")],
    ["error", token("red-wash"), token("red-ink")],
    ["neutral", token("fog"), token("charcoal")],
  ];
  return tones.flatMap(([tone, wash, ink]) => [
    { role: `notice title (${tone})`, surface: `notice ${tone}`, use: "text" as const, ratio: contrast(ink, wash), allowed: true },
    { role: "notice body (graphite)", surface: `notice ${tone}`, use: "text" as const,
      ratio: contrast(token("graphite"), wash), allowed: true },
    { role: "notice mark (tone ink)", surface: `notice ${tone}`, use: "icon" as const, ratio: contrast(ink, wash), allowed: true },
  ]);
}

/** The neutral Tag's ink wash (components/ui/Tag.tsx `bg-charcoal/N`), read from the component. */
const TAG_WASH = Number(/neutral: "bg-charcoal\/(\d+) text-graphite"/
  .exec(readFileSync(join(ROOT, "components/ui/Tag.tsx"), "utf8"))![1]) / 100;
/** The coach bubble's section tint stops (`--grad-bubble`), over any section hue. */
const BUBBLE_ALPHAS = Array.from(/--grad-bubble:([^;]*);/.exec(GLOBALS_CSS)![1]
  .matchAll(/rgb\(var\(--section-rgb\) \/ ([\d.]+)\)/g), (m) => Number(m[1]));

/**
 * The neutral Tag: graphite text on its own ink wash over whatever card it sits on. It carries the AI
 * label (components/ui/AiLabel.tsx) on ivory cards, beige trays, the field, the oat ground, the
 * coach's tinted bubble (any section hue) and inside the matte, where both roles turn cream.
 */
export function tagPairs(): Pair[] {
  const ground = [token("paper"), token("background")];
  const bubble = Object.values(SECTIONS).flatMap((hue) => BUBBLE_ALPHAS.flatMap((alpha) =>
    [...ivory, ...ground].map((shade) => over(hue, alpha, shade))));
  const light: [string, Rgb[]][] = [
    ["ivory card", ivory], ["beige recess", [...gradient("recess"), token("fog")]], ["field", [token("field")]],
    ["oat ground", ground], ["coach bubble", bubble],
  ];
  const wash = (ink: Rgb, shades: Rgb[]) => shades.map((shade) => over(ink, TAG_WASH, shade));
  return [
    ...light.map(([id, shades]) => ({ role: "neutral tag (text-graphite)", surface: `neutral tag on ${id}`,
      use: "text" as const, ratio: worst(token("graphite"), wash(token("charcoal"), shades)), allowed: true })),
    { role: ".matte neutral tag", surface: "neutral tag in the matte", use: "text" as const,
      ratio: worst(token("graphite", MATTE), wash(token("charcoal", MATTE), [...matte, token("charcoal")])), allowed: true },
  ];
}

/**
 * Pairs the system forbids, with the reason. Each must really fail its threshold (so this list is
 * true), and contrast-scan.test.ts rejects the class combinations that would draw them.
 */
export function forbiddenPairs(): Pair[] {
  const panel = SURFACES.find((s) => s.id === ".olive-panel on ivory")!.shades;
  const rows: [string, string, Use, Rgb, Rgb[], string][] = [
    ["text-on-olive (cream)", ".olive-panel on ivory", "text", token("on-olive"), panel,
      "the Settings protein card bug: cream on a 7 % tint; use ink (`text-charcoal`)"],
    ["text-on-olive (cream)", "ivory card", "text", token("on-olive"), ivory, "cream is for the olive fill and the matte only"],
    ["text-on-olive-muted", "olive fill (primary)", "text", token("on-olive-muted"), gradient("ink"),
      "3.3:1 — glyphs only, never words"],
    ["text-on-primary", "ivory card", "text", token("on-primary"), ivory,
      "`text-on-primary` needs the olive fill under it (`btn-primary`, `bg-primary`, a lens)"],
    ["text-on-primary", "beige recess (.well)", "text", token("on-primary"), gradient("recess"),
      "`text-on-primary` on a well or pill track"],
    ["gauge carbs (.macro-carbs) as text", "ivory card", "text", token("gauge-carbs"), ivory,
      "gauge hues are fills and dots; text uses `.macro-ink-*`"],
    ["gauge fat (.macro-fat, text-yellow) as text", "ivory card", "text", token("gauge-fat"), ivory,
      "use `text-yellow-ink` or `.macro-ink-fat`"],
    ["gauge protein (.macro-protein) as text", "charcoal matte", "text", token("gauge-protein"), matte,
      "4.0:1 inside the meal card; `.macro-ink-protein` uses the lighter end"],
    ["gauge calories as text", "ivory card", "text", token("gauge-calories"), ivory, "use `.kcal`"],
    ["slate (text-tertiary, text-signal)", "ivory card", "text", token("tertiary"), ivory, "a data accent, not text"],
    ["warm orange rim (text-orange-warm)", "ivory card", "text", token("orange-warm"), ivory, "rims only"],
    ["text-text-faint", "oat ground", "text", token("text-faint"), [token("paper")], "faint is for ivory and field"],
    ["text-text-faint", "beige recess (.well)", "text", token("text-faint"), [token("fog")], "faint is for ivory and field"],
  ];
  return rows.map(([role, surface, use, color, shades, why]) =>
    ({ role, surface, use, ratio: worst(color, shades), allowed: false, why }));
}

export function allPairs(): Pair[] {
  return [...allowedPairs(), ...glyphPairs(), ...noticePairs(), ...tagPairs(), ...forbiddenPairs()];
}

/** The table DESIGN.md §Contrast embeds: one row per role, its worst allowed surface. */
export function markdownTable(): string {
  const rows = new Map<string, Pair>();
  for (const pair of [...allowedPairs(), ...glyphPairs(), ...noticePairs(), ...tagPairs()]) {
    const current = rows.get(pair.role);
    if (!current || pair.ratio < current.ratio) rows.set(pair.role, pair);
  }
  const fmt = (n: number) => `${n.toFixed(2)}:1`;
  const allowed = [...rows.values()].map((p) =>
    `| ${p.role} | ${p.use} (≥ ${MIN[p.use]}) | ${p.surface} | ${fmt(p.ratio)} |`);
  const forbidden = forbiddenPairs().map((p) => `| ${p.role} | ${p.surface} | ${fmt(p.ratio)} | ${p.why} |`);
  return [
    "| Role | Use | Worst allowed surface | Contrast |", "|---|---|---|---|", ...allowed, "",
    "| Forbidden pair | On | Contrast | Instead |", "|---|---|---|---|", ...forbidden,
  ].join("\n");
}
