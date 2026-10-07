/**
 * Loop 010, 2026-09-14. 20261014090001 wrote `cups = greatest(water_log.cups, excluded.cups)` so a
 * stale device could not un-drink a cup. It also discarded every deliberate correction while
 * telling the client the write had worked.
 *
 * Measured against the running app: the row held 4 cups at rev 6; a rev-correct update to 2
 * answered {"status":"applied","rev":7} and left the row at 4. In the UI the count drops, a reload
 * pulls the server's value back, and the correction is gone with no error.
 *
 * `rev` is what actually distinguishes a stale write from a current one, so the guard moves there.
 * Verified after the change: the same decrement lands (4 -> 2 at rev 8), and a stale write
 * (rev 3, cups 9) is still refused — the row stayed at 2.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const sqlOnly = (text: string) =>
  text.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

const UP = read("supabase/migrations/20261016090100_water_log_allow_correction.sql");
const DOWN = read("supabase/migrations/down/20261016090100_water_log_allow_correction.down.sql");

describe("20261016090100_water_log_allow_correction", () => {
  it("stops clamping the cup count to the maximum", () => {
    expect(sqlOnly(UP)).not.toContain("greatest(water_log.cups");
  });

  it("writes what she asked for, guarded by rev so a stale device is still refused", () => {
    const sql = sqlOnly(UP);
    expect(sql).toContain("set cups = excluded.cups, rev = excluded.rev");
    expect(sql).toContain("where water_log.rev < excluded.rev");
  });

  it("down restores the clamp, and says that corrections stop working again", () => {
    expect(sqlOnly(DOWN)).toContain("greatest(water_log.cups");
    expect(DOWN).toMatch(/correct/i);
  });

  it("carries forward the duplicate_groups guard from the migration before it", () => {
    expect(sqlOnly(UP)).toContain("where duplicate_groups.rev < excluded.rev");
  });
});
