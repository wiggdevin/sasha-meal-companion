"use client";

/**
 * The meal's own details on the capture confirm sheet (W125, T2): an editable name, the time it
 * was eaten (the photo's shot time when the phone could read one), and "Save as recipe". Shown only
 * where the caller asks for it (CaptureConfirm), never on the coach's log drafts.
 */

const FIELD = "well tap w-full px-4 py-3 text-body font-medium text-charcoal outline-none placeholder:text-muted";
const LABEL = "pl-1.5 text-tiny font-normal text-graphite";
const SECTION = "text-tiny font-normal text-graphite";

export type CaptureDetails = {
  /** The meal's name; empty means the app names it from its foods. */
  title: string;
  /** "HH:MM" on the capture's day, or null for the moment Save is tapped. */
  clock: string | null;
  saveAsRecipe: boolean;
};

export type CaptureDetailsSpec = {
  /** The name the sheet starts with: the label's own, else empty. */
  defaultTitle?: string;
  /** What the time control starts at, and where that came from. */
  defaultClock: string;
  clockSource: "photo" | "slot" | "now";
  /** A label food is named by its own field; the meal keeps that name. */
  nameLabel?: string;
};

export default function CaptureMealDetails({ spec, value, onChange }: {
  spec: CaptureDetailsSpec;
  value: CaptureDetails;
  onChange: (next: CaptureDetails) => void;
}) {
  const clockNote = spec.clockSource === "photo" ? "From the photo" : null;
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className={LABEL}>{spec.nameLabel ?? "Meal name"}</span>
        <input value={value.title} maxLength={80} aria-label={spec.nameLabel ?? "Meal name"}
          placeholder="Name this meal"
          onChange={(event) => onChange({ ...value, title: event.target.value })}
          className={FIELD} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={LABEL}>Eaten at{clockNote ? ` · ${clockNote}` : ""}</span>
        <input type="time" aria-label="Eaten at" value={value.clock ?? spec.defaultClock}
          onChange={(event) => onChange({ ...value, clock: event.target.value || null })}
          className={FIELD} />
      </label>
      <button type="button" aria-pressed={value.saveAsRecipe}
        onClick={() => onChange({ ...value, saveAsRecipe: !value.saveAsRecipe })}
        className={`tap h-11 self-start px-1 text-left ${SECTION}`}>
        {value.saveAsRecipe ? "Also saving as a recipe" : "Save as recipe"}
      </button>
    </div>
  );
}
