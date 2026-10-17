"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Stepper from "@/components/Stepper";
import WorkingLine from "@/components/WorkingLine";
import AllergenFindingLines from "@/components/coach/editors/AllergenFindingLines";
import EditorPill from "@/components/coach/editors/EditorPill";
import PortionFollowUps from "@/components/coach/editors/PortionFollowUps";
import CaptureMealDetails, {
  type CaptureDetails, type CaptureDetailsSpec,
} from "@/components/coach/editors/CaptureMealDetails";
import DraftSlotPicker from "@/components/coach/editors/DraftSlotPicker";
import SanityNotices from "@/components/coach/editors/SanityNotices";
import ProjectedDayTotals, { type DayProjection } from "@/components/ProjectedDayTotals";
import {
  applyEdits, canSave, keptItems, LOW_CONFIDENCE, policyCopy,
  type DraftEdits, type EditedItem,
} from "@/lib/capture-client";
import type { DraftItem, ProposeResponse } from "@/lib/capture/types";
import { labelItemSeq } from "@/lib/capture/label-food";
import LabelAllergenLines from "@/components/coach/editors/LabelAllergenLines";
import type { CachedPortion, CachedRevision } from "@/lib/db/catalog-cache";
import { projectedCaptureMacros, selectedRevision } from "@/lib/capture/preview";
import { gramsForPortion } from "@/lib/log/grams";
import type { SanityAnnotation, TypicalServing } from "@/lib/log/sanity-types";
import type { SlotId } from "@/lib/types";

const ROW: React.CSSProperties = { background: "var(--grad-card)", boxShadow: "var(--shadow-card)" };
const ROW_CLASS = "rounded-2xl";
const PRIMARY: React.CSSProperties = { height: 52, boxShadow: "var(--shadow-button)" };
const PRIMARY_CLASS = "text-body! font-medium!";
const META = "text-tiny font-normal text-muted";
const SECTION = "text-tiny font-normal text-graphite";
export type CaptureDraftEdits = {
  items: DraftEdits;
  saveLabelAsFood: boolean;
  slot?: SlotId;
  /** The meal's name, time and "Save as recipe" (W125), when the sheet offered them. */
  details?: CaptureDetails;
};

export type CaptureEditorDraft = {
  proposal: ProposeResponse;
  portions: Record<number, CachedPortion[]>;
  revisions?: Record<number, CachedRevision>;
  alternativeRevisions?: Record<string, CachedRevision>;
  slot?: SlotId;
  saving?: boolean;
  message?: string | null;
  commitLabel?: "save" | "log";
  canSearchManually?: boolean;
  canEditSlot?: boolean;
  showDismiss?: boolean;
  blockedItemIds?: string[];
  /** Offer the meal's name, time and "Save as recipe" (W125). The capture sheet's, not the coach's. */
  details?: CaptureDetailsSpec;
};

export type CaptureDraftLayout = (regions: { body: ReactNode; footer: ReactNode }) => ReactNode;

type SanityItem = DraftItem & {
  sanity?: SanityAnnotation;
  typicalServing?: TypicalServing;
};
type EditedSanityItem = EditedItem & Pick<SanityItem, "sanity" | "typicalServing">;

function PolicyPill({ item }: { item: EditedItem }) {
  const copy = policyCopy(item.policy);
  if (copy === null) return null;
  const colour = item.policy.verdict === "blocked" ? "var(--color-alert)" : "var(--color-muted)";
  return (
    <span className="pill inline-flex shrink-0">
      <span className="pill-in flex h-8 items-center gap-1.5 px-3">
        <span className="rounded-full" style={{ width: 6, height: 6, background: colour }} />
        <span className={SECTION}>{copy}</span>
      </span>
    </span>
  );
}

