"use client";

/**
 * T11b: the four body-profile fields, on Settings → Body data. They exist to feed the formula and
 * activity lines of `components/TdeeLines.tsx` and nothing else — the card says so, because a
 * height or an age must never look like a target change.
 *
 * Self-contained on purpose: it mounts inside `components/BodyDataCard.tsx` (the Body-data card),
 * so `app/settings/page.tsx` — already over the 400-line limit — only mounts the card. The write
 * path is `lib/body-profile-client.ts`; the read is that file's `subscribeBodyProfile` signal.
 *
 * The drafts, the commit and the retry are `lib/body-profile-fields.ts` (fifth-audit finding 4:
 * this file is the view, and the coordination a test can drive lives there).
 */
import { blurOnEnter, NUMBER_FIELDS, SAVE_ERROR, useBodyProfileFields, type DraftKey, type Drafts }
  from "@/lib/body-profile-fields";
import HeightField from "@/components/HeightField";
import GlassSelect from "@/components/ui/GlassSelect";
import { publishBodyProfile } from "@/lib/body-profile-client";
import { persistProfilePatch, type ProfilePatch }
  from "@/components/settings/use-settings-controller";
import { loadStore } from "@/lib/store";
import type { HeightUnit } from "@/lib/units/height";
import { useRef, useState, type ReactNode } from "react";

/* One form rhythm (2026-10-01, the owner: "no breathing room"): every field stacks its label over
   the box, 6 px apart; groups sit 24 px apart; helper text hangs 6 px under its field. */
const FIELD_LABEL = "text-caption font-medium text-charcoal";
const LABEL = "text-tiny font-normal leading-normal text-muted";
const INPUT = "well min-h-11 w-full min-w-0 bg-transparent px-3 text-body text-charcoal tabular-nums "
  + "outline-none placeholder:text-muted";
const ALERT = "text-tiny font-normal text-alert";

/** One number field: its label over the box, and the message an invalid draft leaves under it. */
function NumberFieldRow({ field, draft, error, onEdit, onCommit, onFocus }: {
  field: (typeof NUMBER_FIELDS)[number]; draft: string; error?: string;
  onEdit: (raw: string) => void; onCommit: () => void; onFocus: () => void;
}) {
  const errorId = `body-profile-${field.key}-error`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className={FIELD_LABEL}>
          {field.unit === "" ? field.label : field.label + " (" + field.unit + ")"}
        </span>
        <input type="text" inputMode={field.integer ? "numeric" : "decimal"}
          aria-label={field.label} aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          min={field.min} max={field.max} value={draft}
          placeholder={field.key === "birthYear" ? "Year" : "%"}
          className={INPUT}
          onChange={(e) => onEdit(e.target.value)} onBlur={onCommit} onFocus={onFocus}
          onKeyDown={(e) => blurOnEnter(e.key, () => e.currentTarget.blur())} />
      </label>
      {error && <p id={errorId} role="alert" className={`m-0 ${ALERT}`}>{error}</p>}
    </div>
  );
}

