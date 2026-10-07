"use client";

/**
 * Phase 18 W5b UI hand-off (docs/specs/phase-18-open-world-foods.md §W5b acceptance 2): the one calm
 * line under a dietary free-text field once the phone's local safety check (lib/profile/taste-safety.ts
 * via lib/profile/prefs-client.ts `classifyDietaryPreferences` / `suggestTasteChips`) keeps the text on
 * the phone instead of sending it anywhere. The field's raw text still saves exactly as it does today —
 * this hint writes nothing by itself.
 *
 * `offer: "rule_editor"` covers a rule, an allergy, a condition, a medicine or a symptom: it reads as a
 * food rule, never as a diagnosis, and only offers the rule editor. `offer: "plain_prefs"` covers text
 * the check could not place: it asks for plain likes and dislikes. Shared by onboarding's preference
 * step and any future Settings dietary field (same classifier, same copy).
 */
import Notice from "./Notice";

export type DietaryTextOffer = "rule_editor" | "plain_prefs";

const COPY: Record<DietaryTextOffer, { title: string; action: string }> = {
  rule_editor: {
    title: "This reads like a food rule — set it as a rule so it's always checked.",
    action: "Add it as a rule",
  },
  plain_prefs: {
    title: "We couldn't tell what you meant — try plain likes and dislikes instead.",
    action: "",
  },
};

export default function DietaryTextHint({ offer, onAddRule }: {
  /** `null` hides the hint: no local answer yet, or the newest answer was not local. */
  offer: DietaryTextOffer | null;
  /** Jumps to the account's existing rule editor; omit to show the line with no action. */
  onAddRule?: () => void;
}) {
  if (!offer) return null;
  const copy = COPY[offer];
  return <Notice tone="attention" title={copy.title}
    action={copy.action && onAddRule ? { label: copy.action, onClick: onAddRule } : undefined} />;
}
