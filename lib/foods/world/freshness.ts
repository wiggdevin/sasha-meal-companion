/**
 * The open-world freshness token (Phase 18 D11, W2b): two monotonic counters the database moves in
 * the same transaction as the write. `rulesVersion` is the account's rules clock (every rule input:
 * allergens, categories, custom rules, conditions, Avoid marks, diet flags, profile instances,
 * condition confirmations, `food_world`); `evidenceVersion` is the global evidence clock
 * (`food_allergen_evidence`, `policy_categories`). Migrations 20261213090200 to 20261213091200.
 *
 * The rule for every NEW suggestion (layout fill, swap, coach card, recipe): it may be generated
 * only from an admission computed under the token the server reports now. A different counter, or
 * no answer at all (offline), means no new suggestion; an existing plan may still be shown (owner
 * question 6). This module is that rule, pure, for the phone and the server alike.
 *
 * Pure. No I/O.
 */

export type RulesToken = Readonly<{ rulesVersion: number; evidenceVersion: number }>;

const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** A token from the wire, or null for anything malformed (never read as 0). */
export function parseRulesToken(raw: unknown): RulesToken | null {
  if (!raw || typeof raw !== "object") return null;
  const { rulesVersion, evidenceVersion } = raw as Record<string, unknown>;
  return counter(rulesVersion) && counter(evidenceVersion) ? { rulesVersion, evidenceVersion } : null;
}

export function sameRulesToken(a: RulesToken | null, b: RulesToken | null): boolean {
  return a !== null && b !== null && a.rulesVersion === b.rulesVersion
    && a.evidenceVersion === b.evidenceVersion;
}

export type FreshnessVerdict =
  | { fresh: true }
  /** `offline`: the current token could not be read. `stale`: the rules or evidence moved. */
  | { fresh: false; reason: "offline" | "stale" | "unstamped" };

/**
 * Whether an admission stamped with `admittedUnder` may generate a new suggestion, given the token
 * just read from the server (`current`, null when the read failed or the phone is offline).
 */
export function freshness(admittedUnder: RulesToken | null, current: RulesToken | null): FreshnessVerdict {
  if (current === null) return { fresh: false, reason: "offline" };
  if (admittedUnder === null) return { fresh: false, reason: "unstamped" };
  return sameRulesToken(admittedUnder, current) ? { fresh: true } : { fresh: false, reason: "stale" };
}
