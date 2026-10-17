/**
 * W004 (audit 2026-10-10, A008): one fixture for the one energy rule, read by every twin that
 * applies it — `lib/nutrients/energy.ts` (`itemEnergy`), the recipe sum `lib/recipes/nutrients.ts`
 * and its SQL twin in `_sync_upsert` (migration 20261230090400_recipe_energy_rule). Each case is one
 * item's per-100 g energy fields as a snapshot stores them (`{ code: { amount } }`), and the kcal
 * the rule selects: reported when it is a JSON number >= 0, else calculated under the same test,
 * else unknown (`null`, never 0).
 *
 * Every amount is JSON-representable, so the same cases go into Postgres as jsonb unchanged.
 */
export type EnergyRuleCase = {
  name: string;
  snapshot: Record<string, { amount: number | string | null }>;
  kcal: number | null;
};

export const ENERGY_RULE_CASES: readonly EnergyRuleCase[] = [
  { name: "reported wins over calculated",
    snapshot: { energy_kcal: { amount: 100 }, energy_kcal_calc: { amount: 95 } }, kcal: 100 },
  { name: "reported null falls back to calculated",
    snapshot: { energy_kcal: { amount: null }, energy_kcal_calc: { amount: 80 } }, kcal: 80 },
  { name: "calculated only (a Foundation food with no 1008 row)",
    snapshot: { energy_kcal_calc: { amount: 80 } }, kcal: 80 },
  { name: "a reported 0 is a measured zero",
    snapshot: { energy_kcal: { amount: 0 }, energy_kcal_calc: { amount: 12 } }, kcal: 0 },
  { name: "a negative reported amount falls back",
    snapshot: { energy_kcal: { amount: -1 }, energy_kcal_calc: { amount: 80 } }, kcal: 80 },
  { name: "a string reported amount falls back",
    snapshot: { energy_kcal: { amount: "100" }, energy_kcal_calc: { amount: 80 } }, kcal: 80 },
  { name: "no energy field at all is unknown",
    snapshot: {}, kcal: null },
  { name: "both fields null is unknown",
    snapshot: { energy_kcal: { amount: null }, energy_kcal_calc: { amount: null } }, kcal: null },
];

/** The macros every case also carries, so a recipe's coverage is decided by energy alone. */
export const MEASURED_MACROS = { protein: 1, carbohydrate: 1, fat_total: 1, fiber_total: 1 } as const;
