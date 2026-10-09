/**
 * Body answers typed the way people say them (owner, 2026-10-08: "free typing everywhere"). Every
 * account is in the US, so a person types feet and inches, pounds and an age in years; the profile
 * stores centimetres and kilograms underneath. Pure functions, no I/O: the onboarding fact editors
 * and the chat dock's typed answers (`components/Onboarding/typed-answer.ts`) both read through
 * these, so one answer means the same thing on either path.
 *
 * Ranges match the completion gate (`lib/profile/onboarding-state.ts`: 50–260 cm, 20–400 kg).
 */
import { CM_MAX, CM_MIN, FEET_MAX, FEET_MIN, ftInToCm } from "@/lib/units/height";
import { lbToKg } from "@/lib/health/units";

export type ParsedHeight = { cm: number; ft: number; inches: number };

const INCHES_PER_FOOT = 12;
/** Inches-only answers ("70 in"), from 3 ft to 8 ft 11 in. */
const INCHES_ONLY = { min: FEET_MIN * INCHES_PER_FOOT, max: FEET_MAX * INCHES_PER_FOOT + 11 };

/** Lower case, straight quote marks, a stated period dropped ("5 ft. 10 in."), single spaces. */
const VULGAR: Readonly<Record<string, string>> = { "½": ".5", "¼": ".25", "¾": ".75" };

/** "10 1/2", "10½", "10 ½" → "10.5": a fraction of an inch joined onto its whole number. */
function joinFractions(text: string): string {
  return text
    .replace(/(\d+)\s*([½¼¾])/g, (_, whole: string, part: string) => `${whole}${VULGAR[part]}`)
    .replace(/(\d+)[\s-]+(1|3)\/(2|4)(?!\d)/g, (_, whole: string, top: string, bottom: string) =>
      String(Number(whole) + Number(top) / Number(bottom)));
}

function normalize(text: string): string {
  return joinFractions(text.trim().toLowerCase())
    .replace(/[’‘′`´]/g, "'")
    .replace(/[″“”]/g, "\"")
    .replace(/''/g, "\"")
    .replace(/\.(?!\d)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function result(ft: number, inches: number): ParsedHeight | null {
  if (!Number.isInteger(ft) || ft < FEET_MIN || ft > FEET_MAX) return null;
  if (!Number.isFinite(inches) || inches < 0 || inches >= INCHES_PER_FOOT) return null;
  const cm = ftInToCm(ft, inches);
  return cm >= CM_MIN && cm <= CM_MAX ? { cm, ft, inches } : null;
}

const FEET_WORD = "(?:'|ft|feet|foot)";
const INCH_WORD = "(?:\"|in|inch|inches)";
const NUM = "(\\d{1,2}(?:\\.\\d+)?)";
/** "5'10", "5' 10\"", "5ft 10in", "5 foot 10", "5 feet and 10 inches", "6 foot", "6'", "6'0\"". */
const FEET_MARKED = new RegExp(`^(\\d)\\s*${FEET_WORD}(?:\\s*(?:and\\s+|,\\s*|-\\s*)?${NUM}\\s*${INCH_WORD}?)?$`);
/** "5 10", "5-10", "5 10\"" — two numbers with a separator and no feet mark. */
const FEET_SPACED = new RegExp(`^(\\d)\\s*(?:-|\\s)\\s*${NUM}\\s*${INCH_WORD}?$`);
/** "70 in", "70\"", "70 inches". */
const INCHES_MARKED = new RegExp(`^(\\d{2,3}(?:\\.\\d+)?)\\s*${INCH_WORD}$`);

export type HeightParseOptions = {
  /** A lone number with no mark ("6" → 6 ft, "70" → 70 in). On for a field that asks height and
   *  nothing else; off when the number could be something else (a list of answers in the chat). */
  allowBare?: boolean;
};

/** A typed height, or `null` when it is not one (out of range, "10 foot", "2", words). */
export function parseHeight(text: string, options: HeightParseOptions = {}): ParsedHeight | null {
  const allowBare = options.allowBare ?? true;
  const s = normalize(text);
  if (s === "") return null;

  const marked = FEET_MARKED.exec(s) ?? FEET_SPACED.exec(s);
  if (marked) return result(Number(marked[1]), marked[2] === undefined ? 0 : Number(marked[2]));

  const inchesOnly = INCHES_MARKED.exec(s);
  if (inchesOnly) return fromTotalInches(Number(inchesOnly[1]));

  if (allowBare && /^\d{1,3}(?:\.\d+)?$/.test(s)) {
    const value = Number(s);
    if (Number.isInteger(value) && value >= FEET_MIN && value <= FEET_MAX) return result(value, 0);
    return fromTotalInches(value);
  }
  return null;
}

function fromTotalInches(total: number): ParsedHeight | null {
  if (!Number.isFinite(total) || total < INCHES_ONLY.min || total > INCHES_ONLY.max) return null;
  const ft = Math.floor(total / INCHES_PER_FOOT);
  return result(ft, Math.round((total - ft * INCHES_PER_FOOT) * 10) / 10);
}

/** Two separate numbers (a feet box and an inches box); a blank inches box is 0. */
export function heightFromParts(feet: string, inches: string): ParsedHeight | null {
  const ft = feet.trim();
  const inch = inches.trim();
  if (!/^\d$/.test(ft) || (inch !== "" && !/^\d{1,2}(?:\.\d+)?$/.test(inch))) return null;
  return result(Number(ft), inch === "" ? 0 : Number(inch));
}

// ---- Weight -----------------------------------------------------------------------------------

export type ParsedWeight = { lb: number; kg: number };
/** The completion gate's 20–400 kg, in pounds. */
export const WEIGHT_LB_RANGE = { min: 45, max: 880 } as const;
const WEIGHT = /^(\d{2,3}(?:\.\d+)?)\s*(lbs?|pounds?|#)?$/;

export type WeightParseOptions = {
  /** A number with no unit word counts as pounds (on for the weight field). */
  allowBare?: boolean;
};

/** "170", "170 lb", "170lbs", "170.5 pounds" → pounds and kilograms (to the tenth). */
export function parseWeight(text: string, options: WeightParseOptions = {}): ParsedWeight | null {
  const allowBare = options.allowBare ?? true;
  const match = WEIGHT.exec(normalize(text));
  if (!match || (!match[2] && !allowBare)) return null;
  const lb = Number(match[1]);
  if (!Number.isFinite(lb) || lb < WEIGHT_LB_RANGE.min || lb > WEIGHT_LB_RANGE.max) return null;
  return { lb, kg: Math.round(lbToKg(lb) * 10) / 10 };
}

// ---- Age --------------------------------------------------------------------------------------

/** The ages a form accepts. Under 18 is accepted on purpose: the shell's adult rule
 *  (`isMinorOn`, lib/profile/rate-eligibility.ts) then shows the friendly under-18 stop. */
export const AGE_RANGE = { min: 13, max: 110 } as const;
const AGE = /^(?:i'?m\s+|i am\s+)?(\d{1,3})[\s-]*(?:years?(?:[\s-]*old)?|yrs?(?:\s*old)?|yo|y\/o)?$/;

/** "70", "70 years", "70 yrs", "I'm 70", "70 years old" → 70; `null` outside 13–110 or not a whole number. */
export function parseAge(text: string): number | null {
  const match = AGE.exec(normalize(text));
  if (!match) return null;
  const age = Number(match[1]);
  return Number.isInteger(age) && age >= AGE_RANGE.min && age <= AGE_RANGE.max ? age : null;
}
