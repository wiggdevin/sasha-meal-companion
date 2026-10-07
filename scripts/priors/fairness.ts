/**
 * The offline fairness audit (spec §5, W1b acceptance 4, hard rule H5). It scores the held-out
 * respondents by the survey's race and Hispanic-origin groups. The field is read here and in the
 * report only; it never enters a cohort, a table, a manifest or a snapshot. The national-only model
 * is the fair reference, and a failing node is disabled; the fix is never a race node.
 */
import type { PerRespondent } from "@/scripts/priors/metrics";
import type { Panel } from "@/scripts/priors/panel";

/** The survey's six published groups (codes 1, 2, 3, 4, 6, 7). */
export const AUDIT_GROUPS: readonly { code: number; label: string }[] = [
  { code: 1, label: "Mexican American" }, { code: 2, label: "Other Hispanic" },
  { code: 3, label: "Non-Hispanic White" }, { code: 4, label: "Non-Hispanic Black" },
  { code: 6, label: "Non-Hispanic Asian" }, { code: 7, label: "Other or multiple" },
];

/** A group may fall at most 1 point below the national model; the largest gap may grow at most 2. */
export const GROUP_DROP_MAX = 0.01;
export const GAP_GROWTH_MAX = 0.02;

export type GroupRow = { label: string; respondents: number; national: number; node: number; change: number };
export type FairnessResult = { rows: GroupRow[]; gapNational: number; gapNode: number; pass: boolean; reasons: string[] };

export function fairnessAudit(panel: Panel, national: PerRespondent, node: PerRespondent): FairnessResult {
  const rows = AUDIT_GROUPS.map(({ code, label }) => {
    let w = 0, a = 0, b = 0, respondents = 0;
    for (let i = 0; i < panel.n; i += 1) {
      if (panel.auditGroup[i] !== code || !national.ranked[i]) continue;
      respondents += 1; w += panel.weight[i];
      a += panel.weight[i] * national.ndcg5[i]; b += panel.weight[i] * node.ndcg5[i];
    }
    return { label, respondents, national: a / w, node: b / w, change: (b - a) / w };
  });
  const gap = (values: number[]) => Math.max(...values) - Math.min(...values);
  const gapNational = gap(rows.map((row) => row.national));
  const gapNode = gap(rows.map((row) => row.node));
  const reasons = rows.filter((row) => row.change < -GROUP_DROP_MAX)
    .map((row) => `${row.label}: NDCG@5 falls ${(-row.change * 100).toFixed(2)} points below the national model`);
  if (gapNode - gapNational > GAP_GROWTH_MAX) reasons.push(`largest group gap grows ${((gapNode - gapNational) * 100).toFixed(2)} points`);
  return { rows, gapNational, gapNode, pass: reasons.length === 0, reasons };
}
