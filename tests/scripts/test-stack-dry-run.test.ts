/**
 * Proves scripts/test-stack.sh's port-conflict guard without needing a real Docker container:
 * `--dry-run` runs only the pre-start checks (no stack is started, no file is written), and
 * `TEST_STACK_DOCKER_PS_OUTPUT` / `TEST_STACK_PORT_LISTENING_OVERRIDE` let this test feed it
 * fixture `docker ps` / "is this port listening" results in place of live calls, exactly the way
 * the script's own `docker_ps_text()` / `port_is_listening()` document — and only under
 * `--dry-run`, which is itself one of the three things this file proves.
 *
 * This is what item #17 of fix/followups-tests-infra asked to prove: that the script actually
 * refuses to proceed when one of its target ports is already held by a different project's
 * container (or by anything else, Docker or not), instead of trusting the port number alone.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../scripts/test-stack.sh");

function run(args: string[], env: Record<string, string> = {}):
    { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync(SCRIPT, args, { encoding: "utf8", env: { ...process.env, ...env } });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

function dryRun(dockerPsOutput: string, extraEnv: Record<string, string> = {}):
    { status: number; stderr: string; stdout: string } {
  return run(["--dry-run"], { TEST_STACK_DOCKER_PS_OUTPUT: dockerPsOutput, ...extraEnv });
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

  it("refuses, non-zero, when a NON-Docker process holds a port docker ps says nothing about", () => {
    // `docker ps` is empty for this port (no container claims it), but something is still
    // listening — the gap a plain docker-ps-only check would miss.
    const result = dryRun("", { TEST_STACK_PORT_LISTENING_OVERRIDE: "56322" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("127.0.0.1:56322");
    expect(result.stderr).toContain("doesn't explain");
  });

  it("ignores both fixture env vars once DRY_RUN is 0, even if they claim a conflict", () => {
    // Exercises assert_no_port_conflict() directly (DRY_RUN left at its real-run default of 0)
    // instead of going through `start`, so this never touches real Docker. With DRY_RUN=0 the
    // function must fall back to the real `docker ps` / `lsof`, which — on this machine, right
    // now — report nothing on these three ports, so a conflict-claiming fixture must be ignored.
    const probe = `
      set -euo pipefail
      source "${SCRIPT}"
      if assert_no_port_conflict; then echo DRY_RUN_0_RESULT=no-conflict; else echo DRY_RUN_0_RESULT=conflict; fi
    `;
    const stdout = execFileSync("bash", ["-c", probe], {
      encoding: "utf8",
      env: {
        ...process.env,
        TEST_STACK_DOCKER_PS_OUTPUT: "supabase_db_posture-ai\t0.0.0.0:56322->5432/tcp",
        TEST_STACK_PORT_LISTENING_OVERRIDE: "56321,56322,56320",
      },
    });
    expect(stdout).toContain("DRY_RUN_0_RESULT=no-conflict");
  });
});
