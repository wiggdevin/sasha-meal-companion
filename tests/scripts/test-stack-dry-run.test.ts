/**
 * Proves scripts/test-stack.sh's port-conflict guard without needing a real Docker container:
 * `--dry-run` runs only the pre-start checks (no stack is started, no file is written), and
 * `TEST_STACK_DOCKER_PS_OUTPUT` lets this test feed it fixture `docker ps` text in place of a
 * live call, exactly the way the script's own `docker_ps_text()` documents.
 *
 * This is what item #17 of fix/followups-tests-infra asked to prove: that the script actually
 * refuses to proceed when one of its target ports is already held by a different project's
 * container, instead of trusting the port number alone.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../scripts/test-stack.sh");

function dryRun(dockerPsOutput: string): { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync(SCRIPT, ["--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, TEST_STACK_DOCKER_PS_OUTPUT: dockerPsOutput },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("scripts/test-stack.sh --dry-run", () => {
  it("refuses, non-zero, when a DIFFERENT project's container holds one of its ports", () => {
    const result = dryRun(
      "supabase_db_posture-ai\t0.0.0.0:56322->5432/tcp\n" +
      "supabase_kong_posture-ai\t0.0.0.0:55321->8000/tcp",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("supabase_db_posture-ai");
    expect(result.stderr).toContain("56322");
    expect(result.stderr).toMatch(/not mc-care-test/);
  });

  it("refuses, non-zero, when meal-companion's own dev-stack container holds the API port", () => {
    const result = dryRun("supabase_kong_meal-companion\t0.0.0.0:56321->8000/tcp");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("supabase_kong_meal-companion");
  });

  it("passes when the ports are free", () => {
    const result = dryRun("supabase_db_meal-companion\t0.0.0.0:54322->5432/tcp");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry run OK");
  });

  it("passes when the container already running on those ports is mc-care-test's own", () => {
    const result = dryRun("supabase_db_mc-care-test\t0.0.0.0:56322->5432/tcp");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry run OK");
  });
});
