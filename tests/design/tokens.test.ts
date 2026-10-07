import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const SOURCE_ROOTS = ["app", "components"];
const COLOR_PREFIXES = new Set(["bg", "text", "border", "ring", "from", "via", "to"]);
const SPECIAL_COLORS = new Set(["white", "black", "transparent", "current", "inherit"]);
const PALETTE_COLOR = /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|100|200|300|400|500|600|700|800|900|950)$/;
const TEXT_NON_COLORS = new Set([
  "left", "center", "right", "justify", "start", "end", "wrap", "nowrap", "balance",
  "pretty", "ellipsis", "clip", "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl",
  "5xl", "6xl", "7xl", "8xl", "9xl",
]);
const BORDER_NON_COLORS = /^(0|2|4|8|x|y|s|e|t|r|b|l|solid|dashed|dotted|double|hidden|none)$/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });
}

function classStrings(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const values: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "className" && node.initializer) {
      values.push(node.initializer.getText(source).replace(/["'`{}]/g, " "));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return values;
}

function themeNames(): Set<string> {
  const css = ["app/design-tokens.css", "app/globals.css"]
    .map((path) => readFileSync(join(ROOT, path), "utf8"))
    .join("\n");
  return new Set(Array.from(css.matchAll(/--color-([a-z0-9-]+)\s*:/g), (match) => match[1]));
}

function customClasses(): Set<string> {
  const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
  return new Set(Array.from(css.matchAll(/^\.([a-z][a-z0-9-]*)\s*\{/gm), (match) => match[1]));
}

function textNames(): Set<string> {
  const css = ["app/design-tokens.css", "app/globals.css"]
    .map((path) => readFileSync(join(ROOT, path), "utf8"))
    .join("\n");
  return new Set(Array.from(css.matchAll(/--text-([a-z0-9-]+)\s*:/g), (match) => match[1]));
}

function colorName(utility: string, knownTextNames: Set<string>): string | null {
  const base = utility.split(":").at(-1)?.replace(/^!|!$/g, "") ?? "";
  const match = /^(bg|text|border|ring|from|via|to)-(.+)$/.exec(base);
  if (!match || !COLOR_PREFIXES.has(match[1])) return null;
  const [, prefix, rawValue] = match;
  const value = rawValue.split("/")[0];

  if (value.startsWith("[")) return null;
  if (prefix === "text" && (TEXT_NON_COLORS.has(value) || knownTextNames.has(value))) return null;
  if (prefix === "border" && BORDER_NON_COLORS.test(value)) return null;
  if (prefix === "ring" && /^(0|1|2|4|8|inset|offset-\d+)$/.test(value)) return null;
  return value.replace(/^(t|r|b|l|x|y)-/, "");
}

describe("Tailwind color utilities", () => {
  it("resolve to a design token or a Tailwind palette color", () => {
    const tokens = themeNames();
    const sizes = textNames();
    const custom = customClasses();
    const invalid = SOURCE_ROOTS.flatMap((directory) => sourceFiles(join(ROOT, directory)))
      .flatMap((path) => classStrings(path).flatMap((value) => value.split(/\s+/)
        .map((utility) => ({ utility, path }))));

    const failures = invalid.flatMap(({ utility, path }) => {
      const name = colorName(utility, sizes);
      if (name === null || custom.has(utility) || SPECIAL_COLORS.has(name) || PALETTE_COLOR.test(name) || tokens.has(name)) return [];
      return [`${relative(ROOT, path)}: ${utility}`];
    });

    expect(failures).toEqual([]);
  });
});
