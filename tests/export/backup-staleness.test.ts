import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// scripts/backup.sh (the real, retained Mac backup) has no failure or
// staleness alerting: nothing checks whether the newest retained dump is
// missing or too old (docs/audit/2026-09-13 finding #84). This script is the
// "cheap periodic check" the finding's fix calls for.
const SCRIPT = path.resolve(__dirname, "../../scripts/check-backup-staleness.sh");

describe("scripts/check-backup-staleness.sh", () => {
  let dest: string;

  beforeEach(() => {
    dest = mkdtempSync(path.join(tmpdir(), "backup-staleness-"));
  });

  afterEach(() => {
    rmSync(dest, { recursive: true, force: true });
  });

  function run(maxAgeHours: number) {
    return execFileSync("bash", [SCRIPT, dest, String(maxAgeHours)], { encoding: "utf8" });
  }

  it("alerts (non-zero exit) when the newest backup is older than the max age", () => {
    const stale = path.join(dest, "2020-01-01.sql");
    writeFileSync(stale, "-- stale dump\n");
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, twoDaysAgo, twoDaysAgo);

    let threw = false;
    try {
      run(36);
    } catch (err) {
      threw = true;
      const e = err as { status: number | null; stderr: Buffer | string };
      expect(e.status).not.toBe(0);
      // Match the literal computed age/threshold text so this only passes
      // when the staleness branch actually ran (an ENOENT on a missing
      // script also contains "stale" via the script's own filename, so a
      // loose /stale|older than/i match gives no regression protection).
      expect(String(e.stderr)).toMatch(/\d+h old, older than the \d+h staleness threshold/);
    }
    expect(threw).toBe(true);
  });

  it("alerts (non-zero exit) when no backup file exists at all", () => {
    let threw = false;
    try {
      run(36);
    } catch (err) {
      threw = true;
      const e = err as { status: number | null; stderr: Buffer | string };
      expect(e.status).not.toBe(0);
      expect(String(e.stderr)).toMatch(/no .*backup/i);
    }
    expect(threw).toBe(true);
  });

  it("exits 0 when the newest backup is within the max age", () => {
    const fresh = path.join(dest, "2026-09-13.sql");
    writeFileSync(fresh, "-- fresh dump\n");

    const out = run(36);
    expect(out).toMatch(/^ok:/i);
  });
  it("recognizes the new timestamped SQL names", () => {
    writeFileSync(path.join(dest, "2026-09-15T201530Z-0123abcd.sql"), "-- fresh dump\n");
    expect(run(36)).toMatch(/^ok:/i);
  });

});
