"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import Disclosure from "@/components/ui/Disclosure";
import ShoppingControls from "@/components/ShoppingControls";
import BuildListSlot from "@/components/shopping/BuildListSlot";
import PickList from "@/components/shopping/PickList";
import type { ShoppingLinePatch } from "@/components/ShoppingLineCard";
import ShoppingList from "@/components/ShoppingList";
import ShoppingPreview, { type ShoppingPreviewData } from "@/components/ShoppingPreview";
import ShoppingIngredientPicker from "@/components/ShoppingIngredientPicker";
import PantryPhotoCapture from "@/components/PantryPhotoCapture";
import ShoppingPurchaseWindowCard, { type PurchaseWindowPatch } from "@/components/ShoppingPurchaseWindowCard";
import { identityKey } from "@/lib/shopping/aggregate";
import type { ShoppingDraft, ShoppingPreviewInput } from "@/lib/shopping/contracts";
import type { IngredientIdentity, PantryItem, ShoppingLine, ShoppingPeriod,
  ShoppingPurchaseWindow } from "@/lib/shopping/types";
import Notice from "@/components/ui/Notice";
import RuleMark from "@/components/ui/RuleMark";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import { currentWindowChecked, localToday, shoppingDate, shoppingRange } from "@/lib/shopping/labels";

// The preview input lives in lib/shopping/contracts; kept here for importers.
export type { ShoppingPreviewInput };
export type ShoppingViewActions = {
  preview: (input: ShoppingPreviewInput) => Promise<ShoppingPreviewData>;
  /** Answers the saved line when it can (a queued tick is sent on its revision). */
  patchLine: (line: ShoppingLine, patch: ShoppingLinePatch) => Promise<ShoppingLine | void>;
  patchWindow?: (window: ShoppingPurchaseWindow, patch: PurchaseWindowPatch) => Promise<void>;
  confirmPantry: (line: ShoppingLine, grams: number) => Promise<void>;
  /** Adds typed or Favorite items, starting this week's list first when there is none. */
  addItems: (names: string[]) => Promise<void>;
  removeLine: (line: ShoppingLine) => Promise<void>;
  removePantry?: (item: PantryItem) => Promise<void>;
  refresh: () => Promise<void>;
};

function daysBetween(start: string, end: string): number {
  return Math.round((new Date(`${end}T12:00:00Z`).getTime() - new Date(`${start}T12:00:00Z`).getTime()) / 86400000);
}
function weekIndex(start: string, date: string): number {
  return Math.max(0, Math.floor(daysBetween(start, date) / 7));
}
function dateRange(period: ShoppingPeriod): string {
  return shoppingRange(period.startDate, period.endDate);
}
/** Brings a result the user is waiting on into view and gives it focus (it can render far below). */
function reveal(element: HTMLElement | null) {
  if (!element) return;
  element.scrollIntoView?.({ block: "start", behavior: "smooth" });
  element.focus({ preventScroll: true });
}

