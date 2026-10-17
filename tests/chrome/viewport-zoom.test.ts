import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("root viewport", () => {
  it("keeps pinch-zoom available", () => {
    const src = readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8");
    const block = src.slice(src.indexOf("export const viewport"));
    expect(block).not.toMatch(/userScalable/);
    expect(block).not.toMatch(/maximumScale/);
  });
});
