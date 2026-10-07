"use client";

import { useEffect, useState } from "react";
import { ruleHelp, ruleLabel } from "@/lib/reference";
import { loadRuleReview, submitRuleReview, type RuleReview } from "@/lib/rule-review-client";
import type { RuleChoice, RuleChoices } from "@/lib/rule-review";
import Notice from "@/components/ui/Notice";
import Button from "@/components/ui/Button";
import Chip from "@/components/ui/Chip";

type ChoiceState = { allergens: Record<string, RuleChoice>; categories: Record<string, RuleChoice> };
const EMPTY: ChoiceState = { allergens: {}, categories: {} };

export default function RuleReviewCard({ initial, onCompleted }: {
  initial?: RuleReview;
  onCompleted?: () => void;
}) {
  const [review, setReview] = useState<RuleReview | null>(initial ?? null);
  const [loading, setLoading] = useState(initial === undefined);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<ChoiceState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (initial !== undefined) return;
    let active = true;
    void loadRuleReview().then((loaded) => {
      if (!active) return;
      setReview(loaded);
      setLoading(false);
      if (!loaded) setError("Could not check your food rules. Try again when connected.");
    });
    return () => { active = false; };
  }, [initial, retry]);

  if (!loading && review && !review.required) return null;
  const all = review ? [
    ...review.candidateAllergens.map((key) => ({ group: "allergens" as const, key })),
    ...review.candidateCategories.map((key) => ({ group: "categories" as const, key })),
  ] : [];
  const answered = all.filter(({ group, key }) => choices[group][key]).length;

  function choose(group: keyof ChoiceState, key: string, choice: RuleChoice) {
    setChoices((current) => ({ ...current, [group]: { ...current[group], [key]: choice } }));
    setError(null);
  }

  async function save() {
    if (!review || answered !== all.length || saving) return;
    setSaving(true);
    setError(null);
    const result = await submitRuleReview(choices as RuleChoices, review.rev);
    setSaving(false);
    if (result.status === "ok") {
      setReview(result.review);
      onCompleted?.();
      return;
    }
    if (result.status === "conflict") {
      const fresh = await loadRuleReview();
      setReview(fresh);
      setChoices(EMPTY);
      if (fresh && !fresh.required) {
        onCompleted?.();
        return;
      }
      setError("Your rules changed on another device. Review the current list again.");
      return;
    }
    setError("Could not save your choices. Try again when connected.");
  }

  return (
    <section className="shell" aria-label="Review food rules">
      <div className="surface flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-subheading font-medium text-charcoal">Review your food rules</h2>
          <p className="m-0 text-body-sm text-graphite">
            Some rules may have carried over from an older app version. Choose Keep or Remove for
            each one. Your choices will apply to future meal suggestions.
          </p>
        </div>
        {loading && <p role="status" className="m-0 text-caption text-muted">Checking your rules…</p>}
        {!loading && !review && (
          <Button className="self-start"
            onClick={() => { setLoading(true); setError(null); setRetry((value) => value + 1); }}>
            Try again
          </Button>
        )}
        {all.map(({ group, key }) => (
          <div key={`${group}:${key}`} className="flex flex-col gap-2 border-t border-black/5 pt-3">
            <div>
              <h3 className="m-0 text-body-md font-medium text-charcoal">{ruleLabel(key)}</h3>
              <p className="m-0 text-caption text-muted">{ruleHelp(key)}</p>
            </div>
            {/* A choice, not an action: chips on the beige track (DESIGN.md §Buttons, Chip). */}
            <div role="group" aria-label={`${ruleLabel(key)} choice`} className="pill-in flex gap-1 p-1">
              {(["keep", "remove"] as const).map((choice) => (
                <Chip key={choice} selected={choices[group][key] === choice} disabled={saving}
                  onClick={() => choose(group, key, choice)}>
                  {choice === "keep" ? "Keep" : "Remove"}
                </Chip>
              ))}
            </div>
          </div>
        ))}
        {review?.required && (
          <>
            <p role="status" className="m-0 text-caption text-muted">{all.length
              ? `${answered} of ${all.length} reviewed`
              : "The old candidate rules are no longer on this list. Confirm to finish the review."}</p>
            <Button variant="primary" block disabled={answered !== all.length}
              status={saving ? "pending" : undefined} onClick={() => void save()}>
              Save my choices
            </Button>
          </>
        )}
        {error && <Notice tone="error" title={error} />}
      </div>
    </section>
  );
}
