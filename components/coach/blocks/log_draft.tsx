"use client";

import { useRef, useState } from "react";
import BarcodeDraftEditor, {
  labelForBlockedReason, type BarcodeDraftEdits,
} from "@/components/coach/editors/BarcodeDraftEditor";
import CaptureDraftEditor, {
  type CaptureDraftEdits,
} from "@/components/coach/editors/CaptureDraftEditor";
import { useCaptureRevisions } from "@/components/coach/editors/useCaptureRevisions";
import { useDayProjection } from "@/components/coach/editors/useDayProjection";
import type { LogDraftBlockContext, LogDraftCommit } from "@/components/coach/blocks/context";
import { toCachedRevision } from "@/lib/barcode/client";
import { commitDraft } from "@/lib/capture-client";
import type { ProposeResponse } from "@/lib/capture/types";
import { offPlanFor } from "@/lib/catalog-client";
import { commitLogEntry } from "@/lib/log-commit-client";
import { buildCommitRequest } from "@/lib/log-client";
import { catalogCard } from "@/lib/log/catalog-card";
import { forgetLoggedEntry } from "@/lib/log/delete-entry";
import { opIdFor } from "@/lib/log/op-id";
import { savedFrom } from "@/lib/log/outcome";
import { NUTRITION_UNCHECKED_COPY, commitNutritionUnchecked } from "@/lib/nutrition-display";
import { instantAt } from "@/lib/coach/apply-shared";
import type { SlotId } from "@/lib/types";
import type { LogDraftBlockV1, ResolvedBarcodeDraft } from "@/lib/coach/ui-blocks";
import Notice from "@/components/ui/Notice";
import AiLabel from "@/components/ui/AiLabel";

const VALID_SLOTS = new Set<string>([
  "coffee", "pouches-pre", "post-refuel", "meal-1", "meal-2", "meal-3", "meal-4", "meal-5", "meal-6", "hot-chocolate",
]);
const META = "text-tiny font-normal text-muted";
const LINK: React.CSSProperties = { minHeight: 44 };
const LINK_CLASS = "text-tiny font-normal text-graphite";

function slotOf(block: LogDraftBlockV1): SlotId {
  return VALID_SLOTS.has(block.slot ?? "") ? block.slot as SlotId : "meal-1";
}

function isBarcodeDraft(draft: LogDraftBlockV1["draft"]): draft is ResolvedBarcodeDraft {
  return "status" in draft;
}

function isCaptureDraft(draft: LogDraftBlockV1["draft"]): draft is ProposeResponse {
  return "draftId" in draft;
}

function summaryForCapture(draft: ProposeResponse, edits: CaptureDraftEdits): string {
  const removed = new Set(Object.entries(edits.items)
    .filter(([, edit]) => edit.removed === true).map(([seq]) => Number(seq)));
  const names = draft.items.filter((item) => !removed.has(item.seq)).map((item) =>
    edits.items[item.seq]?.label ?? item.label);
  return names.length === 1 ? names[0] : `${names.length} items`;
}

function summaryOf(block: LogDraftBlockV1): string {
  if (isBarcodeDraft(block.draft)) return block.draft.match.description;
  const names = block.draft.items.map((item) => item.label);
  return names.length === 1 ? names[0] : `${names.length} items`;
}

const savedNote = (result: Parameters<typeof commitNutritionUnchecked>[0]) =>
  commitNutritionUnchecked(result) ? NUTRITION_UNCHECKED_COPY : undefined;

async function commitBarcode(
  block: LogDraftBlockV1, edits: BarcodeDraftEdits, tz: string,
): Promise<LogDraftCommit> {
  if (!isBarcodeDraft(block.draft)) throw new Error("That barcode draft is no longer available.");
  const entryId = opIdFor(block.id, undefined);
  const itemId = opIdFor(`${block.id}:item:0`, undefined);
  const at = instantAt(block.localDate, "12:00", tz);
  if (!at) throw new Error("That draft date is no longer available.");
  const revision = toCachedRevision(edits.match, block.draft.gtin14);
  const request = buildCommitRequest({
    entryId, eatenAt: at, tz, slot: edits.slot, method: "barcode",
    items: [{ id: itemId, foodRefId: edits.match.foodRefId, revision, grams: edits.grams,
      qty: edits.qty, unit: edits.portionId === null ? "g" : "portion",
      portionId: edits.portionId }],
  });
  const entry = catalogCard({
    revision, entryId, itemId, foodRefId: edits.match.foodRefId, grams: edits.grams,
    qty: edits.qty, at,
    portion: edits.match.portions.find((portion) => portion.id === edits.portionId) ?? null,
    flags: offPlanFor(edits.match),
  });
  const result = await commitLogEntry(request, {
    timingPath: "barcode", optimistic: { date: request.local_date, entry },
  });
  const saved = savedFrom(result);
  if (!saved.ok) throw new Error(saved.message);
  return { entryIds: [entryId], summary: edits.match.description, saved: savedNote(result) };
}

async function commitCapture(
  block: LogDraftBlockV1, edits: CaptureDraftEdits, tz: string,
): Promise<LogDraftCommit> {
  if (!isCaptureDraft(block.draft)) throw new Error("That photo draft is no longer available.");
  const entryId = opIdFor(block.id, undefined);
  const eatenAt = instantAt(block.localDate, "12:00", tz);
  if (!eatenAt) throw new Error("That draft date is no longer available.");
  const result = await commitDraft(block.draft, edits.items, {
    entryId, eatenAt, tz, slot: edits.slot ?? slotOf(block),
    saveLabelAsFood: edits.saveLabelAsFood,
  });
  const saved = savedFrom(result);
  if (!saved.ok) throw new Error(saved.message);
  return { entryIds: [entryId], summary: summaryForCapture(block.draft, edits), saved: savedNote(result) };
}

