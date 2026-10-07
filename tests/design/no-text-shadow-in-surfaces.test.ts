import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return extname(path) === ".tsx" ? [path] : [];
  });
}

function classNames(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true,
    ts.ScriptKind.TSX);
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

function cssBlock(css: string, selector: string): string {
  return new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, "m").exec(css)?.[1] ?? "";
}

describe("glass surface text", () => {
  it("draws ground text with no halo: the Motion ground is black, and no text may blur", () => {
    const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");
    expect(css).not.toMatch(/^\.ts\s*\{/m);
    for (const selector of [".ground", ".ground-muted"]) {
      expect(cssBlock(css, selector)).toMatch(/color:\s*var\(--color-on-charcoal/);
      expect(cssBlock(css, selector)).not.toMatch(/text-shadow/);
    }
    expect(css).not.toMatch(/text-shadow:\s*(?!none)[^;]*rgba/);
  });

  it("allows the literal ts class only beside ground or ground-muted", () => {
    const failures = ["app", "components"].flatMap((directory) => sourceFiles(join(ROOT, directory)))
      .flatMap((path) => classNames(path).flatMap((value) => {
        const tokens = value.trim().split(/\s+/);
        if (!tokens.includes("ts") || tokens.includes("ground") || tokens.includes("ground-muted")) return [];
        return [`${relative(ROOT, path)}: ${value.trim()}`];
      }));
    expect(failures).toEqual([]);
  });
});
