"use client";

/**
 * Onboarding v2 question set §1c/§4: the safety round. Always asked, tap-only, before the pace
 * screen and before any food UI. Its answers never reach a model. "No, none of these" is the
 * largest control and finishes the round in one tap. Each other chip opens its follow-up below it:
 *
 * - Food allergy → the existing rule editor (`DietaryProfilePicker`), with the cross-contact line.
 * - Pregnant or breastfeeding (shown to every adult) → Pregnant · Breastfeeding · Trying to get
 *   pregnant. Pregnant and breastfeeding hold the pace (`safetyConditionEntries` writes them to
 *   `conditions` before the target; "Pregnant" arms the tuna check).
 * - Medicine that affects food → the kind, in plain names; its food rules through the same editor.
 *   Sasha does not change doses or timing.
 * - A health condition → optional free text, saved to `conditions`, never sent to a model.
 * - A diet a clinician set for me → the editor or Later; holds the pace.
 *
 * When the editor was opened, Continue hands back `rulesEdited: true` so the shell re-reads the
 * account's rules before any food UI (ONB2-RULE-REREAD).
 */
import { useId, useState } from "react";
import Button from "@/components/ui/Button";
import { DisclosurePanel } from "@/components/ui/Disclosure";
import ChoiceChips from "@/components/Onboarding/beats/ChoiceChips";
import { BeatNote, BeatQuestion } from "@/components/Onboarding/beats/BeatQuestion";
import DietaryProfilePicker from "@/components/Onboarding/DietaryProfilePicker";
import { FIELD_CLASS } from "@/components/Onboarding/facts/FactQuestion";
import { APP_NAME } from "@/lib/brand";
import { CLINICIAN_ADVICE_FIRST_NOTE } from "@/lib/policy/profiles/condition-packs";
import {
  type MedicineKind, type PregnancyAnswer, type SafetyPick, type SafetyRound as SafetyRoundAnswer,
} from "@/components/Onboarding/v2/plan-answers";

const PICKS: { value: SafetyPick; label: string }[] = [
  { value: "allergy", label: "Food allergy" },
  { value: "pregnancy", label: "Pregnant or breastfeeding" },
  { value: "medicine", label: "Medicine that affects food" },
  { value: "condition", label: "A health condition" },
  { value: "clinician_diet", label: "A diet a clinician set for me" },
];
const PREGNANCY: { value: PregnancyAnswer; label: string }[] = [
  { value: "pregnant", label: "Pregnant" },
  { value: "breastfeeding", label: "Breastfeeding" },
  { value: "trying_to_conceive", label: "Trying to get pregnant" },
];
const MEDICINES: { value: MedicineKind; label: string }[] = [
  { value: "glp1", label: "GLP-1 (like Ozempic, Wegovy, Mounjaro, Zepbound)" },
  { value: "warfarin", label: "Warfarin" },
  { value: "maoi", label: "An MAOI" },
  { value: "thyroid", label: "Thyroid medicine (levothyroxine)" },
  { value: "insulin", label: "Insulin or a sulfonylurea" },
  { value: "other", label: "Something else" },
];
const CONDITION_MAX = 64;

export type SafetyRoundResult = SafetyRoundAnswer & { rulesEdited: boolean };

