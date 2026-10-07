import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Presentation lives in the design system, not in style objects (owner, 2026-10-03: "Make sure none
 * of this is hardcoded into the app", after finding `style={{ fontSize: 20, fontWeight: 600 }}` and
 * `borderBottom: "1px solid rgba(0, 0, 0, 0.05)"` on the Avoids cards). A JSX `style` in app/ or
 * components/ may not set a font size, weight or tracking, a colour or a border: use the type-scale
 * and role utilities (`text-tiny`, `text-title`, `text-overline`, `font-medium`, `text-muted`,
 * `border-hairline` …) or a shared component (Card, ListRow, Tag, Disclosure).
 *
 * The check follows inline objects, their spreads and conditionals, same-file constants passed as
 * `style={NAME}`, and any `CSSProperties`-typed constant (a style module imported elsewhere). A value that is genuinely data-driven may stay inline only with an entry in
 * ALLOWED saying why; an entry that no longer matches fails too, so the list never outlives its use.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
const GUARDED = /^(fontSize|fontWeight|letterSpacing|color|border(Top|Right|Bottom|Left|Block|Inline)?(Start|End)?(Color|Width|Style)?)$/;

/** `path:prop` → why the value must be computed at runtime. */
const ALLOWED: Record<string, string> = {
  "components/MealCardActions.tsx:color":
    "Clear and Delete labels blend from the fill colour to cream as the swipe travels (color-mix by drag strength).",
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

function offenders(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const objects = new Map<string, ts.ObjectLiteralExpression>();
  (function collect(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init: ts.Expression = node.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      if (ts.isObjectLiteralExpression(init)) objects.set(node.name.text, init);
    }
    ts.forEachChild(node, collect);
  })(source);

  const found: string[] = [];
  const seen = new Set<ts.Node>();
  function properties(object: ts.ObjectLiteralExpression) {
    if (seen.has(object)) return;
    seen.add(object);
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) { style(property.expression); continue; }
      if (!property.name) continue;
      const name = property.name.getText(source).replace(/["']/g, "");
      if (GUARDED.test(name)) {
        const line = source.getLineAndCharacterOfPosition(property.getStart()).line + 1;
        found.push(`${relative(ROOT, path)}:${line}:${name}`);
      }
    }
  }
  function style(expression: ts.Expression) {
    if (ts.isObjectLiteralExpression(expression)) properties(expression);
    else if (ts.isIdentifier(expression) && objects.has(expression.text)) properties(objects.get(expression.text)!);
    else if (ts.isConditionalExpression(expression)) { style(expression.whenTrue); style(expression.whenFalse); }
    else if (ts.isBinaryExpression(expression)) { style(expression.left); style(expression.right); }
    else if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) style(expression.expression);
  }
  (function visit(node: ts.Node) {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "style" && node.initializer
      && ts.isJsxExpression(node.initializer) && node.initializer.expression) style(node.initializer.expression);
    // A style module (`export const CAPTION: CSSProperties = { … }`) is checked where it is written.
    if (ts.isVariableDeclaration(node) && node.type && /CSSProperties/.test(node.type.getText(source))
      && node.initializer) style(node.initializer);
    ts.forEachChild(node, visit);
  })(source);
  return found;
}

describe("inline styles", () => {
  const all = ["app", "components"].flatMap((directory) => sourceFiles(join(ROOT, directory))).flatMap(offenders);
  const key = (hit: string) => { const [path, , prop] = hit.split(":"); return `${path}:${prop}`; };

  it("never set font size, weight, tracking, colour or borders in components", () => {
    expect(all.filter((hit) => !(key(hit) in ALLOWED))).toEqual([]);
  });

  it("keeps every allowlist entry in use", () => {
    const used = new Set(all.map(key));
    expect(Object.keys(ALLOWED).filter((entry) => !used.has(entry))).toEqual([]);
  });
});