function ItemRow({ item, portions, firstRef, onEdit }: {
  item: EditedSanityItem;
  portions: CachedPortion[];
  firstRef?: React.RefObject<HTMLDivElement | null>;
  onEdit: (patch: Record<string, unknown>) => void;
}) {
  const defaultPortion = portions.find((portion) => portion.isDefault);
  const typicalServing = item.typicalServing ?? (defaultPortion ? {
    grams: defaultPortion.gramWeight, label: defaultPortion.description,
  } : undefined);
  return (
    <div style={ROW} className={`flex flex-col gap-3 px-3.5 py-3 ${ROW_CLASS}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-caption font-normal">{item.label}</span>
          {item.foodRefId === null && <span className={META}>No match yet. Choose one below, or remove it.</span>}
          {item.confidence < LOW_CONFIDENCE && <span className={SECTION}>Best guess. Check it.</span>}
        </div>
        <PolicyPill item={item} />
      </div>

      {/* finding #11: not just the pill's colour — AllergenFindingLines says why. */}
      {(item.policy.allergens?.length ?? 0) > 0 && <div className="flex flex-col gap-1"
        aria-label="Allergens"><AllergenFindingLines findings={item.policy.allergens ?? []} /></div>}
      <div ref={firstRef}>
        <Stepper label="Grams" value={item.grams} step={5} unit="g"
          onChange={(grams) => onEdit({ grams: Math.max(0, grams), qty: Math.max(0, grams),
            unit: "g", portionId: null })} />
      </div>

      <SanityNotices sanity={item.sanity} policy={item.policy}
        typicalServing={typicalServing} grams={item.grams}
        onUseTypical={(serving) => onEdit({
          grams: serving.grams, qty: serving.grams, unit: "g", portionId: null,
        })} />

      {portions.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className={SECTION}>Portion</span>
          <div className="flex flex-wrap gap-1.5">
            {portions.map((portion) => (
              <EditorPill key={portion.id} active={item.portionId === portion.id} onClick={() => onEdit({
                grams: gramsForPortion(portion, 1), qty: 1, unit: "portion", portionId: portion.id,
              })}>{portion.description} · {portion.gramWeight} g</EditorPill>
            ))}
          </div>
        </div>
      )}

      {item.alternatives.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className={SECTION}>Try another match</span>
          <div className="flex flex-wrap gap-1.5">
            {item.alternatives.slice(0, 3).map((alternative) => (
              <EditorPill key={alternative.foodRefId}
                onClick={() => onEdit({ foodRefId: alternative.foodRefId, label: alternative.label,
                  catalogFoodRevisionId: alternative.catalogFoodRevisionId ?? null,
                  qty: item.grams, unit: "g", portionId: null })}>
                {alternative.label}
              </EditorPill>
            ))}
          </div>
        </div>
      )}

      <button type="button" onClick={() => onEdit({ removed: true })}
        className={`tap h-11 self-start px-1 text-left ${SECTION}`}>Remove</button>
    </div>
  );
}

export default function CaptureDraftEditor({
  draft, projection, onCommit, onSearchManually, onDismiss, onRerunAsLabel,
  autoFocusGrams = false, renderLayout,
}: {
  draft: CaptureEditorDraft;
  projection?: DayProjection;
  onCommit: (edits: CaptureDraftEdits) => void;
  onSearchManually: () => void;
  onDismiss: () => void;
  onRerunAsLabel?: () => void;
  autoFocusGrams?: boolean;
  renderLayout?: CaptureDraftLayout;
}) {
  const [edits, setEdits] = useState<DraftEdits>({});
  const [saveLabel, setSaveLabel] = useState(draft.proposal.method === "label");
  const [slot, setSlot] = useState<SlotId | undefined>(draft.slot);
  const [rerunUsed, setRerunUsed] = useState(false);
  const [details, setDetails] = useState<CaptureDetails>({
    title: draft.details?.defaultTitle ?? "", clock: null, saveAsRecipe: false,
  });
  const firstGrams = useRef<HTMLDivElement | null>(null);
  const blockedItemIds = new Set(draft.blockedItemIds ?? []);
  const items = (applyEdits(draft.proposal.items, edits) as EditedSanityItem[]).map((item) =>
    item.foodRefId !== null && blockedItemIds.has(item.foodRefId)
      ? { ...item, policy: { ...item.policy, verdict: "blocked" as const } }
      : item);
  const kept = keptItems(items);
  const labelSeq = labelItemSeq(draft.proposal, edits, saveLabel);
  const added = projectedCaptureMacros(kept, draft, { seq: labelSeq, per100g: draft.proposal.labelFood?.per100g });
  const ready = canSave(items, labelSeq) && draft.saving !== true;
  const commitCopy = draft.commitLabel === "save"
    ? `Save ${kept.length} item${kept.length === 1 ? "" : "s"}` : "Log it";

  useEffect(() => {
    if (autoFocusGrams && draft.proposal.method === "photo") {
      firstGrams.current?.querySelector("button")?.focus();
    }
  }, [autoFocusGrams, draft.proposal.method]);

  function edit(seq: number, patch: Record<string, unknown>) {
    setEdits((current) => ({ ...current, [seq]: { ...current[seq], ...patch } }));
  }
  const portionsOf = (item: EditedSanityItem): CachedPortion[] =>
    item.foodRefId === draft.proposal.items.find((row) => row.seq === item.seq)?.foodRefId
      ? draft.portions[item.seq] ?? []
      : selectedRevision(item, draft)?.portions.filter((portion) =>
        Number.isFinite(portion.gramWeight) && portion.gramWeight > 0) ?? [];

  const body = (
    <>
      {draft.proposal.notes.map((note) => <p key={note} className={META}>{note}</p>)}
      {items.length === 0 && <p className="text-caption font-normal text-graphite">
        Nothing came back to check. Search your foods instead.
      </p>}
      <PortionFollowUps proposed={draft.proposal.items} items={items} portionsOf={portionsOf}
        onAnswer={edit} />
      {items.filter((item) => !item.removed).map((item, index) => (
        <ItemRow key={item.seq} item={item} portions={portionsOf(item)}
          firstRef={index === 0 ? firstGrams : undefined}
          onEdit={(patch) => edit(item.seq, patch)} />
      ))}
      {projection && kept.length > 0 && (added
        ? <ProjectedDayTotals projection={projection} added={added} />
        : <p role="status" className="m-0 text-caption text-muted">
            Resolve each food and portion to preview day totals.
          </p>)}

      {draft.proposal.method === "label" && draft.proposal.labelFood && (
        <div style={ROW} className={`flex flex-col gap-2 px-3.5 py-3 ${ROW_CLASS}`}>
          <span className="text-caption font-normal">
            {draft.proposal.labelFood.name}
          </span>
          {draft.proposal.labelFood.brand && <span className={META}>{draft.proposal.labelFood.brand}</span>}
          <LabelAllergenLines label={draft.proposal.labelFood} />
          <button type="button" onClick={() => setSaveLabel((value) => !value)}
            aria-pressed={saveLabel} className={`tap h-11 self-start px-1 ${SECTION}`}>
            {saveLabel ? "Saving as my food" : "Save as my food"}
          </button>
        </div>
      )}

      {draft.details && kept.length > 0
        && <CaptureMealDetails spec={draft.details} value={details} onChange={setDetails} />}

      {draft.canEditSlot !== false && slot !== undefined
        && <DraftSlotPicker value={slot} onChange={setSlot} />}
    </>
  );
  const footer = (
    <div className="flex flex-col gap-2 pt-1">
        <button type="button" disabled={!ready}
          onClick={() => onCommit({ items: edits, saveLabelAsFood: saveLabel,
            ...(slot === undefined ? {} : { slot }), ...(draft.details ? { details } : {}) })}
          className={`btn-ink tap w-full disabled:opacity-40 ${PRIMARY_CLASS}`} style={PRIMARY}>
          {draft.saving ? "Saving" : commitCopy}
        </button>
        <WorkingLine active={draft.saving === true} step="commit" />
        {draft.message && <p role="status" className={`px-1.5 ${META}`}>{draft.message}</p>}
        {draft.canSearchManually !== false && (
          <button type="button" disabled={draft.saving === true} onClick={onSearchManually}
            className={`tap h-11 self-center px-4 disabled:opacity-40 ${SECTION}`}>Search manually</button>
        )}
        {draft.proposal.method === "photo" && onRerunAsLabel && !rerunUsed && (
          <button type="button" disabled={draft.saving === true}
            onClick={() => { setRerunUsed(true); onRerunAsLabel(); }}
            className={`tap h-11 self-center px-4 disabled:opacity-40 ${SECTION}`}>This was a nutrition label</button>
        )}
        {draft.showDismiss !== false && (
          <button type="button" disabled={draft.saving === true} onClick={onDismiss}
            className={`tap h-11 self-center px-4 disabled:opacity-40 ${SECTION}`}>Dismiss</button>
        )}
    </div>
  );

  if (renderLayout) return renderLayout({ body, footer });
  return (
    <div className="flex flex-col gap-3 px-1">
      {body}
      {footer}
    </div>
  );
}
