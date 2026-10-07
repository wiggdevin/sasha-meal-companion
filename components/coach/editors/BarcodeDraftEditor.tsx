"use client";

import { useState } from "react";
import Stepper from "@/components/Stepper";
import WorkingLine from "@/components/WorkingLine";
import AllergenCheck from "@/components/coach/editors/AllergenCheck";
import EditorPill from "@/components/coach/editors/EditorPill";
import DraftSlotPicker from "@/components/coach/editors/DraftSlotPicker";
import SanityNotices from "@/components/coach/editors/SanityNotices";
import ProjectedDayTotals, { type DayProjection } from "@/components/ProjectedDayTotals";
import type { BarcodeMatch, BarcodeResponse } from "@/lib/barcode/client";
import type { SanityAnnotation, TypicalServing } from "@/lib/log/sanity-types";
import type { SlotId } from "@/lib/types";
import { liveStrip } from "@/lib/log-client";
import { toCachedRevision } from "@/lib/barcode/client";
import { reasonLabel } from "@/lib/policy/reason-words";

const ROW: React.CSSProperties = { background: "var(--grad-card)", boxShadow: "var(--shadow-card)" };
const ROW_CLASS = "rounded-2xl";
const PRIMARY: React.CSSProperties = { height: 52, boxShadow: "var(--shadow-button)" };
const PRIMARY_CLASS = "text-body! font-medium!";
const META = "text-tiny font-normal text-muted";
const SECTION = "text-tiny font-normal text-graphite";

type SanityBarcodeMatch = BarcodeMatch & {
  sanity?: SanityAnnotation;
  typicalServing?: TypicalServing;
};

export type BarcodeDraftEdits = {
  match: BarcodeMatch;
  portionId: number | null;
  qty: number;
  grams: number;
  slot: SlotId;
};

export type BarcodeEditorDraft = {
  response: BarcodeResponse;
  slot: SlotId;
  saving?: boolean;
  error?: string | null;
  canSearchManually?: boolean;
  canEditSlot?: boolean;
  showSearchManually?: boolean;
  showDismiss?: boolean;
};

export function searchHintText(hint: { brand?: string; name?: string }): string {
  return [hint.brand, hint.name].filter((part) => part?.trim()).join(" ").trim();
}

export function gramsFor(
  match: BarcodeMatch,
  portionId: number | null,
  qty: number,
  explicitGrams: number | null = null,
): number {
  const portion = match.portions.find((candidate) => candidate.id === portionId);
  return Math.round((portion?.gramWeight ?? explicitGrams ?? 100) * qty * 10) / 10;
}

export function labelForBlockedReason(reason: string | undefined): string {
  return reasonLabel(reason, "Off-plan");
}

export function badgeFor(match: BarcodeMatch): { tone: "alert" | "amber" | "none"; label: string } {
  if (match.policy.verdict === "blocked") {
    return { tone: "alert", label: labelForBlockedReason(match.policy.reason) };
  }
  if (match.policy.verdict === "unverified") {
    return { tone: "amber", label: "No ingredient list — check the pack" };
  }
  return { tone: "none", label: "" };
}

function Badge({ match }: { match: BarcodeMatch }) {
  const badge = badgeFor(match);
  if (badge.tone === "none") return null;
  return (
    <span className="pill inline-flex">
      <span className={`pill-in  flex h-[30px] items-center px-3 text-tiny font-normal ${
        badge.tone === "alert" ? "text-alert" : "text-amber"
      }`}>{badge.label}</span>
    </span>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"
      fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />
    </svg>
  );
}

