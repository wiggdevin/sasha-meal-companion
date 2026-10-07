import type { CoachCaseCategory } from "./coach-streak-state";

/**
 * The default (no `--category`) streak runs against a persistent, operator-managed Supabase
 * branch. Its name is never hardcoded here — the operator creates the branch once
 * (`scripts/db-branch.sh create <name>`, then `reset` to apply migrations and
 * `supabase/seed/test_helpers.sql`), exports its `SUPABASE_TEST_*` credentials
 * (`scripts/db-branch.sh env <name>`), and sets `COACH_STREAK_BRANCH=<name>` (or passes
 * `--branch <name>` on the CLI). As of 2026-10-03 the maintained branch is `coach-eval`
 * (documented in AGENTS.md). A missing value fails loudly instead of silently reusing a branch
 * name that may no longer exist.
 */
export function defaultBranch(cliOverride: string | null): string {
  const branch = cliOverride ?? process.env.COACH_STREAK_BRANCH?.trim() ?? "";
  if (!branch) {
    throw new Error(
      "No branch given for the default coach-streak run. Pass --branch <name> or export " +
        "COACH_STREAK_BRANCH=<name> (the maintained branch is `coach-eval` — see AGENTS.md). " +
        "Create it first with scripts/db-branch.sh create <name>, apply migrations and test " +
        "helpers with scripts/db-branch.sh reset <name>, then export its credentials with " +
        "scripts/db-branch.sh env <name>.",
    );
  }
  return branch;
}

/**
 * Whether openHarness should turn on COACH_ACTIVITY_CONTEXT_ENABLED for this run: true for a
 * dedicated `--category activity` run, and also for the default (category === null) run, whose
 * corpus draw spans every category — loadCorpus's expectedCounts requires exactly one "activity"
 * case, so the default run can draw it and needs the flag on to have any chance of passing it.
 */
export function needsActivityContext(category: CoachCaseCategory | null): boolean {
  return category === "activity" || category === null;
}
