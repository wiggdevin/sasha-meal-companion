export type HeightUnit = "ft_in" | "cm";

export const CM_MIN = 50;
export const CM_MAX = 260;
export const FEET_MIN = 3;
export const FEET_MAX = 8;
export const INCHES_MIN = 0;
export const INCHES_MAX = 11;

const CM_PER_INCH = 2.54;
const INCHES_PER_FOOT = 12;

export function cmToFtIn(cm: number): { ft: number; in: number } {
  const roundedInches = Math.round(cm / CM_PER_INCH);
  return {
    ft: Math.floor(roundedInches / INCHES_PER_FOOT),
    in: roundedInches % INCHES_PER_FOOT,
  };
}

export function ftInToCm(ft: number, inches: number): number {
  return Math.round((ft * INCHES_PER_FOOT + inches) * CM_PER_INCH * 10) / 10;
}

export function isValidCm(cm: number): boolean {
  return Number.isFinite(cm) && cm >= CM_MIN && cm <= CM_MAX;
}

export function isValidFtIn(ft: number, inches: number): boolean {
  return Number.isInteger(ft) && ft >= FEET_MIN && ft <= FEET_MAX
    && Number.isInteger(inches) && inches >= INCHES_MIN && inches <= INCHES_MAX;
}

export function formatHeight(cm: number | null, unit: HeightUnit): string {
  if (cm === null || !Number.isFinite(cm)) return "—";
  if (unit === "cm") return `${Math.round(cm * 10) / 10} cm`;
  const imperial = cmToFtIn(cm);
  return `${imperial.ft} ft ${imperial.in} in`;
}
