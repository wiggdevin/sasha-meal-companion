// Audit 2026-10-01: the coach routes tested `!process.env.COACH_ENABLED`, so "0" hid the coach in
// the app while its API and the Gemini weekly-review cron kept running. One helper reads the flag.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { coachEnabled } from "@/lib/capabilities";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("the coach switch", () => {
  it("is on only for 1 or true", () => {
    expect(coachEnabled({ COACH_ENABLED: "1" })).toBe(true);
    expect(coachEnabled({ COACH_ENABLED: "true" })).toBe(true);
    for (const value of ["0", "false", "", "maybe", undefined]) {
      expect(coachEnabled({ COACH_ENABLED: value }), String(value)).toBe(false);
    }
  });

  it("is read only through coachEnabled outside lib/capabilities.ts", () => {
    const root = process.cwd();
    const offenders = ["app", "lib", "components"].flatMap((dir) => sources(path.join(root, dir)))
      .filter((file) => !file.endsWith(path.join("lib", "capabilities.ts")))
      .filter((file) => /process\.env\.COACH_ENABLED/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));
    expect(offenders).toEqual([]);
  });
});
