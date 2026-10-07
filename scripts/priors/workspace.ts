/**
 * The offline workspace (spec D10, hard rule H1): raw NHANES and FNDDS files, and every
 * respondent-level frame, stay here. It defaults to ~/Data/nhanes, outside every checkout. A
 * workspace inside the repository is refused unless git ignores it (`.priors-work/` is listed in
 * .gitignore for that case; tests/foods/nhanes-workspace-ignored.test.ts holds both rules).
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const DEFAULT_WORKSPACE = join(homedir(), "Data", "nhanes");
export const IN_REPO_WORKSPACE = ".priors-work";

function insideRepo(repoRoot: string, path: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when git ignores `path` in the checkout at `repoRoot`. */
export function gitIgnores(repoRoot: string, path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", relative(repoRoot, resolve(path))], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The workspace path, or an error when it would put microdata where git can see it. */
export function resolveWorkspace(repoRoot: string, requested = process.env.PRIORS_WORKSPACE): string {
  const path = resolve(requested ?? DEFAULT_WORKSPACE);
  if (insideRepo(repoRoot, path) && !gitIgnores(repoRoot, join(path, "probe.xpt"))) {
    throw new Error(`priors workspace ${path} is inside the repository and not ignored by git (H1)`);
  }
  return path;
}
