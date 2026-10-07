import type { SanityAnnotation, TypicalServing } from "@/lib/log/sanity-types";
import { preferenceNotVerified, type PolicyNotice } from "@/components/coach/editors/not-verified";

const COPY: Record<SanityAnnotation["warnings"][number]["level"], string | null> = {
  tiny: "Looks like a small portion for one serving.",
  implausible: "That portion looks too large for one serving.",
  not_food: "This may not be food or drink.",
  far_too_small: "Looks far too small for one serving.",
  small: "Looks like a small portion for one serving.",
  typical: null,
  large: "Looks like a large portion for one serving.",
  far_too_large: "Looks far too large for one serving.",
};

export function sanityWarningCopy(
  level: SanityAnnotation["warnings"][number]["level"],
): string | null {
  return COPY[level];
}

export default function SanityNotices({
  sanity, policy, typicalServing, grams, onUseTypical,
}: {
  sanity?: SanityAnnotation;
  policy: PolicyNotice;
  typicalServing?: TypicalServing;
  grams: number;
  onUseTypical?: (serving: TypicalServing) => void;
}) {
  const warnings = sanity?.warnings.flatMap((warning) => {
    const copy = sanityWarningCopy(warning.level);
    return copy ? [{ ...warning, copy }] : [];
  }) ?? [];
  const showTypical = typicalServing !== undefined && onUseTypical !== undefined
    && Math.abs(typicalServing.grams - grams) >= 0.1
    && warnings.some((warning) => warning.kind === "portion");
  const isNotVerified = preferenceNotVerified(sanity, policy);
  if (warnings.length === 0 && !isNotVerified && !showTypical) return null;

  return (
    <div className="flex flex-col items-start gap-2">
      {warnings.map((warning, index) => (
        <span key={`${warning.kind}-${warning.level}-${index}`} className="pill inline-flex">
          <span className="pill-in px-3 py-2 text-tiny font-normal text-alert">
            {warning.copy}
          </span>
        </span>
      ))}
      {isNotVerified && (
        <span className="pill inline-flex">
          <span className="pill-in px-3 py-2 text-tiny font-normal text-amber">
            We could not verify this food for your preferences.
          </span>
        </span>
      )}
      {showTypical && (
        <button type="button" onClick={() => onUseTypical(typicalServing)}
          className="tap min-h-11 px-1 text-tiny font-normal text-charcoal underline"
          style={{ minHeight: 44 }}
          title={`${typicalServing.label} · ${typicalServing.grams} g`}>
          Use typical serving
        </button>
      )}
    </div>
  );
}
