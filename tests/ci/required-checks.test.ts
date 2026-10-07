import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Branch protection requires the checks named Quality, Integration and Build (2026-10-04). Quality
 * is a gate job over parallel shards, one short job that would pass on its own if edited
 * carelessly. These rules hold it to failing unless every job it covers passed (Grok 4.6 CI
 * review, 2026-10-04), and pin each test command to its exact line: a substring check accepted
 * `run: echo pnpm test …`, which runs nothing (GPT-6 Sol review, 2026-10-04).
 */
const root = path.join(__dirname, "..", "..");
const workflow = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");

function job(id: string): string {
  const block = workflow.match(new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"))?.[1];
  if (!block) throw new Error(`no job ${id}`);
  return block;
}

describe("required CI checks", () => {
  it("keeps exactly one job for each required check name", () => {
    for (const name of ["Quality", "Integration", "Build"]) {
      expect(workflow.match(new RegExp(`^    name: ${name}$`, "gm"))?.length).toBe(1);
    }
  });

  it("makes Quality a gate that fails unless lint, types and every unit shard succeeded", () => {
    const gate = job("quality");
    expect(gate).toContain("name: Quality");
    expect(gate).toMatch(/needs: \[static, unit\]/);
    // always(), not !cancelled(): a skipped required check can count as passing.
    expect(gate).toMatch(/if: always\(\)/);
    expect(gate).toContain('test "${{ needs.static.result }}" = success');
    expect(gate).toContain('test "${{ needs.unit.result }}" = success');
    expect(gate).not.toMatch(/continue-on-error|!= failure|\|\|\s*(true|exit 0)/);
  });

  it("runs the integration suite in the job that reports Integration", () => {
    const integration = job("integration");
    expect(integration).toContain("name: Integration");
    expect(integration).toMatch(/^        run: pnpm test:integration$/m);
    expect(integration).not.toMatch(/continue-on-error|strategy:|--shard/);
  });

  it("gives every unit shard its own slice: the shard count matches the matrix", () => {
    const block = job("unit");
    const shards = block.match(/shard: \[([\d, ]+)\]/)?.[1].split(",").map((n) => Number(n.trim())) ?? [];
    expect(shards.length).toBeGreaterThan(1);
    expect(shards).toEqual(shards.map((_, index) => index + 1));
    const run = new RegExp(`^        run: pnpm test --shard=\\$\\{\\{ matrix\\.shard \\}\\}/${shards.length}$`, "m");
    expect(block).toMatch(run);
    expect(block).toMatch(/fail-fast: false/);
    expect(block).not.toMatch(/continue-on-error/);
  });
});
