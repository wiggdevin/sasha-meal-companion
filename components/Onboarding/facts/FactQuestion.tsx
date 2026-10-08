"use client";

/**
 * Onboarding v2 — one plain question for the one fact still missing (live QA 2026-10-07, defect 4:
 * the gap chips read as broken mad-libs — "add this", "and now?", commas starting lines). The
 * facts beat now asks one field at a time, in the existing required order, with a plain question
 * and a real editor; the recap sentence above it only ever shows answers.
 *
 * Every number is entered in US units (owner, 2026-10-07: every account is in the US) — an age in
 * years, height in feet and inches, weight in pounds — and stored metric underneath, exactly as the
 * facts were stored before (`birthYear`, `heightCm`, `weightKg`). The ranges are the completion
 * gate's own (`lib/profile/onboarding-state.ts`: 50–260 cm, 20–400 kg), so a saved value is never
 * one the gate later reads back as missing.
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
import { cmToFtIn, ftInToCm } from "@/lib/units/height";
import { kgToLb, lbToKg } from "@/lib/health/units";

/** A dark, matte-safe field: the shared chip tint, a hairline, cream text in the shell. */
export const FIELD_CLASS = `${CHIP_FILL} min-h-12 w-full min-w-0 rounded-[16px] px-3 text-body text-charcoal outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-[rgb(var(--ink-rgb)/0.55)]`;

const AGE_MIN = 13;
const AGE_MAX = 100;
const HEIGHT_CM = { min: 50, max: 260 };
const WEIGHT_KG = { min: 20, max: 400 };

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

function NumberInput({ label, value, onChange, suffix, min, max }: {
  label: string; value: string; onChange: (value: string) => void; suffix?: string; min: number; max: number;
}) {
  const id = useId();
  return <div className="flex min-w-0 flex-1 flex-col gap-1">
    <label htmlFor={id} className="text-caption text-graphite">{label}</label>
    <span className="relative flex items-center">
      <input id={id} type="number" inputMode="numeric" enterKeyHint="done" min={min} max={max} value={value}
        onChange={(event) => onChange(event.target.value)} className={`${FIELD_CLASS} ${suffix ? "pr-10" : ""}`} />
      {suffix && <span aria-hidden="true" className="pointer-events-none absolute right-3 text-body text-muted">{suffix}</span>}
    </span>
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
  const [text, setText] = useState(known !== undefined ? String(ageFromBirthYear(known, today)) : "");
  const age = Number(text);
  const valid = text.trim() !== "" && Number.isInteger(age) && age >= AGE_MIN && age <= AGE_MAX;
  const error = text.trim() !== "" && !valid ? `Enter an age from ${AGE_MIN} to ${AGE_MAX}.` : null;
  return <NumberForm question={QUESTION.birthYear!} valid={valid} error={error}
    onSave={() => onAnswer({ key: "birthYear", value: birthYearFromAge(age, today) })}>
    <NumberInput label="Age" suffix="yrs" value={text} onChange={setText} min={AGE_MIN} max={AGE_MAX} />
  </NumberForm>;
}

function HeightQuestion({ facts, onAnswer }: { facts: OnboardingFacts; onAnswer: (a: FactAnswer) => void }) {
  const known = factValue(facts, "heightCm");
  const start = known !== undefined ? cmToFtIn(known) : null;
  const [feet, setFeet] = useState(start ? String(start.ft) : "");
  const [inches, setInches] = useState(start ? String(start.in) : "");
  const ft = Number(feet);
  const inch = inches.trim() === "" ? 0 : Number(inches);
  const shapeOk = feet.trim() !== "" && Number.isInteger(ft) && Number.isFinite(inch) && inch >= 0 && inch < 12;
  const cm = shapeOk ? ftInToCm(ft, inch) : NaN;
  const valid = shapeOk && cm >= HEIGHT_CM.min && cm <= HEIGHT_CM.max;
  const error = feet.trim() !== "" && !valid ? "Enter feet, and inches from 0 to 11." : null;
  return <NumberForm question={QUESTION.heightCm!} valid={valid} error={error}
    onSave={() => onAnswer({ key: "heightCm", value: Math.round(cm * 10) / 10 })}>
    <NumberInput label="Feet" suffix="ft" value={feet} onChange={setFeet} min={3} max={8} />
    <NumberInput label="Inches" suffix="in" value={inches} onChange={setInches} min={0} max={11} />
  </NumberForm>;
}

function WeightQuestion({ facts, onAnswer }: { facts: OnboardingFacts; onAnswer: (a: FactAnswer) => void }) {
  const known = factValue(facts, "weightKg");
  const [text, setText] = useState(known !== undefined ? String(Math.round(kgToLb(known))) : "");
  const lb = Number(text);
  const kg = Number.isFinite(lb) ? lbToKg(lb) : NaN;
  const valid = text.trim() !== "" && kg >= WEIGHT_KG.min && kg <= WEIGHT_KG.max;
  const error = text.trim() !== "" && !valid ? "Enter your weight in pounds." : null;
  return <NumberForm question={QUESTION.weightKg!} valid={valid} error={error}
    onSave={() => onAnswer({ key: "weightKg", value: Math.round(kg * 10) / 10 })}>
    <NumberInput label="Weight" suffix="lb" value={text} onChange={setText} min={45} max={880} />
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
