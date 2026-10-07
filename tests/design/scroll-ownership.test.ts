import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * One scroller per screen: the page (DESIGN.md §Layout, scroll ownership; PRD U6; 2026-10-04, owner:
 * "if I'm on the inside card … once I hit the very bottom, the whole application can start scrolling
 * in the same direction"). Containing the vertical overscroll is what traps a finger inside an inline
 * panel, so `overscroll-behavior: contain | none` on the y axis (or both) is reserved for an overlay
 * that locks the page behind it. A horizontal carousel may contain its own x axis
 * (`overscroll-x-contain`, `overscroll-behavior-x`), so vertical gestures still reach the page.
 *
 * Checked in classes (`overscroll-contain`, `overscroll-y-none` …), style objects (`overscrollBehavior`,
 * `overscrollBehaviorY`) and stylesheets (`overscroll-behavior`, `-y`, `-block`).
 */
const ROOT = new URL("../../", import.meta.url).pathname;

/** Overlays that lock the page and so own their scroll: `path` → how many and which. */
const OVERLAYS: Record<string, { count: number; why: string }> = {
  "app/globals.css": { count: 1, why: "body: the page itself is the one scroller (no pull-to-refresh bounce)" },
  "components/Sheet.tsx": { count: 1, why: "the modal pop-up sheet's body" },
  "components/TimeWheelSheet.tsx": { count: 1, why: "the picker wheel inside its modal pop-up" },
  "components/HealthOrbit.module.css": { count: 1, why: "the orbit's detail overlay" },
  "components/ui/GlassSelect.module.css": { count: 1, why: "the select's open list, a modal overlay" },
  "components/coach/Transcript.tsx": { count: 1, why: "the coach transcript, a full-screen scroller" },
  "components/dock/ChatOverlay.module.css": { count: 1, why: "the chat overlay's transcript, over a locked page" },
  "components/Onboarding/ConversationalOnboarding.module.css": { count: 1,
    why: "onboarding v2's own full-screen shell (position: fixed, its own route) — DESIGN.md's one "
      + "licensed case for a redesigned onboarding that is its own overlay, locking the page behind it" },
};

/** Inline offenders other streams are removing: the ratchet only lets these shrink. */
const RATCHET: Record<string, { count: number; why: string }> = {
};

const CLASS = /(?:^|[\s:!])overscroll-(?:y-)?(?:contain|none)(?=$|[\s!])/g;
const STYLE_PROP = /^["']?overscrollBehavior(Y|Block)?["']?$/;
const CSS_DECL = /overscroll-behavior(-y|-block)?\s*:\s*([^;}]+)/g;

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return [".ts", ".tsx", ".css"].includes(extname(path)) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

/** Does a value contain the y axis? One value sets both axes; with two, the second is y. */
function containsY(value: string, axisProperty: boolean): boolean {
  const parts = value.replace(/!important/, "").trim().split(/\s+/);
  const y = axisProperty || parts.length === 1 ? parts[0] : parts[1];
  return y === "contain" || y === "none";
}

function cssOffenders(text: string): number[] {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const lines: number[] = [];
  for (const match of plain.matchAll(CSS_DECL)) {
    if (containsY(match[2], match[1] !== undefined)) lines.push(plain.slice(0, match.index).split("\n").length);
  }
  return lines;
}

function tsOffenders(path: string, text: string): number[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines: number[] = [];
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  (function visit(node: ts.Node) {
    const hits = (text: string) => { for (let n = [...text.matchAll(CLASS)].length; n > 0; n--) lines.push(at(node)); };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      hits(node.text);
    } else if (ts.isTemplateExpression(node)) {
      for (const part of [node.head, ...node.templateSpans.map((span) => span.literal)]) hits(part.text);
    } else if (ts.isPropertyAssignment(node) && STYLE_PROP.test(node.name.getText(source))) {
      const value = node.initializer.getText(source).replace(/["'`]/g, "");
      if (containsY(value, /Y|Block/.test(node.name.getText(source)))) lines.push(at(node));
    }
    ts.forEachChild(node, visit);
  })(source);
  return lines;
}

function offenders(path: string): number[] {
  const text = readFileSync(path, "utf8");
  return path.endsWith(".css") ? cssOffenders(text) : tsOffenders(path, text);
}

describe("scroll ownership", () => {
  const found = new Map<string, number[]>();
  for (const path of ["app", "components"].flatMap((directory) => files(join(ROOT, directory)))) {
    const lines = offenders(path);
    if (lines.length) found.set(relative(ROOT, path), lines);
  }
  const allowed = (path: string) => (OVERLAYS[path]?.count ?? 0) + (RATCHET[path]?.count ?? 0);

  it("contains the vertical overscroll only in overlays that lock the page", () => {
    const extra = [...found.entries()].filter(([path, lines]) => lines.length > allowed(path))
      .map(([path, lines]) => `${path}: overscroll contained at lines ${lines.join(", ")} (allowed ${allowed(path)})`);
    expect(extra, "Inline content grows and the page scrolls; only a page-locking overlay may contain it").toEqual([]);
  });

  it("only ever shrinks its allowlists", () => {
    const stale = [...new Set([...Object.keys(OVERLAYS), ...Object.keys(RATCHET)])]
      .filter((path) => (found.get(path)?.length ?? 0) < allowed(path))
      .map((path) => `${path}: allowed ${allowed(path)}, now ${found.get(path)?.length ?? 0} — lower or remove its entry`);
    expect(stale).toEqual([]);
  });

  it("sees every form it guards, and lets a carousel keep its x axis", () => {
    expect(tsOffenders("a.tsx", `<div className="overflow-y-auto overscroll-contain" />`)).toHaveLength(1);
    expect(tsOffenders("a.tsx", `<div className={\`md:overscroll-y-none \${x}\`} />`)).toHaveLength(1);
    expect(tsOffenders("a.tsx", `<div style={{ overscrollBehavior: "contain" }} />`)).toHaveLength(1);
    expect(tsOffenders("a.tsx", `<div style={{ overscrollBehaviorY: "none" }} />`)).toHaveLength(1);
    expect(cssOffenders(".a { overscroll-behavior: contain; } .b { overscroll-behavior: auto none; }")).toHaveLength(2);
    expect(cssOffenders(".a { overscroll-behavior-y: contain; }")).toHaveLength(1);
    expect(tsOffenders("a.tsx", `<div className="overflow-x-auto overscroll-x-contain snap-x" />`)).toEqual([]);
    expect(tsOffenders("a.tsx", `<div style={{ overscrollBehaviorX: "contain" }} />`)).toEqual([]);
    expect(cssOffenders(".a { overscroll-behavior-x: contain; } .b { overscroll-behavior: contain auto; }")).toEqual([]);
  });
});