export default function BarcodeDraftEditor({
  draft, projection, onCommit, onSearchManually, onDismiss, onFavorite, onMatchChange,
}: {
  draft: BarcodeEditorDraft;
  projection?: DayProjection;
  onCommit: (edits: BarcodeDraftEdits) => void;
  onSearchManually: (hint: string) => void;
  onDismiss: () => void;
  onFavorite?: (foodRefId: string) => void;
  onMatchChange?: (match: BarcodeMatch) => void;
}) {
  const first = draft.response.status === "resolved" ? draft.response.match
    : draft.response.status === "ambiguous" ? draft.response.matches[0] : null;
  const [picked, setPicked] = useState<BarcodeMatch | null>(
    draft.response.status === "resolved" ? first : null,
  );
  const [portionId, setPortionId] = useState<number | null>(
    first?.portions.find((portion) => portion.isDefault)?.id ?? first?.portions[0]?.id ?? null,
  );
  const [qty, setQty] = useState(1);
  const [explicitGrams, setExplicitGrams] = useState<number | null>(null);
  const [slot, setSlot] = useState(draft.slot);
  const [starred, setStarred] = useState(false);
  const saving = draft.saving === true;

  if (draft.response.status === "not_found") {
    const hint = searchHintText(draft.response.searchHint);
    return (
      <div className="flex flex-col gap-3">
        <p className={`m-0 ${META}`}>Barcode {draft.response.gtin14}</p>
        <p className={`m-0 ${META}`}>We do not know this barcode yet.</p>
        {draft.showSearchManually !== false && (
          <button type="button" disabled={draft.canSearchManually === false}
            onClick={() => onSearchManually(hint)}
            className={`btn-ink tap w-full disabled:opacity-40 ${PRIMARY_CLASS}`} style={PRIMARY}>Search for it instead</button>
        )}
        {draft.showDismiss !== false && (
          <button type="button" onClick={onDismiss} className={`tap h-11 self-center px-4 ${SECTION}`}>Dismiss</button>
        )}
      </div>
    );
  }

  if (draft.response.status === "ambiguous" && picked === null) {
    return (
      <div className="flex flex-col gap-2">
        {draft.response.matches.map((match) => (
          <button key={match.revisionId} type="button" onClick={() => {
            setPicked(match);
            onMatchChange?.(match);
            setExplicitGrams(null);
            setPortionId(match.portions.find((portion) => portion.isDefault)?.id
              ?? match.portions[0]?.id ?? null);
          }} className={`tap flex w-full items-center gap-3 px-3.5 py-3 text-left ${ROW_CLASS}`} style={ROW}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-caption font-normal">{match.description}</span>
              <span className={META}>{[match.brand, match.attribution].filter(Boolean).join(" · ")}</span>
            </span>
            <Badge match={match} />
          </button>
        ))}
        {draft.showDismiss !== false && (
          <button type="button" onClick={onDismiss} className={`tap h-11 self-center px-4 ${SECTION}`}>Dismiss</button>
        )}
      </div>
    );
  }

  const match = (picked ?? first) as SanityBarcodeMatch | null;
  if (!match) return null;
  const grams = gramsFor(match, portionId, qty, explicitGrams);
  const strip = liveStrip(toCachedRevision(match, draft.response.gtin14), grams);

  return (
    <div className="flex flex-col gap-4">
      <AllergenCheck match={match} />
      <div className="flex items-center justify-between gap-3">
        <Badge match={match} />
        {onFavorite && (
          <button type="button" aria-label="Favourite this food" aria-pressed={starred}
            onClick={() => { setStarred(true); onFavorite(match.foodRefId); }}
            className="tap flex items-center justify-center rounded-full text-graphite"
            style={{ width: 44, height: 44 }}>
            <StarIcon filled={starred} />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className={SECTION}>Portion</span>
        <div className="flex flex-wrap gap-2">
          {match.portions.map((portion) => (
            <EditorPill key={portion.id} active={portion.id === portionId}
              onClick={() => { setPortionId(portion.id); setExplicitGrams(null); }}>
              {portion.gramWeight} g · {portion.description}
            </EditorPill>
          ))}
          <EditorPill active={portionId === null && (explicitGrams ?? 100) === 100}
            onClick={() => { setPortionId(null); setExplicitGrams(100); }}>
            100 g
          </EditorPill>
        </div>
      </div>

      <Stepper label="How many" value={qty} step={1}
        onChange={(next) => setQty(Math.max(1, next))} helperText={`${grams} g`} />
      {projection && <ProjectedDayTotals projection={projection} added={strip} />}
      <SanityNotices sanity={match.sanity} policy={match.policy}
        typicalServing={match.typicalServing} grams={grams}
        onUseTypical={(serving) => {
          const portion = match.portions.find((candidate) =>
            Math.abs(candidate.gramWeight - serving.grams) < 0.1);
          setPortionId(portion?.id ?? null);
          setExplicitGrams(portion ? null : serving.grams);
          setQty(1);
        }} />
      {draft.canEditSlot !== false && <DraftSlotPicker value={slot} onChange={setSlot} />}

      {match.ingredientsText && (
        <div className="flex flex-col gap-1">
          <span className={SECTION}>Ingredients</span>
          <p className={`m-0 ${META}`}>{match.ingredientsText}</p>
        </div>
      )}
      {match.attribution && <p className={`m-0 ${META}`}>{match.attribution}</p>}

      <div className="flex flex-col gap-2 pt-1">
        <WorkingLine active={saving} step="commit" />
        {draft.error && <p role="status" className="m-0 text-tiny font-normal text-alert">{draft.error}</p>}
        <button type="button" disabled={saving}
          onClick={() => onCommit({ match, portionId, qty, grams, slot })}
          className={`btn-ink tap w-full disabled:opacity-40 ${PRIMARY_CLASS}`} style={PRIMARY}>Log it</button>
        {draft.showSearchManually !== false && (
          <button type="button" disabled={draft.canSearchManually === false}
            onClick={() => onSearchManually(match.description)}
            className={`tap h-11 self-center px-4 disabled:opacity-40 ${SECTION}`}>Search manually</button>
        )}
        {draft.showDismiss !== false && (
          <button type="button" onClick={onDismiss} className={`tap h-11 self-center px-4 ${SECTION}`}>Dismiss</button>
        )}
      </div>
    </div>
  );
}
