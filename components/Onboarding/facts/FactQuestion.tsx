"use client";

/**
 * Onboarding v2 — one plain question for the one fact still missing (live QA 2026-10-07, defect 4:
 * the gap chips read as broken mad-libs — "add this", "and now?", commas starting lines). The
 * facts beat now asks one field at a time, in the existing required order, with a plain question
 * and a real editor; the recap sentence above it only ever shows answers.
 *
 * Every number is entered in US units (owner, 2026-10-07: every account is in the US) — an age in
 * years, height in feet and inches, weight in pounds — and stored metric underneath, exactly as the
 * facts were stored before (`birthYear`, `heightCm`, `weightKg`). Each answer is ONE plain text box
 * the person types into the way they say it ("70", "5 10", "5'10\"", "170 lb"; owner 2026-10-08:
 * no steppers), read by `lib/profile/height-parse.ts` — the same parsers the chat dock uses. The
 * ranges are the completion gate's own (50–260 cm, 20–400 kg), so a saved value is never one the
 * gate later reads back as missing.
 *
 * A new question (for example a goal follow-up) is one more `case` here and one more key in the
 * shell's question order — nothing else moves.
 */
import { useId, useState, type FormEvent, type ReactNode } from "react";
import Button from "@/components/ui/Button";
import { CHIP_FILL } from "@/components/Onboarding/facts/chip-fill";
import { GoalPillRow } from "@/components/Onboarding/facts/GoalPillRow";
import { SexChipRow } from "@/components/Onboarding/facts/SexChipRow";
import { factValue, type OnboardingFactKey, type OnboardingFacts, type Goal, type SexAnswer }
  from "@/components/Onboarding/facts/types";
import { ageFromBirthYear, birthYearFromAge } from "@/components/Onboarding/facts/unit-echo";
import { cmToFtIn } from "@/lib/units/height";
import { kgToLb } from "@/lib/health/units";
import { AGE_RANGE, parseAge, parseHeight, parseWeight } from "@/lib/profile/height-parse";

/** A dark, matte-safe field: the shared chip tint, a hairline, cream text in the shell. */
export const FIELD_CLASS = `${CHIP_FILL} min-h-12 w-full min-w-0 rounded-[16px] px-3 text-body text-charcoal outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-[rgb(var(--ink-rgb)/0.55)]`;

export type FactAnswer =
  | { key: "birthYear"; value: number }
  | { key: "heightCm"; value: number }
  | { key: "weightKg"; value: number }
  | { key: "goal"; value: Goal }
  | { key: "sex"; value: SexAnswer };

/** The question text for each field, also the editor's visible label. */
export const QUESTION: Partial<Record<OnboardingFactKey, string>> = {
  birthYear: "How old are you?",
  sex: "For the calorie math: male, female, or prefer not to say?",
  heightCm: "How tall are you?",
  weightKg: "What do you weigh now?",
  goal: "What’s your main goal right now?",
};

function Question({ id, children }: { id?: string; children: ReactNode }) {
  return <p id={id} className="m-0 font-serif text-heading-sm text-charcoal">{children}</p>;
}

function TextAnswer({ label, value, onChange, suffix, placeholder, inputMode, hint }: {
  label: string; value: string; onChange: (value: string) => void; suffix?: string; placeholder: string;
  /** The phone keypad to open; the box itself is plain text, so "5'10" or "170 lb" types freely. */
  inputMode: "numeric" | "decimal" | "text";
  /** What the box currently reads as ("5 ft 10 in"), so the person sees their answer understood. */
  hint?: string | null;
}) {
  const id = useId();
  const hintId = useId();
  // The unit sits beside the number only while the box holds a bare number.
  const showSuffix = suffix && /^\s*\d+(?:\.\d*)?\s*$/.test(value);
  return <div className="flex min-w-0 flex-1 flex-col gap-1">
    <label htmlFor={id} className="text-caption text-graphite">{label}</label>
    <span className="relative flex items-center">
      <input id={id} type="text" inputMode={inputMode} autoComplete="off" autoCorrect="off" spellCheck={false}
        enterKeyHint="done" placeholder={placeholder} value={value} aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)} className={`${FIELD_CLASS} ${showSuffix ? "pr-12" : ""}`} />
      {showSuffix && <span aria-hidden="true" className="pointer-events-none absolute right-3 text-body text-muted">{suffix}</span>}
    </span>
    {hint && <p id={hintId} className="m-0 text-caption text-graphite" aria-live="polite">{hint}</p>}
  </div>;
}

