/**
 * sol FIX (p13-s3 fix round), spec §9 R5: docs/research/dietary-profiles.draft.json is validated
 * at BUILD time — `pnpm build` runs scripts/check-dietary-profiles.ts before `next build`, and
 * that check has to fail on a broken document, or it is decoration.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DOC = "docs/research/dietary-profiles.draft.json";

function check(file: string): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/check-dietary-profiles.ts", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? 1, out: String(err.stderr ?? "") };
  }
}

function brokenCopy(edit: (doc: { profiles: Record<string, unknown>[] }) => void): string {
  const doc = JSON.parse(readFileSync(DOC, "utf8"));
  edit(doc);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "p13-profiles-")), "profiles.json");
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

describe("scripts/check-dietary-profiles.ts", () => {
  it("passes on the document as it stands", () => {
    expect(check(DOC).code).toBe(0);
  });

  it("fails on a profile reference that does not resolve", () => {
    const file = brokenCopy((doc) => {
      doc.profiles[0].hard_avoid_facets = ["no_such_facet_anywhere"];
    });
    const result = check(file);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/no_such_facet_anywhere/);
  });

  it("fails on a time_window with no typed classification", () => {
    const file = brokenCopy((doc) => {
      doc.profiles[0].time_window = { type: "only on full moons" };
    });
    const result = check(file);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/time_window/);
  });

  it("runs before next build in the package's build script", () => {
    const build: string = JSON.parse(readFileSync("package.json", "utf8")).scripts.build;
    expect(build.indexOf("scripts/check-dietary-profiles.ts")).toBeGreaterThanOrEqual(0);
    expect(build.indexOf("scripts/check-dietary-profiles.ts")).toBeLessThan(build.indexOf("next build"));
  });
});
