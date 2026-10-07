/**
 * Phase 13 §3.3 and §9 R8 (slice 6): the `lookup` tool's own D0 gate, checked BEFORE any catalog
 * resolution and before any search. `converse` produces a candidate `subject`; this rejects it
 * when it:
 *   - contains a digit sequence other than a single product/barcode number (8-14 digits, the
 *     UPC/EAN/GTIN range) — a weight, a dose or an age is never a product number;
 *   - contains first-person words ("I", "my", "me" — the model wrote a fact about the USER, not
 *     about a food);
 *   - contains the user's name, or a term from their stored conditions or allergens;
 *   - reads as a medical question, reusing the Phase 10 deflection vocabulary
 *     (lib/coach/deflect.ts) so a second word list never drifts from the first.
 *
 * Closes Sol r1 finding 6 ("lookup has no D0 argument"). Pure. No I/O, no Supabase import.
 */
import { classifyMedical } from "@/lib/coach/deflect";

export const MAX_SUBJECT_LENGTH = 80;

export type LookupSubjectContext = {
  userName?: string | null;
  conditions?: readonly string[];
  allergens?: readonly string[];
};

export type SubjectRejectionReason =
  | "empty" | "too_long" | "digits" | "medical" | "first_person" | "name" | "condition" | "allergy";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive: "Sam" matches "Sam's Club" but not "sample". */
function containsWord(haystack: string, needle: string): boolean {
  const word = needle.trim();
  if (word.length === 0) return false;
  return new RegExp(`(^|[^a-z0-9])${escape(word.toLowerCase())}([^a-z0-9]|$)`)
    .test(haystack.toLowerCase());
}

/** True for any digit run except a single 8-14 digit one — the printed barcode length range. */
function hasNonProductDigits(subject: string): boolean {
  const runs = subject.match(/\d+/g) ?? [];
  if (runs.length === 0) return false;
  if (runs.length === 1 && runs[0].length >= 8 && runs[0].length <= 14) return false;
  return true;
}

/** Stripped of the apostrophe, "I'm"/"I've"/"I'll"/"I'd" read as "im"/"ive"/"ill"/"id". */
const FIRST_PERSON = /\b(i|im|ive|id|ill|me|my|mine|myself)\b/;

/** The one rejection reason, or null when `converse`'s candidate may go on to catalog resolution. */
export function validateLookupSubject(
  candidate: string,
  ctx: LookupSubjectContext = {},
): SubjectRejectionReason | null {
  const subject = String(candidate).trim();
  if (subject.length === 0) return "empty";
  if (subject.length > MAX_SUBJECT_LENGTH) return "too_long";
  if (hasNonProductDigits(subject)) return "digits";
  if (classifyMedical(subject).deflect) return "medical";
  const normalised = subject.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ");
  if (FIRST_PERSON.test(normalised)) return "first_person";
  if (ctx.userName && containsWord(subject, ctx.userName)) return "name";
  if ((ctx.conditions ?? []).some((term) => containsWord(subject, term))) return "condition";
  if ((ctx.allergens ?? []).some((term) => containsWord(subject, term))) return "allergy";
  return null;
}
