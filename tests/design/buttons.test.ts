import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * One button system (DESIGN.md §Buttons, PRD U4; 2026-10-04, owner: "we need a buttons system
 * throughout the application. Some are too fat, some are too plain, their states change"). Every
 * button is `components/ui/Button`: its variant and size own the fill, the height and the type. Outside
 * components/ui this guard rejects the hand-made recipes the system replaced:
 *
 * - `height-52`   a 52 px height written on a button (`h-[52px]`, or `height: 52` in its style);
 *                 `size="lg"` is the one 52 px button.
 * - `pill-in`     the recessed chip track used as a button's face (a choice is a `Chip`, an action a
 *                 `Button`).
 * - `class`       a button class string (`btn-ink`, `btn-primary`, `btn-secondary` …) written by hand,
 *                 or the legacy `button.well` recipe (a `well` class on a `<button>`).
 *
 * It is a ratchet. ALLOWLIST holds the files that still carry legacy usages and how many; a file not
 * on it may not gain one, a listed file may not gain more, and a listed file that has fewer must lower
 * (or drop) its entry, so the list only shrinks. On failure the test prints the list as it should
 * read now.
 */
const ROOT = new URL("../../", import.meta.url).pathname;

type Kind = "height-52" | "pill-in" | "class";

/** Files that still hold legacy button recipes: `path` → count and why it is still there. */
const ALLOWLIST: Record<string, { count: number; why: string }> = {
  "app/design/DesignGallery.tsx": { count: 1, why: "gallery: integrator" },
  "components/coach/editors/BarcodeDraftEditor.tsx": { count: 4, why: "stream D" },
  "components/coach/editors/CaptureDraftEditor.tsx": { count: 2, why: "stream D" },
  "components/coach/editors/EditorPill.tsx": { count: 1, why: "stream D" },
  "components/FavoritesStrip.tsx": { count: 1, why: "stream S" },
  "components/IcsSubscribe.tsx": { count: 2, why: "stream S" },
  "components/recipes-hub/PutInMeal.tsx": { count: 1, why: "stream T" },
  "components/Sheet.tsx": { count: 1, why: "stream T" },
  "components/ShoppingList.tsx": { count: 2, why: "stream S" },
  "components/ShoppingRow.tsx": { count: 1, why: "stream S" },
};

const BUTTON_TAGS = new Set(["button", "motion.button", "Button"]);
const BUTTON_CLASS = /(?:^|\s|:|!)btn-(?:ink|primary|secondary|tertiary|ghost|danger|icon)(?=$|\s|!)/;
const HEIGHT_52_CLASS = /(?:^|\s|:)!?h-\[52px\](?=$|\s|!)/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return /components\/ui$/.test(path) ? [] : sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

/** Every string a class or style expression can produce, following same-file constants. */
function strings(node: ts.Node, consts: Map<string, ts.Expression>, seen = new Set<ts.Node>()): string[] {
  if (seen.has(node)) return [];
  seen.add(node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.flatMap((span) =>
      [...strings(span.expression, consts, seen), span.literal.text])];
  }
  if (ts.isIdentifier(node) && consts.has(node.text)) return strings(consts.get(node.text)!, consts, seen);
  const found: string[] = [];
  ts.forEachChild(node, (child) => { found.push(...strings(child, consts, seen)); });
  return found;
}

/** True when a style expression sets `height: 52` (or "52px"), following same-file constants. */
function sets52(node: ts.Node, consts: Map<string, ts.Expression>, seen = new Set<ts.Node>()): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (ts.isIdentifier(node) && consts.has(node.text)) return sets52(consts.get(node.text)!, consts, seen);
  if (ts.isPropertyAssignment(node) && /^["']?(height|minHeight)["']?$/.test(node.name.getText())) {
    const value = node.initializer.getText().replace(/["'`]/g, "");
    if (value === "52" || value === "52px") return true;
  }
  let hit = false;
  ts.forEachChild(node, (child) => { hit = hit || sets52(child, consts, seen); });
  return hit;
}

function offenders(path: string): { line: number; kind: Kind }[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const consts = new Map<string, ts.Expression>();
  (function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      consts.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  })(source);

  const found: { line: number; kind: Kind }[] = [];
  const at = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const attribute = (element: ts.JsxOpeningLikeElement, name: string) => element.attributes.properties
    .find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(source) === name);

  // Button class strings anywhere in the file (a constant, a helper, a className).
  (function visit(node: ts.Node) {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && BUTTON_CLASS.test(node.text)
      && !ts.isImportDeclaration(node.parent)) found.push({ line: at(node), kind: "class" });
    if (ts.isTemplateExpression(node)) {
      const parts = [node.head, ...node.templateSpans.map((span) => span.literal)];
      for (const part of parts) if (BUTTON_CLASS.test(part.text)) found.push({ line: at(node), kind: "class" });
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (BUTTON_TAGS.has(tag)) {
        const className = attribute(node, "className")?.initializer;
        const classes = className ? strings(className, consts).join(" ") : "";
        const style = attribute(node, "style")?.initializer;
        if (HEIGHT_52_CLASS.test(classes) || (style && sets52(style, consts))) found.push({ line: at(node), kind: "height-52" });
        if (/(?:^|\s)pill-in(?=$|\s)/.test(classes)) found.push({ line: at(node), kind: "pill-in" });
        if (tag !== "Button" && /(?:^|\s)well(?=$|\s)/.test(classes)) found.push({ line: at(node), kind: "class" });
      }
    }
    ts.forEachChild(node, visit);
  })(source);
  return found;
}

describe("button system", () => {
  const files = ["app", "components"].flatMap((directory) => sourceFiles(join(ROOT, directory)));
  const counts = new Map<string, { line: number; kind: Kind }[]>();
  for (const path of files) {
    const hits = offenders(path);
    if (hits.length) counts.set(relative(ROOT, path), hits);
  }
  const regenerated = () => [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([path, hits]) => `  "${path}": { count: ${hits.length}, why: ${JSON.stringify(ALLOWLIST[path]?.why ?? "TODO")} },`)
    .join("\n");

  it("adds no hand-made button recipe outside components/ui", () => {
    const grown = [...counts.entries()].flatMap(([path, hits]) => {
      const allowed = ALLOWLIST[path]?.count ?? 0;
      return hits.length > allowed
        ? [`${path}: ${hits.length} legacy button usages (allowed ${allowed}) at ${hits.map((h) => `${h.line} ${h.kind}`).join(", ")}`]
        : [];
    });
    expect(grown, `Use components/ui/Button. The allowlist as it reads now:\n${regenerated()}`).toEqual([]);
  });

  it("only ever shrinks its allowlist", () => {
    const stale = Object.entries(ALLOWLIST).flatMap(([path, { count }]) => {
      const now = counts.get(path)?.length ?? 0;
      return now < count ? [`${path}: allowed ${count}, now ${now} — lower the entry${now === 0 ? " (remove it)" : ""}`] : [];
    });
    expect(stale, `The allowlist as it reads now:\n${regenerated()}`).toEqual([]);
  });

  it("recognises every legacy recipe it guards", () => {
    const sample = join(ROOT, "tests/design/fixtures/legacy-buttons.tsx");
    expect(offenders(sample).map((hit) => hit.kind).sort()).toEqual(
      ["class", "class", "class", "height-52", "height-52", "pill-in"]);
  });
});
