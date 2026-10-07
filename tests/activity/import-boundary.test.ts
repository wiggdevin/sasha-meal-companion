import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const forbidden = /(?:from|import\s*)\s*[('"`]@?\/?(?:[^'"`]*\/)?lib\/(?:activity(?:\/|['"`])|expenditure(?:['"`]|\.))/;

describe("activity import boundary", () => {
  it("keeps profile and target authority independent from activity and expenditure", () => {
    const files = [
      "lib/profile/energy.ts",
      "lib/profile/derive.ts",
      ...readdirSync("lib/targets", { recursive: true })
        .filter((file) => String(file).endsWith(".ts"))
        .map((file) => `lib/targets/${String(file)}`),
    ];
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(forbidden);
  });

  it("keeps the activity summary upstream of the expenditure engine", () => {
    expect(readFileSync("lib/activity/summary.ts", "utf8")).not.toMatch(/lib\/expenditure/);
  });
});