function PhotoPreview({ block, ctx }: { block: LogDraftBlockV1; ctx: LogDraftBlockContext }) {
  const [missing, setMissing] = useState(false);
  const url = ctx.photoUrl?.(block);
  if (!url || missing) {
    return <span className="pill inline-flex self-start"><span className={`pill-in px-3 py-2 ${META}`}>
      Photo attached</span></span>;
  }
  // The URL is a short-lived signed object URL; Next Image cannot safely optimize it.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="Photo attached" onError={() => setMissing(true)}
    className="h-24 w-full rounded-xl object-cover" />;
}

function BlockedDraft({ block, ctx }: { block: LogDraftBlockV1; ctx: LogDraftBlockContext }) {
  const copy = labelForBlockedReason(block.policy.reason);
  return <Notice tone="error" title={copy}
    action={{ label: "Search manually", onClick: () => ctx.onSearchManually(block) }} />;
}

export default function LogDraftBlock({ block, ctx }: {
  block: LogDraftBlockV1;
  ctx: LogDraftBlockContext;
}) {
  const [status, setStatus] = useState(block.status);
  const [entryIds, setEntryIds] = useState(block.entryIds ?? []);
  const [summary, setSummary] = useState(() => summaryOf(block));
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claimed = useRef(false);
  const completedCommit = useRef<LogDraftCommit | null>(null);
  const captureDraft = isCaptureDraft(block.draft) ? block.draft : null;
  const { portions, revisions, alternativeRevisions } = useCaptureRevisions(captureDraft);
  const projection = useDayProjection(block.localDate);

  async function update(next: LogDraftBlockV1["status"], ids?: string[]): Promise<void> {
    await ctx.onBlockStatus(block.id, next, ids);
    setStatus(next);
    setEntryIds(ids ?? []);
  }

  async function runCommit(work: () => Promise<LogDraftCommit>): Promise<void> {
    if (claimed.current) return;
    claimed.current = true;
    setBusy(true);
    setError(null);
    try {
      const committed = completedCommit.current ?? await work();
      completedCommit.current = committed;
      setSummary(committed.summary);
      setSaved(committed.saved ?? null);
      try {
        await update("committed", committed.entryIds);
      } catch {
        setError("Logged, but the card status did not save. Tap Log it to retry.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save. Try again.");
    } finally {
      claimed.current = false;
      setBusy(false);
    }
  }

  /** A commit in flight owns the card: the entry lands either way, so a Dismiss must not hide it. */
  function dismiss(): void {
    if (claimed.current) return;
    void update("dismissed").catch(() => setError("That card status did not save. Try again."));
  }

  async function undo(): Promise<void> {
    if (claimed.current) return;
    claimed.current = true;
    setBusy(true);
    setError(null);
    try {
      const remove = ctx.deleteEntry ?? forgetLoggedEntry;
      await Promise.all(entryIds.map((entryId) => remove(block.localDate, entryId)));
      await update("dismissed");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That could not be undone.");
    } finally {
      claimed.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="shell rounded-2xl!">
      <div className="surface flex flex-col gap-3 rounded-2xl!" style={{ padding: 14 }}>
        {/* One AI label per draft: a capture read is a model's; a barcode match is the app's and
            carries none. A legacy block with no provenance shows none either. */}
        {status !== "dismissed" && <AiLabel className="self-start"
          provenance={block.provenance ?? block.draft.provenance} />}
        {status !== "dismissed" && block.source === "capture"
          && <PhotoPreview block={block} ctx={ctx} />}
        {status === "committed" && (
          <div className="flex flex-col gap-2">
            <p className="m-0 text-caption font-normal text-charcoal">
              {summary}
            </p>
            <p className={`m-0 ${META}`}>{saved ?? "Logged"}</p>
            <button type="button" disabled={busy} onClick={() => void undo()}
              className={`tap self-start px-1 disabled:opacity-40 ${LINK_CLASS}`} style={LINK}>Undo</button>
          </div>
        )}
        {status === "dismissed" && <p className={`m-0 ${META}`}>Dismissed</p>}
        {status === "pending" && block.policy.blocked && block.source === "barcode"
          && <BlockedDraft block={block} ctx={ctx} />}
        {status === "pending" && !block.policy.blocked && block.source === "barcode"
          && isBarcodeDraft(block.draft) && (
          <BarcodeDraftEditor
            draft={{ response: block.draft, slot: slotOf(block), saving: busy, error }}
            projection={projection}
            onCommit={(edits) => void runCommit(() =>
              ctx.commitBarcode
                ? ctx.commitBarcode(block, edits)
                : commitBarcode(block, edits, ctx.tz))}
            onSearchManually={() => { if (!claimed.current) ctx.onSearchManually(block); }}
            onDismiss={dismiss}
          />
        )}
        {status === "pending" && block.source === "capture"
          && isCaptureDraft(block.draft) && (
          <CaptureDraftEditor
            draft={{ proposal: block.draft, portions, revisions, alternativeRevisions,
              slot: slotOf(block), saving: busy, message: error,
              blockedItemIds: block.policy.blockedItemIds }}
            projection={projection}
            onCommit={(edits) => void runCommit(() =>
              ctx.commitCapture
                ? ctx.commitCapture(block, edits)
                : commitCapture(block, edits, ctx.tz))}
            onSearchManually={() => { if (!claimed.current) ctx.onSearchManually(block); }}
            onDismiss={dismiss}
            onRerunAsLabel={block.method === "photo" ? () => ctx.rerunAsLabel(block) : undefined}
          />
        )}
      </div>
    </div>
  );
}