export default function ShoppingView({ period, lines, pantry = [], initialDraft, actions,
  purchaseWindows = [], invalidateRevision = 0, onDraftChange,
  storeNotes = "", onStoreNotesChange, switcher, emptyList, planNotice, heading = true, buildSlot,
  onPantryPhoto }: {
  period: ShoppingPeriod | null; lines: ShoppingLine[]; pantry?: PantryItem[]; initialDraft: ShoppingDraft;
  purchaseWindows?: ShoppingPurchaseWindow[];
  actions: ShoppingViewActions; invalidateRevision?: number;
  onDraftChange?: (draft: ShoppingDraft) => void;
  storeNotes?: string; onStoreNotesChange?: (value: string) => void;
  switcher?: ReactNode;
  /** False when the page around it already says "Shopping" (ShoppingRoot). */
  heading?: boolean;
  /** "Have AI build my list"; ShoppingRoot mounts it itself (null here) so it outlives a list switch. */
  buildSlot?: ReactNode;
  emptyList?: ReactNode;
  /** Shown first in the planner: the food-rule review that a plan needs before it can preview. */
  planNotice?: ReactNode;
  /** W12: pantry from a photo. Omitted: the capture entry point does not render (older callers
   *  unaffected). Present: the caller owns merging the newly-confirmed items into `pantry`. */
  onPantryPhoto?: (items: PantryItem[]) => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [prepared, setPrepared] = useState<{ revision: number; data: ShoppingPreviewData } | null>(null);
  const preview = prepared?.revision === invalidateRevision ? prepared.data : null;
  const setPreview = (next: ShoppingPreviewData | null) => setPrepared(next
    ? { revision: invalidateRevision, data: next } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Pantry rows being removed: each X waits on its own delete, apart from the preview. */
  const [removing, setRemoving] = useState<Set<string>>(() => new Set());
  const [pantryError, setPantryError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  /** Set when a preview run ends, so its card or error is brought into view once it renders. */
  const [revealSerial, setRevealSerial] = useState(0);
  const feedback = useActionFeedback();
  useEffect(() => { if (revealSerial) reveal(resultRef.current); }, [revealSerial]);
  /** Set when a plan is accepted: the list is where to look, with any refresh notice just above it. */
  const [acceptedSerial, setAcceptedSerial] = useState(0);
  useEffect(() => {
    if (!acceptedSerial || !topRef.current) return;
    const notice = topRef.current.previousElementSibling;
    reveal(notice instanceof HTMLElement && notice.matches("[data-tone=error]") ? notice : topRef.current);
  }, [acceptedSerial]);
  const [basket, setBasket] = useState<IngredientIdentity[]>(() => lines.flatMap((line) => line.identity ? [line.identity] : []));
  const basketSource = useRef({ periodId: period?.id ?? null, revision: period?.revision ?? null,
    lineIds: new Set(lines.filter((line) => line.identity).map((line) => line.id)) });
  useEffect(() => {
    const current = basketSource.current;
    const lineIds = new Set(lines.filter((line) => line.identity).map((line) => line.id));
    const replanned = current.periodId !== (period?.id ?? null) || current.revision !== (period?.revision ?? null)
      || [...lineIds].some((id) => !current.lineIds.has(id));
    basketSource.current = { periodId: period?.id ?? null, revision: period?.revision ?? null, lineIds };
    if (replanned) { setBasket(lines.flatMap((line) => line.identity ? [line.identity] : [])); setPrepared(null); }
  }, [period?.id, period?.revision, lines]);
  const selectedKeys = new Set(basket.map(identityKey));
  const monthly = period !== null && daysBetween(period.startDate, period.endDate) >= 27;
  const windows = monthly ? [...new Set(lines.filter((line) => line.origin === "plan")
    .flatMap((line) => line.sources.map((source) => weekIndex(period.startDate, source.localDate))))]
    .sort((a, b) => a - b) : [0];
  async function prepare() {
    setPreview(null);
    setBusy(true); setError(null);
    try { setPreview(await actions.preview({ draft, basket })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Shopping could not update. Try again."); }
    finally { setBusy(false); setRevealSerial((value) => value + 1); }
  }
  async function removePantry(item: PantryItem) {
    if (!actions.removePantry || removing.has(item.id)) return;
    setRemoving((current) => new Set(current).add(item.id)); setPantryError(null);
    try { await actions.removePantry(item); }
    catch (cause) { setPantryError(cause instanceof Error ? cause.message : `${item.name} was not removed. Try again.`); }
    finally { setRemoving((current) => { const next = new Set(current); next.delete(item.id); return next; }); }
  }
  const today = localToday();
  const planLines = lines.filter((line) => line.origin === "plan");
  const windowed = monthly && purchaseWindows.length > 0;
  return <div ref={topRef} className="flex flex-col gap-4" aria-label="Shopping">
    {heading && <h1 className="m-0 text-xl font-semibold">Shopping</h1>}
    {buildSlot === undefined ? <BuildListSlot periodId={period?.id ?? null} /> : buildSlot}
    {switcher}
    <ShoppingList title={period ? dateRange(period) : "This week"} lines={lines}
      empty={emptyList} showChecks={!windowed}
      weekChecked={(line) => currentWindowChecked(line.id, purchaseWindows, today)}
      selectedKeys={(line) => line.identity ? selectedKeys.has(identityKey(line.identity)) : false}
      onSelectedChange={(line, selected) => {
        if (!line.identity) return;
        const key = identityKey(line.identity);
        setBasket((current) => selected ? [...current.filter((item) => identityKey(item) !== key), line.identity!]
          : current.filter((item) => identityKey(item) !== key)); setPreview(null);
      }}
      actions={{
        setChecked: (line, checked) => actions.patchLine(line, { checked }),
        removeLine: async (line) => { await actions.removeLine(line); setPreview(null); },
        patchLine: async (line, patch) => { await actions.patchLine(line, patch); setPreview(null); },
        confirmPantry: async (line, grams) => { await actions.confirmPantry(line, grams); setPreview(null); },
      }} />
    {monthly && period && windowed && [...new Set(purchaseWindows.map((row) => row.windowStartDate))]
      .sort().map((start, index) => <section key={start} className="flex flex-col gap-2" aria-label={`Week ${index + 1}`}>
        <h3 className="m-0 text-base font-semibold">Week {index + 1} · {shoppingDate(start)}</h3>
        {purchaseWindows.filter((row) => row.windowStartDate === start).map((row) => {
          const line = lines.find((item) => item.id === row.lineId);
          return line && actions.patchWindow ? <ShoppingPurchaseWindowCard key={row.id}
            window={row} line={line} onPatch={actions.patchWindow} /> : null;
        })}
      </section>)}
    {monthly && period && !windowed && windows.map((index) => <section key={index} className="flex flex-col gap-2" aria-label={`Week ${index + 1}`}>
      <h3 className="m-0 text-base font-semibold">Week {index + 1}</h3>
      <ul className="m-0 list-disc pl-5 text-sm">{planLines.flatMap((line) => {
        const sources = line.sources.filter((source) => weekIndex(period.startDate, source.localDate) === index);
        if (!sources.length) return [];
        const known = sources.every((source) => source.requiredGrams !== null);
        const grams = known ? sources.reduce((sum, source) => sum + (source.requiredGrams ?? 0), 0) : null;
        return [<li key={line.id}>{line.name}: {grams === null ? "amount unknown" : `${Math.round(grams)} g needed`}
          {line.ruleMark && <> <RuleMark mark={line.ruleMark} variant="tag" className="align-middle" /></>}</li>];
      })}</ul>
    </section>)}
    {monthly && period && <p className="ground-muted m-0 text-sm">{windowed
      ? "Tick plan items off week by week above; the list covers the full period."
      : "Buy amounts and ticks cover the whole month. Week-by-week amounts aren't ready yet."}</p>}
    <section className="shell" aria-label="Pick from your foods"><div className="surface flex flex-col gap-3 p-4">
      <h2 className="m-0 text-lg font-semibold">Pick from your foods</h2>
      <PickList lines={lines}
        onAdd={async (names) => { await actions.addItems(names); setPreview(null); }}
        onRemove={async (line) => { await actions.removeLine(line); setPreview(null); }} />
    </div></section>
    <Disclosure title="More options"
      count={planLines.length ? `${planLines.length} from your plan` : undefined}>
      <div className="flex flex-col gap-4">
        {planNotice}
        <p className="ground-muted m-0 text-sm">Plan meals for a period: the planner picks recipes, adds up what they need,
          and leaves out what you already have. Nearby store search is in Have AI build my list.</p>
        <ShoppingControls storeNotes={storeNotes} onStoreNotesChange={onStoreNotesChange}
          draft={draft} onChange={(next) => { onDraftChange?.(next); setDraft(next); setPreview(null); }}
          onPreview={() => void prepare()} busy={busy} />
        <ShoppingIngredientPicker lines={lines} pantry={pantry} selected={basket}
          onChange={(next) => { setBasket(next); setPreview(null); }} />
      </div>
    </Disclosure>
    <div ref={resultRef} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      {preview && <ShoppingPreview current={lines}
        basket={basket}
        confirmedPantry={pantry.filter((item) => item.confirmedGrams !== null && item.confirmedGrams > 0)
          .map((item) => item.identity)}
        preview={preview} onCancel={() => setPreview(null)}
        onAccepted={() => {
          setPreview(null);
          // The card goes; the updated list (and any refresh notice above it) is where to look.
          feedback.notify({ tone: "success", message: "Plan accepted." });
          setAcceptedSerial((value) => value + 1);
        }} />}
      {error && <Notice tone="error" title={error} />}
    </div>
    <Disclosure title="Have already" count={pantry.length || undefined}>
      {pantry.length === 0 && <p className="ground-muted m-0 text-sm">Nothing in your pantry yet.</p>}
      {pantry.length > 0 && <ul className="m-0 flex list-none flex-col p-0 text-sm">{pantry.map((item) => <li key={item.id}
        className="flex min-h-11 items-center justify-between gap-2">
        <span className="flex min-w-0 flex-col gap-1 py-1">
          <span>{item.name} · {item.confirmedGrams === null ? "quantity not confirmed" : `${item.confirmedGrams} g`}</span>
          <RuleMark mark={item.ruleMark} className="flex-wrap" /></span>
        {actions.removePantry && <button type="button" aria-label={`Remove ${item.name} from Have already`}
          disabled={removing.has(item.id)} aria-busy={removing.has(item.id) || undefined}
          onClick={() => void removePantry(item)}
          className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted"><X size={16} aria-hidden="true" /></button>}
      </li>)}</ul>}
      {pantryError && <Notice tone="error" title={pantryError} />}
      {/* The disclosure body stays mounted while closed, so the capture keeps its state across
          the confirm that changes pantry.length (via onPantryPhoto -> the caller's setPantry). */}
      {onPantryPhoto && <PantryPhotoCapture onConfirmed={onPantryPhoto} />}
    </Disclosure>
    <p className="ground-muted m-0 text-sm">Store prices aren&apos;t available yet.</p>
    <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
  </div>;
}
