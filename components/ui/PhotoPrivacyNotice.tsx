/**
 * The one line the W12 boundary requires before a photo-of-food camera or file picker opens
 * (Phase 18 W12-F, docs/specs/phase-18-open-world-foods.md "The W12 boundary" item 2 and acceptance
 * 8): ask the user to keep medicines, prescriptions and labels with names out of frame. The photo
 * itself still reaches a model (the zero-retention OpenRouter lane, `lib/ai/openrouter.ts`); this
 * notice is the one mitigation the UI owns.
 *
 * Deliberately not a dialog: it renders beside the photo control, in the sheet, before any tap, so
 * it costs no extra confirmation on every photo (spec: "present before capture" is the requirement,
 * not a blocking step). Shared so the later "Photo of my fridge" pantry capture (W12) can reuse the
 * same line instead of writing its own.
 */
export default function PhotoPrivacyNotice({ className = "" }: { className?: string }) {
  return (
    <p className={`m-0 px-1 text-tiny text-muted ${className}`.trim()}>
      Keep medicines, prescriptions and labels with names out of the photo.
    </p>
  );
}