function NumberForm({ question, valid, error, onSave, children }: {
  question: string; valid: boolean; error: string | null; onSave: () => void; children: ReactNode;
}) {
  const questionId = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (valid) onSave();
  }
  return <form aria-labelledby={questionId} onSubmit={submit} className="flex w-full flex-col gap-3">
    <Question id={questionId}>{question}</Question>
    <div className="flex items-end gap-2">{children}</div>
    {error && <p role="alert" className="m-0 text-caption text-alert">{error}</p>}
    <Button type="submit" variant="primary" size="lg" block disabled={!valid}>Next</Button>
  </form>;
}

function AgeQuestion({ facts, today, onAnswer }: { facts: OnboardingFacts; today: Date; onAnswer: (a: FactAnswer) => void }) {
  const known = factValue(facts, "birthYear");
  const seeded = known !== undefined ? String(ageFromBirthYear(known, today)) : "";
  const [text, setText] = useState(seeded);
  const age = parseAge(text);
  const valid = age !== null;
  const error = text.trim() !== "" && !valid ? `Type your age in years, from ${AGE_RANGE.min} to ${AGE_RANGE.max}.` : null;
  return <NumberForm question={QUESTION.birthYear!} valid={valid} error={error}
    // An age left as shown keeps the stored birth year: converting back could move it by one.
    onSave={() => onAnswer({ key: "birthYear",
      value: known !== undefined && text === seeded ? known : birthYearFromAge(age!, today) })}>
    <TextAnswer label="Age" suffix="yrs" placeholder="e.g. 34" inputMode="numeric" value={text} onChange={setText} />
  </NumberForm>;
}

/** 177.8 → `5'10"`, the way the box reopens a stored height. */
function heightText(cm: number): string {
  const { ft, in: inches } = cmToFtIn(cm);
  return `${ft}'${inches}"`;
}

function HeightQuestion({ facts, onAnswer }: { facts: OnboardingFacts; onAnswer: (a: FactAnswer) => void }) {
  const known = factValue(facts, "heightCm");
  const seeded = known !== undefined ? heightText(known) : "";
  const [text, setText] = useState(seeded);
  const parsed = parseHeight(text);
  const untouched = known !== undefined && text === seeded;
  const error = text.trim() !== "" && !parsed ? "Type your height in feet and inches, like 5 10 or 5'10\"." : null;
  const hint = parsed && !untouched ? `${parsed.ft} ft ${parsed.inches} in` : null;
  return <NumberForm question={QUESTION.heightCm!} valid={parsed !== null} error={error}
    // A height left as shown keeps the stored centimetres: the inch display rounds them.
    onSave={() => onAnswer({ key: "heightCm", value: untouched ? known : parsed!.cm })}>
    <TextAnswer label="Height" placeholder="e.g. 5 10" inputMode="text" value={text} onChange={setText} hint={hint} />
  </NumberForm>;
}

function WeightQuestion({ facts, onAnswer }: { facts: OnboardingFacts; onAnswer: (a: FactAnswer) => void }) {
  const known = factValue(facts, "weightKg");
  // Shown to the tenth of a pound, so a stored weight reopens close to what was measured.
  const seeded = known !== undefined ? String(Math.round(kgToLb(known) * 10) / 10) : "";
  const [text, setText] = useState(seeded);
  const parsed = parseWeight(text);
  const error = text.trim() !== "" && !parsed ? "Type your weight in pounds, like 170." : null;
  return <NumberForm question={QUESTION.weightKg!} valid={parsed !== null} error={error}
    // A weight left as shown keeps the stored kilograms exactly (Sol p0 WARN): no new measurement,
    // so no rounding through pounds.
    onSave={() => onAnswer({ key: "weightKg",
      value: known !== undefined && text === seeded ? known : parsed!.kg })}>
    <TextAnswer label="Weight" suffix="lb" placeholder="e.g. 170" inputMode="decimal" value={text} onChange={setText} />
  </NumberForm>;
}

export function FactQuestion({ field, facts, today = new Date(), onAnswer }: {
  field: OnboardingFactKey;
  facts: OnboardingFacts;
  today?: Date;
  onAnswer: (answer: FactAnswer) => void;
}) {
  // Keyed by field so a typed answer that lands while a question is open re-seeds its editor.
  const seed = `${field}:${String(facts[field] ?? "")}`;
  switch (field) {
    case "birthYear": return <AgeQuestion key={seed} facts={facts} today={today} onAnswer={onAnswer} />;
    case "heightCm": return <HeightQuestion key={seed} facts={facts} onAnswer={onAnswer} />;
    case "weightKg": return <WeightQuestion key={seed} facts={facts} onAnswer={onAnswer} />;
    case "sex": return <SexChipRow question={QUESTION.sex} value={factValue(facts, "sex")}
      onSelect={(value) => onAnswer({ key: "sex", value })} />;
    case "goal": return <GoalPillRow question={QUESTION.goal} value={factValue(facts, "goal")}
      onSelect={(value) => onAnswer({ key: "goal", value })} />;
    default: return null;
  }
}
