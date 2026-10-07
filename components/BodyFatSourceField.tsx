"use client";

/**
 * "Where is this number from?" under the body-fat box (step C,
 * docs/plans/2026-09-22-tdee-engine-plan.md). Only a DEXA, InBody or clinic scan from the last
 * 180 days lets the starting burn use lean mass (Katch-McArdle); everything else uses height,
 * weight and age (Mifflin-St Jeor). The rule lives in `lib/profile/energy.ts` `katchEligible`;
 * this field only records the answer. Shown only while a body-fat number is set.
 */
import { useId } from "react";
import { BODY_FAT_SOURCES, type BodyFatSource } from "@/lib/types";
import GlassSelect from "@/components/ui/GlassSelect";
import DateField from "@/components/ui/DateField";

export const BODY_FAT_SOURCE_LABELS: Record<BodyFatSource, string> = {
  dexa: "DEXA scan",
  inbody: "InBody scan",
  clinical_bia: "Clinic body-composition test",
  consumer_scale: "Bathroom scale",
  visual_estimate: "Estimated by eye or from a chart",
  typed_unknown: "A guess",
};

const MEASURED: ReadonlySet<BodyFatSource> = new Set(["dexa", "inbody", "clinical_bia"]);

export type BodyFatProvenancePatch = {
  bodyFatSource: BodyFatSource | null;
  bodyFatMeasuredOn: string | null;
};

/** The write a new source asks for: an unmeasured source never keeps a scan date. */
export function sourcePatch(raw: string, measuredOn: string | null): BodyFatProvenancePatch {
  const source = (BODY_FAT_SOURCES as readonly string[]).includes(raw)
    ? raw as BodyFatSource : null;
  return { bodyFatSource: source,
    bodyFatMeasuredOn: source !== null && MEASURED.has(source) ? measuredOn : null };
}

export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export default function BodyFatSourceField({ source, measuredOn, onChange, fieldClass,
  fieldClassName, labelClassName, captionClassName }: {
  source: BodyFatSource | null;
  measuredOn: string | null;
  onChange: (patch: BodyFatProvenancePatch) => void;
  fieldClass: string;
  fieldClassName?: string;
  labelClassName: string;
  captionClassName: string;
}) {
  const id = useId();
  const measured = source !== null && MEASURED.has(source);
  const field = fieldClassName ? `${fieldClass} ${fieldClassName}` : fieldClass;
  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className={labelClassName}>Where is this number from?</span>
        <GlassSelect aria-label="Body fat source" aria-describedby={`${id}-help`}
          className={field} value={source ?? ""}
          onChange={(next) => onChange(sourcePatch(next, measuredOn))}
          options={[{ value: "", label: "Not sure" },
            ...BODY_FAT_SOURCES.map((key) => ({ value: key, label: BODY_FAT_SOURCE_LABELS[key] }))]} />
      </label>
      {measured && (
        <label className="flex flex-col gap-1.5">
          <span className={labelClassName}>Scan date</span>
          <DateField aria-label="Scan date" className={field}
            max={localToday()} value={measuredOn} allowClear
            onChange={(next) => onChange({ bodyFatSource: source, bodyFatMeasuredOn: next })} />
        </label>
      )}
      {/* The note hangs 6 px under the last field, as every helper does (DESIGN.md §Text fields). */}
      <p id={`${id}-help`} className={`mx-0 mb-0 -mt-2.5 ${captionClassName}`}>
        {measured && measuredOn === null
          ? "Add the scan date to use it."
          : "A DEXA, InBody or clinic scan from the last 6 months sets your starting burn from "
            + "lean mass. Anything else uses your height, weight and age."}
      </p>
    </div>
  );
}
