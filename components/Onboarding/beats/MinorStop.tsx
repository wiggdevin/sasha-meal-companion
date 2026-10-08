"use client";

/**
 * Onboarding v2 question set §4e (owner decision 2026-10-08): under 18, no plan is built. A
 * friendly stop: no goal, pace or calories are saved, and the person can still look around. The
 * server refuses the same derivation (`422 adult_only`), so this screen also answers that refusal.
 */
import Button from "@/components/ui/Button";
import { BeatNote, BeatQuestion } from "@/components/Onboarding/beats/BeatQuestion";
import { APP_NAME } from "@/lib/brand";

export default function MinorStop({ onBrowse, onChangeAge, busy = false }: {
  onBrowse: () => void;
  /** Back to the age question, for a typo. */
  onChangeAge: () => void;
  busy?: boolean;
}) {
  return <div className="flex w-full flex-col gap-4" data-testid="minor-stop">
    <BeatQuestion>{APP_NAME}&rsquo;s plans are built for adults 18 and over.</BeatQuestion>
    <BeatNote>
      We won&rsquo;t build a calorie plan or a weight goal for you. You can still look around the app.
    </BeatNote>
    <Button variant="primary" size="lg" block disabled={busy} onClick={onBrowse}>Look around</Button>
    <Button variant="ghost" size="sm" className="min-h-11" onClick={onChangeAge}>I typed my age wrong</Button>
  </div>;
}