export function BodyProfileFieldsView({ drafts, draftErrors, error, onEdit, onCommit, onSex,
  onRetry, onFocus, intro, heightUnit = "ft_in", onHeightChange,
  onHeightUnitChange = () => {} }: {
  drafts: Drafts;
  heightUnit?: HeightUnit;
  /** Per-row messages for text that is not a number, under the box that holds it. */
  draftErrors?: Partial<Record<DraftKey, string>>;
  error: string | null;
  onEdit: (key: DraftKey, raw: string) => void;
  onHeightChange?: (cm: number | null) => void;
  onHeightUnitChange?: (unit: HeightUnit) => void;
  onCommit: (key: DraftKey) => void;
  onSex: (raw: string) => void;
  onRetry: () => void;
  /** Optional: the phone reports focus so a refresh cannot rewrite the box under their cursor. */
  onFocus?: (key: DraftKey) => void;
  /** Onboarding reuses the fields but explains their new target-setting purpose in its own words. */
  intro?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      {intro ?? (
        <p className={`m-0 ${LABEL}`}>
          These feed formula and activity estimates. Targets change only through the weekly proposal.
          These estimates are not medical advice; review health decisions with your clinician.
        </p>
      )}
      <HeightField valueCm={drafts.heightCm.trim() === "" ? null : Number(drafts.heightCm)}
        unit={heightUnit}
        onChange={(cm) => onHeightChange
          ? onHeightChange(cm)
          : onEdit("heightCm", cm === null ? "" : String(cm))}
        onUnitChange={onHeightUnitChange} />
      {/* Two short numbers side by side, the way Feet and Inches pair above. */}
      <div className="grid grid-cols-2 gap-3">
        {NUMBER_FIELDS.filter((field) => field.key !== "heightCm").map((field) => (
          <NumberFieldRow key={field.key} field={field} draft={drafts[field.key]}
            error={draftErrors?.[field.key]} onEdit={(raw) => onEdit(field.key, raw)}
            onCommit={() => onCommit(field.key)} onFocus={() => onFocus?.(field.key)} />
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>Sex used in formula</span>
          <GlassSelect aria-label="Sex used in formula" aria-describedby="sex-formula-help"
            className={INPUT} value={drafts.sex} onChange={onSex}
            options={[{ value: "", label: "Not set" }, { value: "female", label: "Female" },
              { value: "male", label: "Male" },
              { value: "unspecified", label: "Prefer not to say" }]} />
        </label>
        <p id="sex-formula-help" className={`m-0 ${LABEL}`}>
          This is a physiological formula input, not your gender identity.
        </p>
      </div>
      {error && (
        <p role="alert" className={`m-0 flex min-h-11 items-center justify-between gap-3 ${ALERT}`}>
          {error}
          <button type="button" onClick={onRetry}
            className="tap min-h-11 shrink-0 px-3 text-tiny font-normal text-charcoal">
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

export default function BodyProfileFields() {
  const { drafts, draftErrors, error, onEdit, onCommit, onSex, onFocus, onRetry } =
    useBodyProfileFields();
  const [heightUnit, setHeightUnit] = useState<HeightUnit>(
    () => loadStore().settings.heightUnit ?? "ft_in");
  const [failedHeightPatch, setFailedHeightPatch] = useState<ProfilePatch>({});
  const writes = useRef(Promise.resolve());

  function saveHeightPatch(patch: ProfilePatch): void {
    setFailedHeightPatch((failed) => {
      const next = { ...failed };
      for (const key of Object.keys(patch) as (keyof ProfilePatch)[]) delete next[key];
      return next;
    });
    const attempt = writes.current.then(() => persistProfilePatch(loadStore(), patch));
    writes.current = attempt.then(() => undefined, () => undefined);
    void attempt.then(
      () => { if (Object.hasOwn(patch, "heightCm")) publishBodyProfile(); },
      () => setFailedHeightPatch((failed) => ({ ...failed, ...patch })),
    );
  }
  function saveHeight(heightCm: number | null): void {
    saveHeightPatch({ heightCm });
  }
  function saveHeightUnit(nextUnit: HeightUnit): void {
    setHeightUnit(nextUnit);
    saveHeightPatch({ heightUnit: nextUnit });
  }
  const saveFailed = Object.keys(failedHeightPatch).length > 0;
  return (
    <BodyProfileFieldsView drafts={drafts} draftErrors={draftErrors}
      error={saveFailed ? SAVE_ERROR : error}
      heightUnit={heightUnit} onHeightUnitChange={saveHeightUnit}
      onHeightChange={saveHeight}
      onEdit={onEdit} onCommit={onCommit} onSex={onSex} onFocus={onFocus}
      onRetry={saveFailed ? () => saveHeightPatch(failedHeightPatch) : onRetry} />
  );
}
