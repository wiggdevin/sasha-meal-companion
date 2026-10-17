/**
 * W104: the read-only recovery count for the diet-label parser (lib/policy/diet-label.ts). For every
 * account with Eats foods it judges each Eats food twice on the evidence the app reads, once with
 * the parser off (today) and once with it on, and prints counts only: how many move from
 * `unverified` to `allowed` (the 36 of docs/audit/2026-10-05-w2c-impact.md are the target), and any
 * other move, which must be 0. No food name, food id or rule text is printed; account ids are a
 * truncated SHA-256.
 *
 *   pnpm exec tsx --conditions=react-server scripts/diet-label-recovery.ts
 *
 * Env: the service-role pair lib/server/admin.ts reads. It takes no flag and never writes: every
 * read goes through the W2c report's `readOnlyClient` (scripts/diet-rule-jev-impact.ts). The parser
 * is turned on in this process only.
 */
import { fileURLToPath } from "node:url";
import { suggestionFoodIdentity, suggestionPolicyEvidence } from "@/lib/coach/suggest-verdict";
import { evaluatePolicy, type ConstraintProfile } from "@/lib/policy/constraints";
import { overrideDietLabelClearanceForReport } from "@/lib/policy/diet-label";
import type { SuggestionEvidence } from "@/lib/coach/suggest-policy";
import {
  accountLabel, assertReportArgs, databasePorts, type EatsItem, type ImpactPorts,
} from "@/scripts/diet-rule-jev-impact";

export type RecoveryRow = {
  account: string;
  eatsFoods: number;
  unverifiedBefore: number;
  /** Eats foods the parser recovers: `unverified` today, `allowed` with the parser on. */
  recovered: number;
  /** Any other move. The parser only clears, so this must be 0. */
  otherMoves: number;
  evidenceUnavailable: boolean;
};

type Verdict = "allowed" | "unverified" | "blocked";

/** One account's counts. Pure apart from the parser switch, which it restores. */
export function accountRecovery(input: {
  userId: string; items: readonly EatsItem[]; unresolved: number;
  profile: ConstraintProfile; evidence: SuggestionEvidence;
}): RecoveryRow {
  const row: RecoveryRow = {
    account: accountLabel(input.userId), eatsFoods: input.items.length + input.unresolved,
    unverifiedBefore: 0, recovered: 0, otherMoves: 0,
    evidenceUnavailable: input.evidence.status !== "ready",
  };
  if (row.evidenceUnavailable) return row;
  for (const item of input.items) {
    const facts = input.evidence.byIdentity[suggestionFoodIdentity(item)];
    const e = suggestionPolicyEvidence(item.foodRefId, facts, input.evidence.preferenceFlags,
      input.profile);
    const judge = (on: boolean): Verdict => {
      overrideDietLabelClearanceForReport(on);
      try {
        return evaluatePolicy(input.profile, e).verdict;
      } finally {
        overrideDietLabelClearanceForReport(false);
      }
    };
    const before = judge(false);
    const after = judge(true);
    if (before === "unverified") row.unverifiedBefore += 1;
    if (before === "unverified" && after === "allowed") row.recovered += 1;
    else if (before !== after) row.otherMoves += 1;
  }
  return row;
}

export async function runRecovery(ports: ImpactPorts, print: (line: string) => void): Promise<void> {
  const rows: RecoveryRow[] = [];
  for (const userId of await ports.accounts()) {
    const [{ items, unresolved }, profile] = await Promise.all([
      ports.eatsItems(userId), ports.profile(userId)]);
    if (items.length + unresolved === 0) continue;
    const evidence = await ports.evidence(userId, items, profile);
    const row = accountRecovery({ userId, items, unresolved, profile, evidence });
    rows.push(row);
    print(JSON.stringify(row));
  }
  const sum = (key: "eatsFoods" | "unverifiedBefore" | "recovered" | "otherMoves") =>
    rows.reduce((total, row) => total + row[key], 0);
  print(JSON.stringify({ totals: { accounts: rows.length, eatsFoods: sum("eatsFoods"),
    unverifiedBefore: sum("unverifiedBefore"), recovered: sum("recovered"),
    otherMoves: sum("otherMoves"),
    accountsEvidenceUnavailable: rows.filter((row) => row.evidenceUnavailable).length } }));
}

export async function main(argv: string[]): Promise<void> {
  assertReportArgs(argv);
  const { adminClient } = await import("@/lib/server/admin");
  await runRecovery(databasePorts(adminClient()), (line) => console.log(line));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
