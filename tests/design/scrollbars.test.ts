import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No scrollbars anywhere (2026-10-04, owner: "Remove the scroll side bar indicators, we don't like
 * those"; DESIGN.md §Layout). globals.css hides the indicator on html, body and every scroll
 * container; scrolling itself (touch, wheel, keyboard) is untouched. No stylesheet or class may bring
 * an indicator back.
 */
const ROOT = new URL("../../", import.meta.url).pathname;
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");

function files(directory: string, extensions: string[]): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path, extensions);
    return extensions.includes(extname(path)) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

describe("scrollbars", () => {
  it("are hidden on html, body and every element", () => {
    const firefox = /html,\s*body,\s*\*\s*\{[^}]*scrollbar-width:\s*none;/.exec(css);
    const webkit = /html::-webkit-scrollbar,\s*body::-webkit-scrollbar,\s*\*::-webkit-scrollbar\s*\{[^}]*display:\s*none;/.exec(css);
    expect(firefox).not.toBeNull();
    expect(webkit).not.toBeNull();
  });

  it("are hidden without taking scrolling away", () => {
    const rules = [/html,\s*body,\s*\*\s*\{([^}]*)\}/, /\*::-webkit-scrollbar\s*\{([^}]*)\}/]
      .map((pattern) => pattern.exec(css)![1]);
    for (const rule of rules) expect(rule).not.toMatch(/(^|[^-])overflow(-[xy])?\s*:|pointer-events|touch-action/);
  });

  it("are never brought back by a stylesheet or a class", () => {
    const offenders = ["app", "components"].flatMap((root) => files(join(ROOT, root), [".css", ".ts", ".tsx"]))
      .flatMap((path) => {
        const text = readFileSync(path, "utf8");
        const found = [
          ...text.matchAll(/scrollbar-width\s*:\s*(?!none)[a-z]+/g),
          ...text.matchAll(/\[scrollbar-width:(?!none)[a-z]+\]/g),
          ...text.matchAll(/scrollbar-gutter\s*:\s*stable/g),
          ...text.matchAll(/::-webkit-scrollbar(-thumb|-track)?\s*\{(?![^}]*display:\s*none)[^}]*\}/g),
        ];
        return found.map((match) => `${relative(ROOT, path)}: ${match[0]}`);
      });
    expect(offenders).toEqual([]);
  });
});
