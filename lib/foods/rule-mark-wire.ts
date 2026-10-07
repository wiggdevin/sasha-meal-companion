import type { RuleMark } from "@/lib/types";

/**
 * A `ruleMark` read off the wire (the recipe consumed POST, 2026-10-05 F2). Only the two verdicts
 * with a non-empty reason are a mark; anything else (absent, null, malformed) is no mark to show.
 */
export function ruleMarkFromWire(value: unknown): RuleMark | null {
  if (!value || typeof value !== "object") return null;
  const { verdict, reason } = value as { verdict?: unknown; reason?: unknown };
  if ((verdict !== "blocked" && verdict !== "unknown") || typeof reason !== "string" || !reason.trim()) {
    return null;
  }
  return { verdict, reason };
}
