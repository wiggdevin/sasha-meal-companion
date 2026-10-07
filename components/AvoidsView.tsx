"use client";

import { useEffect, useState } from "react";
import AvoidRules from "@/components/AvoidRules";
import RuleReviewCard from "@/components/RuleReviewCard";
import { loadDiet, saveDiet, type DietState } from "@/lib/foods/diet-client";
import AvoidImpact from "@/components/AvoidImpact";
import { PREFERENCE_FLAGS, type PreferenceFlag } from "@/lib/profile/onboarding-state";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import Notice from "@/components/ui/Notice";
import Button from "@/components/ui/Button";

const DIET_LABELS: Record<string, string> = {
  vegetarian: "Vegetarian", vegan: "Vegan", pescatarian: "Pescatarian",
  no_pork: "No pork", no_beef: "No beef", halal: "Halal", kosher: "Kosher",
  no_shellfish: "No shellfish", no_eggs: "No eggs", no_soy: "No soy",
  no_peanuts: "No peanuts", low_fodmap: "Low FODMAP",
};

export function DietStyleCard() {
  const [state, setState] = useState<DietState | null>(null);
  const [draft, setDraft] = useState<PreferenceFlag[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const feedback = useActionFeedback();
  useEffect(() => { let active = true; void loadDiet().then((value) => {
    if (active) { setState(value); setError(null); }
  }).catch(() => { if (active) setError("Could not load diet settings. Try again."); });
  return () => { active = false; }; }, [attempt]);
  const flags = state?.dietPrefs?.flags ?? [];
  const visible = flags.filter((flag) => DIET_LABELS[flag]);
  const chosen = draft ?? [];
  async function save() {
    if (!state || saving) return;
    setSaving(true); setError(null);
    const previousFlags = PREFERENCE_FLAGS.filter((flag) => flags.includes(flag));
    let savedRev = state.rev;
    const failureMessage = (cause: unknown) => cause instanceof Error
      ? cause.message : "Could not save diet settings.";
    await feedback.run(async () => {
      const next = await saveDiet(chosen, state.rev); savedRev = next.rev;
      setState(next); setDraft(null); setConfirming(false);
      return next;
    }, { kind: "change", successMessage: "Diet style changed.", failureMessage,
      undo: { action: () => { setSaving(true); void feedback.run(async () => {
        const restored = await saveDiet(previousFlags, savedRev); setState(restored); return restored;
      // The Undo lived in the toast that is gone now, so the restore confirms as a notice.
      }, { kind: "change", confirm: "notice", successMessage: "Diet style restored.", failureMessage })
        .finally(() => setSaving(false)); } },
    });
    setSaving(false);
  }
  return <section className={`surface flex flex-col gap-2 p-4 ${feedback.controlProps.className}`}
    aria-label="Diet style" data-feedback-state={feedback.controlProps["data-feedback-state"]}>
    <h2 className="m-0 text-caption font-medium text-charcoal">Diet style</h2>
    {!state && !error && <p className="m-0 text-caption text-graphite">Checking your diet settings…</p>}
    {!state && error && <Button variant="tertiary" className="self-start"
      onClick={() => { setError(null); setAttempt((value) => value + 1); }}>Retry</Button>}
    {state && (visible.length ? <div className="flex flex-wrap gap-2">
      {visible.map((flag) => <span key={flag} className="pill px-3 py-2 text-caption text-graphite">
        {DIET_LABELS[flag]}
      </span>)}
    </div> : <Notice tone="neutral" title="No diet style selected." />)}
    {state && draft === null && <Button variant="secondary" className="self-start"
      onClick={() => { setDraft(PREFERENCE_FLAGS.filter((flag) => flags.includes(flag))); setError(null); }}>
      Edit diet style and exclusions
    </Button>}
    {draft !== null && <>
      <div role="group" aria-label="Diet style and exclusions" className="grid grid-cols-2 gap-2">
        {PREFERENCE_FLAGS.map((flag) => <Button key={flag} disabled={saving} block
          aria-pressed={chosen.includes(flag)} variant={chosen.includes(flag) ? "primary" : "tertiary"}
          onClick={() => { setDraft(chosen.includes(flag)
            ? chosen.filter((item) => item !== flag) : [...chosen, flag]); setConfirming(false); }}>
          {DIET_LABELS[flag]}
        </Button>)}
      </div>
      {confirming && <p role="status" className="m-0 text-caption text-graphite">
        Confirm future suggestions use: {chosen.length ? chosen.map((flag) => DIET_LABELS[flag]).join(", ") : "no selected diet flags"}.
        Existing food logs stay as recorded.
      </p>}
      <div className="flex gap-2">
        <Button variant={confirming ? "primary" : "secondary"} status={saving ? "pending" : undefined}
          onClick={() => confirming ? void save() : setConfirming(true)}>
          {confirming ? "Confirm change" : "Review change"}
        </Button>
        <Button variant="tertiary" disabled={saving}
          onClick={() => { setDraft(null); setConfirming(false); setError(null); }}>Cancel</Button>
      </div>
    </>}
    {error && <Notice tone="error" title={error} />}
    <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
  </section>;
}

/**
 * Everything the user cannot eat, in one place: their Avoid list first, then saved future
 * impact, diet choices and server rules.
 *
 * The two halves are not one store yet — their foods do not map to catalog rows (F-057) — so the
 * rules card and their list sit next to each other and say plainly which is which.
 */
export default function AvoidsView() {
  const [rulesVersion, setRulesVersion] = useState(0);
  return (
    <>
      <AvoidImpact dietEditor={<DietStyleCard />} />
      <RuleReviewCard onCompleted={() => setRulesVersion((value) => value + 1)} />
      {/* On the ground it is a card (E1); inside the impact sheet's editor it stays a nested face. */}
      <div className="shell"><DietStyleCard /></div>
      <AvoidRules key={rulesVersion} />
    </>
  );
}
