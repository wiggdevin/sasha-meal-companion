/**
 * GPT-6 Sol review round 2 (spec lens), BLOCK: the committed 2026-09-23 rescore
 * (docs/evals/2026-09-23-lane-bench.{md,json}, commit adaaeec) went stale the moment a later
 * commit in the SAME diff (9fec0a1, "check chart captions for contradiction, not only the series
 * label") changed score.ts again. Nothing caught it: the existing `--rescore` CLI test
 * (tests/eval/lane-bench-rescore-cli.test.ts) only proves the documented command RUNS to
 * completion, never that the committed output still matches what the CURRENT scorer says about
 * the same saved answers — exactly the class of drift the earlier rescore fix (Finding 1 of the
 * prior round) was supposed to make impossible to ship undetected, and it shipped again in the
 * same diff.
 *
 * This closes that gap directly: it recomputes `correct` for every attempt in the committed JSON
 * from score.ts's live `isCorrect`, against the fixture each attempt's `caseId` names, and
 * compares it to what is actually committed. A score.ts change that is not followed by a fresh
 * `--rescore` of docs/evals/2026-09-23-lane-bench.json fails here, at review time, instead of
 * only being caught by a reviewer's manual reproduction.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isCorrect, type Attempt, type Expect } from "@/scripts/eval/lane-bench/score";

const REPO_ROOT = path.resolve(__dirname, "../..");

type Fixtures = Record<string, { cases: { id: string; expect: Expect }[] }>;
type SavedAttempt = Attempt & { value?: unknown };

describe("docs/evals/2026-09-23-lane-bench.json freshness", () => {
  it("is not stale: every attempt's committed `correct` matches what the CURRENT score.ts says " +
    "about the same saved answer", () => {
    const fixtures = JSON.parse(readFileSync(
      path.join(REPO_ROOT, "scripts/eval/lane-bench/fixtures.json"), "utf8")) as Fixtures;
    const saved = JSON.parse(readFileSync(
      path.join(REPO_ROOT, "docs/evals/2026-09-23-lane-bench.json"), "utf8")) as
      { attempts: SavedAttempt[] };

    const expectFor = (lane: string, caseId: string): Expect => {
      const item = fixtures[lane]?.cases.find((c) => c.id === caseId);
      if (!item) throw new Error(`unknown ${lane} case ${caseId}`);
      return item.expect;
    };

    const stale: string[] = [];
    for (const attempt of saved.attempts) {
      const want = attempt.schemaValid && isCorrect(expectFor(attempt.lane, attempt.caseId), attempt.value);
      if (attempt.correct !== want) {
        stale.push(`${attempt.lane}/${attempt.model}/${attempt.caseId}: committed correct=` +
          `${attempt.correct}, current scorer says ${want}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
