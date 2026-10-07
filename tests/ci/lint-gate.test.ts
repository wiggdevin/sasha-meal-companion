import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Finding #74: eslint-config-next ships every rule at warn-level and the
 * "lint" script runs bare `eslint` with no --max-warnings flag, so a PR that
 * introduces a new warning (unused import, missing hook dep, another
 * window.location.assign) exits 0 and the CI Lint step can never catch it.
 */
describe("lint CI gate", () => {
  it("enforces zero warnings so a new eslint-config-next warning fails the gate", () => {
    const pkgPath = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.lint).toMatch(/--max-warnings[= ]0\b/);
  });
});