function RuleEditorToggle({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return <Button variant="secondary" size="md" className="self-start" aria-expanded={open} onClick={onToggle}>
    {label}
  </Button>;
}

export default function SafetyRound({ initial, note, onDone, busy = false }: {
  initial: SafetyRoundAnswer | null;
  /** A line above the question, e.g. when a typed health detail opened this card early. */
  note?: string | null;
  onDone: (result: SafetyRoundResult) => void;
  /** True while the shell re-reads the account's rules after Continue. */
  busy?: boolean;
}) {
  const [picks, setPicks] = useState<SafetyPick[]>(initial?.picks ?? []);
  const [pregnancy, setPregnancy] = useState<PregnancyAnswer | null>(initial?.pregnancy ?? null);
  const [medicines, setMedicines] = useState<MedicineKind[]>(initial?.medicines ?? []);
  const [conditionText, setConditionText] = useState(initial?.conditionText ?? "");
  const [editorOpen, setEditorOpen] = useState(false);
  const [edited, setEdited] = useState(false);
  const conditionId = useId();

  const has = (pick: SafetyPick) => picks.includes(pick);
  function togglePick(pick: SafetyPick) {
    setPicks((current) => current.includes(pick) ? current.filter((p) => p !== pick) : [...current, pick]);
  }
  function toggleMedicine(kind: MedicineKind) {
    setMedicines((current) => current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind]);
  }
  function toggleEditor() {
    setEditorOpen((open) => !open);
    setEdited(true);
  }
  const ready = picks.length > 0
    && (!has("pregnancy") || pregnancy !== null)
    && (!has("medicine") || medicines.length > 0);

  function finish() {
    if (!ready || busy) return;
    onDone({
      picks, pregnancy: has("pregnancy") ? pregnancy : null,
      medicines: has("medicine") ? medicines : [],
      conditionText: has("condition") ? conditionText.trim().slice(0, CONDITION_MAX) : "",
      rulesEdited: edited,
    });
  }
  const showsEditor = has("allergy") || has("medicine") || has("clinician_diet");

  return <div className="flex w-full flex-col gap-4" data-testid="safety-round">
    {note && <BeatNote live>{note}</BeatNote>}
    <BeatQuestion>Before we pick foods: does anything here apply to you?</BeatQuestion>
    <Button size="lg" block variant="primary" disabled={busy}
      onClick={() => onDone({ picks: [], pregnancy: null, medicines: [], conditionText: "", rulesEdited: false })}>
      No, none of these
    </Button>
    <ChoiceChips label="Applies to me" multiple block options={PICKS} value={picks} onChange={togglePick} />

    <DisclosurePanel id="safety-allergy" open={has("allergy")} keepMounted={false}>
      <div className="flex flex-col gap-2 pt-1">
        <BeatQuestion>Which allergies? We&rsquo;ll keep these out of every plan.</BeatQuestion>
        <BeatNote>Always check labels yourself. {APP_NAME} can&rsquo;t see cross-contact.</BeatNote>
      </div>
    </DisclosurePanel>
    <DisclosurePanel id="safety-pregnancy" open={has("pregnancy")} keepMounted={false}>
      <div className="flex flex-col gap-2 pt-1">
        <BeatQuestion>Which one?</BeatQuestion>
        <ChoiceChips label="Pregnancy" options={PREGNANCY} value={pregnancy} onChange={setPregnancy} />
        <BeatNote>{CLINICIAN_ADVICE_FIRST_NOTE}</BeatNote>
      </div>
    </DisclosurePanel>
    <DisclosurePanel id="safety-medicine" open={has("medicine")} keepMounted={false}>
      <div className="flex flex-col gap-2 pt-1">
        <BeatQuestion>Which kind of medicine?</BeatQuestion>
        <ChoiceChips label="Medicine" multiple block options={MEDICINES} value={medicines} onChange={toggleMedicine} />
        <BeatNote>{APP_NAME} does not change doses or timing. {CLINICIAN_ADVICE_FIRST_NOTE}</BeatNote>
      </div>
    </DisclosurePanel>
    <DisclosurePanel id="safety-condition" open={has("condition")} keepMounted={false}>
      <div className="flex flex-col gap-2 pt-1">
        <label htmlFor={conditionId} className="font-serif text-heading-sm text-charcoal">
          Thanks. Want to name it? This is optional.
        </label>
        <input id={conditionId} type="text" maxLength={CONDITION_MAX} value={conditionText}
          onChange={(event) => setConditionText(event.target.value)} className={FIELD_CLASS}
          autoComplete="off" />
        <BeatNote>
          {APP_NAME} doesn&rsquo;t change your plan for health conditions yet. {CLINICIAN_ADVICE_FIRST_NOTE} You
          can add food rules any time in Foods › Avoids.
        </BeatNote>
      </div>
    </DisclosurePanel>
    <DisclosurePanel id="safety-clinician" open={has("clinician_diet")} keepMounted={false}>
      <div className="flex flex-col gap-2 pt-1">
        <BeatQuestion>Got it. Want to add the foods it rules out?</BeatQuestion>
        <BeatNote>Your clinician guides calorie changes. {APP_NAME} will plan meals that fit your rules.</BeatNote>
      </div>
    </DisclosurePanel>

    {showsEditor && <div className="flex flex-col gap-2">
      <RuleEditorToggle open={editorOpen} onToggle={toggleEditor}
        label={editorOpen ? "Close the rule editor" : "Add food rules"} />
      {/* The picker is a light-surface form; inside `.matte` it needs `.matte-reset`. */}
      <DisclosurePanel id="safety-editor" open={editorOpen} keepMounted={false}>
        <div className="matte-reset surface flex-col p-4"><DietaryProfilePicker /></div>
      </DisclosurePanel>
    </div>}

    {picks.length > 0 && <Button variant="primary" size="lg" block disabled={!ready || busy}
      onClick={finish}>{busy ? "Checking your rules…" : "Continue"}</Button>}
  </div>;
}
