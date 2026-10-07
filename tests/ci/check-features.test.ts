/**
 * T9 §3: the guard that keeps docs/features.md honest has to fail on a lie, or it is decoration.
 * The real file is checked as it stands, then copies with one row seeded both ways. A row's notes
 * are the WHOLE row — Detail and Acceptance name files as often as Source does — so each seeded
 * lie below sits in a different cell.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function check(file: string): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/check-features.ts", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? 1, out: String(err.stderr ?? "") };
  }
}

/** A copy of the real file with `edit` applied to the cells of its first feature row. */
function seed(edit: (cells: string[]) => void): string {
  const rows = readFileSync("docs/features.md", "utf8").split("\n");
  const i = rows.findIndex((r) => r.startsWith("| F-"));
  const cells = rows[i].split("|");
  edit(cells);
  rows[i] = cells.join("|");
  const file = path.join(mkdtempSync(path.join(tmpdir(), "t9-features-")), "features.md");
  writeFileSync(file, rows.join("\n"));
  return file;
}

describe("scripts/check-features.ts", () => {
  it("passes on the file as it stands", () => {
    expect(check("docs/features.md").code).toBe(0);
  });

  it("fails on a row that reads planned while naming a file that exists", () => {
    const markdown = readFileSync("docs/features.md", "utf8");
    const rows = markdown.split("\n");
    const i = rows.findIndex((r) => r.startsWith("| F-") && r.includes("| exists |")
      && /`[\w./-]+\.tsx?`/.test(r.split("|")[6] ?? ""));
    expect(i).toBeGreaterThan(-1);
    rows[i] = rows[i].replace("| exists |", "| planned |");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "t9-features-")), "features.md");
    writeFileSync(file, rows.join("\n"));

    const seeded = check(file);
    expect(seeded.code).toBe(1);
    expect(seeded.out).toContain('reads "planned" but');
  });

  it("fails on a planned row whose Detail claims a built file is not built", () => {
    const file = seed((cells) => {
      cells[5] = " planned ";
      cells[3] = " The bit nobody built yet, allegedly in `lib/units.ts`. ";
    });
    const seeded = check(file);
    expect(seeded.code).toBe(1);
    expect(seeded.out).toContain("`lib/units.ts` exists");
  });

  it("sees the extensions the repo actually ships", () => {
    // A .js/.mjs script, a stylesheet or an svg named in a row is as much a claim as a .ts file.
    for (const ext of ["js", "jsx", "mjs", "cjs", "css", "svg", "json", "yml", "yaml",
      "ts", "tsx", "sql", "py", "md", "sh"]) {
      const file = seed((cells) => {
        cells[5] = " exists ";
        cells[3] = ` Built, in \`lib/there-is-no-such-module.${ext}\`. `;
      });
      expect(check(file).code, ext).toBe(1);
    }
    // One cold `npx tsx` child-process spawn per extension (15 total). Under the full suite's
    // default parallelism — many worker processes contending for CPU at once — each cold start can
    // take well over a second, so 30s was still too tight; observed flake needed more headroom.
  }, 90_000);

  it("ignores a backticked name with no extension rather than guessing", () => {
    const file = seed((cells) => {
      cells[5] = " planned ";
      cells[3] = " Not built; nothing to do with `lib` or `scripts`. ";
      cells[6] = " v2 §1 — missing: all of it ";   // a planned row names no file
    });
    expect(check(file).code).toBe(0);
  });

  it("fails on a lie seeded in the Acceptance cell, the far end of the row", () => {
    const planned = seed((cells) => {
      cells[5] = " planned ";
      cells[6] = " v2 §1 — missing: all of it ";
      cells[7] = " Nothing built, though `lib/units.ts` would be where it went. ";
    });
    expect(check(planned).code).toBe(1);
    expect(check(planned).out).toContain("`lib/units.ts` exists");

    const exists = seed((cells) => {
      cells[5] = " exists ";
      cells[7] = " Proven by `tests/there-is-no-such-suite.test.ts`. ";
    });
    expect(check(exists).code).toBe(1);
    expect(check(exists).out).toContain("`tests/there-is-no-such-suite.test.ts` does not");
    // Four cold `npx tsx` spawns (check() is called twice per seeded file, to read both `code`
    // and `out`), not two — 10s still wasn't enough headroom under real full-suite parallelism
    // (observed timing out at ~10.1-12.1s even at default parallelism across repeated runs).
  }, 20_000);

  it("reads an @/-prefixed path the way the code imports it", () => {
    const planned = seed((cells) => {
      cells[5] = " planned ";
      cells[6] = " v2 §1 — missing: all of it ";
      cells[3] = " Not built, though `@/lib/units.ts` is where it would go. ";
    });
    expect(check(planned).code).toBe(1);

    const exists = seed((cells) => {
      cells[5] = " exists ";
      cells[3] = " Built, in `@/lib/there-is-no-such-module.ts`. ";
    });
    expect(check(exists).code).toBe(1);
  }, 10_000);   // two child-process checks can exceed Vitest's default under full-suite load

  it("reads a disposition whatever its case", () => {
    const shouted = seed((cells) => {
      cells[5] = " Planned ";
      cells[6] = " v2 §1 — missing: all of it ";
      cells[3] = " Not built, allegedly `lib/units.ts`. ";
    });
    expect(check(shouted).code).toBe(1);
    expect(check(shouted).out).toContain("`lib/units.ts` exists");
  }, 10_000);   // two child-process checks can exceed Vitest's default under full-suite load

  it("fails on an exists row whose Detail names a file that is not there", () => {
    const file = seed((cells) => {
      cells[5] = " exists ";
      cells[3] = " Built, in `lib/there-is-no-such-module.ts`. ";
    });
    const seeded = check(file);
    expect(seeded.code).toBe(1);
    expect(seeded.out).toContain("`lib/there-is-no-such-module.ts` does not");
  });
});
