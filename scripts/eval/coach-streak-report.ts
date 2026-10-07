import type {
  CoachCase,
  CoachCaseCategory,
  StreakRunConfig,
  StreakState,
} from "./coach-streak-state";

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function latencyRows(state: StreakState): string[] {
  return (["fast", "llm"] as const).map((path) => {
    const values = state.turns.filter((turn) => turn.path === path).map((turn) => turn.elapsedMs);
    const bound = path === "fast" ? 2_000 : 15_000;
    const p50 = percentile(values, 0.5);
    const p95 = percentile(values, 0.95);
    return `| ${path} | ${values.length} | ${p50 ?? "—"} | ${p95 ?? "—"} | < ${bound} |`;
  });
}

function categoryRows(
  state: StreakState,
  config: StreakRunConfig,
  corpus: CoachCase[],
): string[] {
  const byId = new Map(corpus.map((item) => [item.id, item.category]));
  const categories = config.category
    ? [config.category]
    : [...new Set(state.turns.map((turn) => turn.category ?? byId.get(turn.caseId))
        .filter((category): category is CoachCaseCategory => category !== undefined))].sort();
  return categories.map((category) => {
    const turns = state.turns.filter((turn) => (turn.category ?? byId.get(turn.caseId)) === category);
    let streak = 0;
    for (const turn of turns) streak = turn.passed ? streak + 1 : 0;
    const failures = state.failures.filter((failure) => byId.get(failure.caseId) === category);
    const open = failures.filter((failure) => failure.status === "open").length;
    const resolved = failures.length - open;
    const status = config.category === category ? state.status
      : open > 0 ? "open" : failures.length > 0 ? "resolved" : "clear";
    return `| ${category} | ${streak} | ${turns.length} | ${failures.length} `
      + `(${resolved} resolved, ${open} open) | ${status} |`;
  });
}

export function renderReportMarkdown(
  state: StreakState,
  config: StreakRunConfig,
  corpus: CoachCase[],
): string {
  const open = state.failures.filter((failure) => failure.status === "open").length;
  const resolved = state.failures.length - open;
  const turns = state.turns.length === 0
    ? "No turns recorded."
    : [
        "| # | Case | Path | Latency ms | Actions | Blocks | Cards | Result | Proof |",
        "|---:|---|---|---:|---|---|---:|---|---|",
        ...state.turns.map((turn) => `| ${turn.turn} | ${turn.caseId} | ${turn.path} | `
          + `${turn.elapsedMs} | ${turn.actions.join(", ") || "none"} | `
          + `${turn.blocks?.join(", ") || "none"} | ${turn.cards} | `
          + `${turn.passed ? "pass" : "fail"} | \`${turn.proofPath}\` |`),
      ].join("\n");
  const failures = state.failures.length === 0
    ? "No failures. No regression tests were needed."
    : state.failures.map((failure) => [
        `### ${failure.id} — ${failure.caseId}`,
        "",
        `- Turn JSON: \`${failure.proofPath}\``,
        `- Status: ${failure.status}`,
        `- Diagnosis: ${failure.diagnosis ?? "untriaged"}`,
        `- Resolution: ${failure.resolution ?? "pending"}`,
        `- Regression test: ${failure.regressionTest ? `\`${failure.regressionTest}\`` : "not applicable"}`,
      ].join("\n")).join("\n\n");
  const blockers = (state.blockers ?? []).length === 0
    ? "No setup blockers."
    : (state.blockers ?? []).map((blocker) => `- ${blocker.reason} — `
      + `${blocker.resolution ?? "unresolved"}`).join("\n");
  return `# ${config.title}

- Terminal state: **${state.status}**
- Supabase branch: \`${state.branch}\` (shared; not reset or destroyed)
- Category: **${state.category ?? "all"}**
- Seed: \`${state.seed}\`
- Current streak: **${state.streak}/${config.streakTarget}**
- Total cases run: **${state.totalTurns}/${config.turnLimit}**
- Failures: **${state.failures.length}** (${resolved} resolved, ${open} open)
- Evaluation: **${state.evaluation?.mode === "offline"
    ? `re-derived offline from ${state.evaluation.storedTurns ?? state.turns.length} stored turn JSONs; no network or provider calls`
    : "live turns"}**
${state.warming ? `- Facet warming: **${state.warming.foods} foods, ${state.warming.calls} calls, $${state.warming.costUsd.toFixed(8)}**\n` : ""}
${state.warming?.targetLine ? `- Facet warming target: **\`${state.warming.targetLine}\`**\n` : ""}
${state.providerSpend ? `- Provider spend: **$${state.providerSpend.totalUsd.toFixed(8)}** (${state.providerSpend.providers.map((provider) => `${provider.provider}: ${provider.calls} calls, $${provider.costUsd.toFixed(8)}, ${provider.modelIds.join(", ")}`).join("; ")})\n` : ""}
- Updated: ${state.updatedAt}
${state.blockedReason ? `- Blocker: ${state.blockedReason}\n` : ""}
## Category summary

| Category | Current streak | Turns | Failures | Status |
|---|---:|---:|---|---|
${categoryRows(state, config, corpus).join("\n")}

## Latency by actual path

| Path | n | p50 ms | p95 ms | Per-turn bound ms |
|---|---:|---:|---:|---:|
${latencyRows(state).join("\n")}

## Turns

${turns}

## Failures and resolutions

${failures}

## Setup blockers

${blockers}
`;
}
