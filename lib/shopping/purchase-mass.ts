/** Match PostgreSQL numeric round(value, 4) for sealed purchase mass arithmetic. */
export function purchaseMassGrams(grams: number, consumed: number, servings: number): number {
  const scale = 1_000_000;
  const parts = [grams, consumed, servings].map((value) => {
    const scaled = Math.round(value * scale);
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(scaled)) {
      throw new RangeError("Purchase mass is outside the supported numeric range");
    }
    return BigInt(scaled);
  });
  if (parts[2] === BigInt(0)) throw new RangeError("Recipe servings must be positive");
  const numerator = parts[0] * parts[1] * BigInt(10_000);
  const denominator = parts[2] * BigInt(scale);
  return Number((numerator * BigInt(2) + denominator)
    / (BigInt(2) * denominator)) / 10_000;
}
