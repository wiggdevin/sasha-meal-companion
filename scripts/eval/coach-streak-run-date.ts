import type { StreakRunConfig } from "./coach-streak-state";

const DEFAULT_RUN_DATE = "2026-09-19";

/**
 * COACH_STREAK_RUN_DATE (YYYY-MM-DD) gives the all-category run its own state, report and turn
 * files, so a re-run never overwrites an earlier run's evidence (W087, 2026-10-17). Unset keeps the
 * 2026-09-19 names. Per-category runs (activity, meals, block, jev) keep their own fixed dates.
 */
export function withRunDate(config: StreakRunConfig, raw: string | undefined = process.env.COACH_STREAK_RUN_DATE): StreakRunConfig {
  const runDate = raw?.trim();
  if (!runDate || config.category !== null) return config;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate)) throw new Error("COACH_STREAK_RUN_DATE must be YYYY-MM-DD.");
  const swap = (value: string) => value.replaceAll(DEFAULT_RUN_DATE, runDate);
  return {
    ...config,
    statePath: swap(config.statePath), reportPath: swap(config.reportPath),
    turnDir: swap(config.turnDir), title: swap(config.title),
  };
}
