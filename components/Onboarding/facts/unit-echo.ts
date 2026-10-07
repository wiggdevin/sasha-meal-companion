/**
 * Onboarding v2, lane 3 — unit-echo copy for the playback sentence (BRIEF.md §2/§4: "5'10 → 178
 * cm" / weight shown the same way). Pure formatting, no new conversion math: it reads the
 * existing `lib/units/height.ts` and `lib/health/units.ts` helpers so a unit bug has one owner.
 */
import { cmToFtIn } from "@/lib/units/height";
import { kgToLb } from "@/lib/health/units";

/**
 * "5'10\" → 178 cm" — BRIEF §2/§4's fixed unit-echo convention: whatever unit the user actually
 * spoke, the chip always shows imperial then the metric value that gets stored, so the mapping
 * is visible either way (Sol r1 WARN: this is a display convention, not a transcript of the
 * words heard — a user who said "178 cm" sees the same imperial-then-metric chip, by design).
 */
export function heightEchoCm(heightCm: number): string {
  const { ft, in: inches } = cmToFtIn(heightCm);
  return `${ft}'${inches}" → ${Math.round(heightCm)} cm`;
}

/** "165 lb → 75 kg" — same convention as height, kept symmetric for the sentence renderer. */
export function weightEchoKg(weightKg: number): string {
  const lb = Math.round(kgToLb(weightKg));
  return `${lb} lb → ${Math.round(weightKg * 10) / 10} kg`;
}

/** "34 → born 1992" — the spoken age mapped to a birth year, always shown together
 *  (BRIEF §2 safety note: "the mapping must always be visible, never silent"). */
export function birthYearEcho(birthYear: number, today = new Date()): string {
  const age = today.getUTCFullYear() - birthYear;
  return `${age} → born ${birthYear}`;
}
