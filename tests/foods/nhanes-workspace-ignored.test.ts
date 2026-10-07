/**
 * Phase 18 W1b hard rule H1, the .gitignore test (docs/specs/phase-18-open-world-foods.md D10): raw
 * NHANES files and respondent frames stay in the offline workspace and are never committed. The
 * default workspace is outside the checkout; an in-repo workspace must be git-ignored, and
 * `.priors-work/` is.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE, gitIgnores, IN_REPO_WORKSPACE, resolveWorkspace } from "@/scripts/priors/workspace";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

describe("H1: the offline workspace is never tracked", () => {
  it("defaults outside the repository", () => {
    expect(DEFAULT_WORKSPACE.startsWith(homedir())).toBe(true);
    expect(path.relative(root, DEFAULT_WORKSPACE).startsWith("..")).toBe(true);
    expect(resolveWorkspace(root, DEFAULT_WORKSPACE)).toBe(DEFAULT_WORKSPACE);
  });

  it("git ignores the in-repo workspace path", () => {
    expect(gitIgnores(root, path.join(root, IN_REPO_WORKSPACE, "raw", "P_DR1IFF.xpt"))).toBe(true);
    expect(resolveWorkspace(root, path.join(root, IN_REPO_WORKSPACE))).toBe(path.join(root, IN_REPO_WORKSPACE));
  });

  it("refuses an in-repo workspace git would track", () => {
    expect(() => resolveWorkspace(root, path.join(root, "docs", "nhanes"))).toThrow(/not ignored by git/);
    expect(() => resolveWorkspace(root, path.join(root, "lib", "foods", "universe", "artifacts"))).toThrow(/H1/);
  });

  it("tracks no survey file", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
    expect(tracked.filter((file) => /\.xpt$|DR[12]IFF|DEMO_L|P_DEMO/i.test(file))).toEqual([]);
  });
});
