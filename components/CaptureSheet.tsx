// components/CaptureSheet.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import CaptureConfirm from "@/components/CaptureConfirm";
import DictateMic, {
  dictationCopy, dictationStatus, MIC_UNAVAILABLE_COPY, useMicAvailable,
} from "@/components/DictateMic";
import type { DayProjection } from "@/components/ProjectedDayTotals";
import PhotoCapture, { type PhotoMeta } from "@/components/PhotoCapture";
import type { CaptureDetails, CaptureDetailsSpec } from "@/components/coach/editors/CaptureMealDetails";
import Sheet from "@/components/Sheet";
import VoiceCapture from "@/components/VoiceCapture";
import WorkingLine from "@/components/WorkingLine";
import Button from "@/components/ui/Button";
import PhotoPrivacyNotice from "@/components/ui/PhotoPrivacyNotice";
import {
  applyEdits, captureMedia, captureText, CAPTURE_LABELS, commitDraft, keptItems, slotForNow,
  type CaptureOutcome, type DraftEdits, type MediaMethod,
} from "@/lib/capture-client";
import { labelItemSeq } from "@/lib/capture/label-food";
import { captureRecipe } from "@/lib/capture/save-as-recipe";
import { uploadThumbnail } from "@/lib/capture/thumbnail";
import { atClock, clockIn, photoEatenAt, type PhotoTimes } from "@/lib/capture/shot-time";
import { saveRecipe } from "@/lib/recipes-client";
import {
  captureInputKey, clearDraft, draftForInput, draftSaveWarning, DUPLICATE_NO_DRAFT, saveDraft,
} from "@/lib/capture/drafts";
import { savedFrom, type SaveResult } from "@/lib/log/outcome";
import type { CaptureMethod } from "@/lib/capture/flags";
import type { HoldView } from "@/lib/coach/hold";
import type { ProposeResponse } from "@/lib/capture/types";
import { resolveDay } from "@/lib/resolve";
import { loadStore } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { LOG_QUEUED_EVENT } from "@/lib/log-commit-client";
import { discardRun, mark, type TimingRun, type TimingStep } from "@/lib/timing";
import type { SlotId } from "@/lib/types";

/** Capture is the one online-only surface in the app (spec §6), so everything that offers it needs
 *  the same answer to one question. Read in an effect, never during render. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const read = () => setOnline(navigator.onLine);
    read();
    window.addEventListener("online", read);
    window.addEventListener("offline", read);
    return () => {
      window.removeEventListener("online", read);
      window.removeEventListener("offline", read);
    };
  }, []);
  return online;
}

const SUBTITLE: Record<CaptureMethod, string> = {
  text: "Tap the mic and say what you ate, or type it.",
  voice: "Hold the button and say what you ate.",
  label: "Photograph the nutrition panel.",
  photo: "One photo of the whole plate.",
};

const EMPTY_DRAFT = (method: CaptureMethod): ProposeResponse => ({
  draftId: crypto.randomUUID(), method, items: [], notes: [], spend: { usedToday: 0, softCap: 0 },
});

export type CaptureSheetProps = {
  open: boolean;
  initialMode: CaptureMethod | "confirm";
  initialDraft?: ProposeResponse;
  projection?: DayProjection;
  onClose: () => void;
  onLogged: (entryId: string) => void;
  onOpenSearch: () => void;
  /** When the meal was eaten: the day on screen when that is not today (app/page.tsx), else now. */
  at?: Date;
  /** The meal card the capture came from, if any; else the slot for the time now. */
  slot?: SlotId;
};

// #4a4c42 is DESIGN.md text-secondary (line 13) — same token and 14 px size as CaptureConfirm.tsx's
// DraftItems empty-state note ("Nothing came back to check").
const MUTED_NOTE = "text-caption font-normal text-graphite";

// #4a4c42 is DESIGN.md text-secondary (line 13), at CaptureConfirm.tsx's 12 px status-line size
// (ConfirmFooter's save message).
const MUTED_STATUS = "text-tiny font-normal text-graphite";

/* Offline notice — spec §6 (capture is online-only): one line pointing at search, no pretending. */
function OfflineCapture({ onOpenSearch }: { onOpenSearch: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className={MUTED_NOTE}>Capture needs a connection. Search still works.</p>
      <Button variant="primary" size="lg" block onClick={onOpenSearch}>Search your foods</Button>
    </div>
  );
}

/**
 * Say it or type it (owner, 2026-09-30: "logging a meal should always have a voice dictation
 * ability"). The mic sits inside the box; dictation only fills the box, and "Check it" is still the
 * one way on, so the words are reviewed before the existing propose → confirm → commit path.
 */
function TextCapture({ text, onChangeText, busy, onSubmit }: {
  text: string;
  onChangeText: (value: string) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  const micReady = useMicAvailable();
  const [dictation, setDictation] = useState<HoldView | null>(null);
  const locked = dictation?.locked ?? false;
  const spoken = dictation ? dictationStatus(dictation) ?? dictationCopy(dictation.notice) : null;
  const line = spoken ?? (micReady ? null : MIC_UNAVAILABLE_COPY);
  return (
    <>
      <div className="relative">
        <label className="flex flex-col gap-1.5">
          <span className="pl-1.5 text-tiny font-normal text-graphite">What you ate</span>
          <textarea
            value={text}
            onChange={(event) => onChangeText(event.target.value)}
            readOnly={locked}
            rows={3}
            aria-label="What you ate"
            aria-describedby={line ? "capture-dictation-line" : undefined}
            placeholder={micReady ? "Tap the mic, or type: a turkey sandwich with cheese"
              : "two eggs, half an avocado, a bowl of white rice"}
            className="well tap w-full px-4 py-3 text-body font-medium text-charcoal outline-none placeholder:text-muted"
            // #2a2b25 is DESIGN.md text-primary (line 12). minHeight 96 gives that same
            // recipe room for three lines instead of one; the right padding keeps words off the mic.
            style={{ minHeight: 96, ...(micReady ? { paddingRight: 64 } : {}) }}
          />
        </label>
        {micReady && (
          <div className="absolute bottom-2 right-2">
            <DictateMic readBox={() => text} writeBox={onChangeText} disabled={busy}
              onView={setDictation} />
          </div>
        )}
      </div>
      {line && <p id="capture-dictation-line" role="status" className={MUTED_STATUS}>{line}</p>}
      {/* The sheet's one primary (lg). While the words are read its dots hold the label's width;
          WorkingLine names the hop after two seconds. */}
      <Button variant="primary" size="lg" block status={busy ? "pending" : undefined}
        disabled={locked || text.trim().length === 0} onClick={onSubmit}>
        Check it
      </Button>
    </>
  );
}

function CaptureBody({
  online, mode, text, onChangeText, busy, onSubmitText, onVoiceReady, onPhotoReady, onOpenSearch,
}: {
  online: boolean;
  mode: CaptureMethod;
  text: string;
  onChangeText: (value: string) => void;
  busy: boolean;
  onSubmitText: () => void;
  onVoiceReady: (clip: Blob) => void;
  onPhotoReady: (photo: Blob, meta: PhotoMeta) => void;
  onOpenSearch: () => void;
}) {
  if (!online) return <OfflineCapture onOpenSearch={onOpenSearch} />;
  if (mode === "text") {
    return <TextCapture text={text} onChangeText={onChangeText} busy={busy} onSubmit={onSubmitText} />;
  }
  if (mode === "voice") return <VoiceCapture busy={busy} onReady={onVoiceReady} />;
  return (
    <>
      <PhotoCapture busy={busy} label={mode === "label" ? "Scan the label" : "Photograph the plate"}
        withThumbnail={mode === "photo"} onReady={onPhotoReady} />
      {/* Phase 18 W12-F: present beside the control before any tap opens the camera, for both the
          plate photo and the nutrition-label photo (the notice is about medicines, prescriptions and
          labels WITH NAMES, so it does not conflict with this mode's own nutrition-panel purpose). */}
      <PhotoPrivacyNotice />
    </>
  );
}

/** When the capture was eaten: `at` (a past day on Today, lib/log/viewed-at.ts), else this instant.
 *  local_date must agree with eaten_at in this zone (lib/log/contract.ts). Its own hook so
 *  useCaptureFlow keeps room for the brief's settle() under the length budget. */
function useCaptureWhen(at?: Date): { localDate: string; tz: string; at?: Date } {
  const [when] = useState(() => ({
    localDate: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" })
      .format(at ?? new Date()),
    at,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }));
  return when;
}

/** Resolves the current slot once per mount, lazily, only from an event handler — contracts §5
 *  gives the sheet no slot prop, so it reads the current slot the same way Today does: the last
 *  slot whose time has arrived, else the first slot of the day, else meal-1 (slotForNow). Split
 *  out of useCaptureFlow so that hook's own line count stays under the file's function budget. */
function useSlotNow(localDate: string, fixed?: SlotId): () => SlotId {
  const slotRef = useRef<SlotId | null>(fixed ?? null);
  return () => {
    if (slotRef.current === null) {
      const now = new Date();
      slotRef.current = slotForNow(
        resolveDay(loadStore(), localDate).slots,
        now.getHours() * 60 + now.getMinutes(),
      );
    }
    return slotRef.current;
  };
}

/** What the confirm sheet adds to a save (W125): the meal's name and time, its kept thumbnail, and
 *  whether it is also kept as a recipe. */
type SaveExtras = { eatenAt?: Date; title?: string; thumbnailPath?: string | null; saveAsRecipe: boolean };

/** The commit call plus its status→copy mapping, pulled out for the same reason as useCaptureWhen
 *  and useSlotNow above: a short standalone function instead of more lines inside the hook, which
 *  keeps room there for the brief's settle() and run(). */
async function commitAndReport(
  draft: ProposeResponse, edits: DraftEdits, entryId: string, tz: string, slot: SlotId,
  saveLabelAsFood: boolean, extras: SaveExtras, run?: TimingRun,
): Promise<SaveResult> {
  const labelSeq = labelItemSeq(draft, edits, saveLabelAsFood);
  const result = await commitDraft(draft, edits, { entryId, tz, slot, saveLabelAsFood, run,
    eatenAt: extras.eatenAt, title: extras.title,
    ...(labelSeq !== null && extras.title ? { labelName: extras.title } : {}),
    thumbnailPath: extras.thumbnailPath ?? null });
  // One verdict, the same one the card and the log sheet read: a 2xx the client could not read,
  // and a conflict that hands back the entry, are both entries the user has — and a sheet that calls
  // either a failure sends them to Save again and puts a second meal in their log.
  const saved = savedFrom(result);
  if (saved.ok && extras.saveAsRecipe) {
    const kept = keptItems(applyEdits(draft.items, edits));
    const { input, left } = captureRecipe(kept, result, { title: extras.title, labelSeq });
    // Local first (lib/recipes-client.ts): the meal is logged either way, and a recipe that
    // could not be kept is said in the console, never as a failed save.
    if (input) await saveRecipe(input).catch((error: unknown) => {
      console.warn("[capture] save as recipe failed", error instanceof Error ? error.name : "unknown");
    });
    if (left.length > 0) console.info("[capture] recipe left out foods not cleared for its rules", left.length);
  }
  return saved;
}

/** The time a capture's meal starts at on the confirm sheet: the photo's, else the viewed day's. */
function detailsFor(draft: ProposeResponse, photoAt: Date | null, when: { at?: Date; tz: string }):
  CaptureDetailsSpec {
  const start = photoAt ?? when.at ?? null;
  const label = draft.method === "label" && draft.labelFood ? draft.labelFood.name : undefined;
  return {
    ...(label ? { defaultTitle: label, nameLabel: "Food name" } : {}),
    defaultClock: clockIn(start ?? new Date(), when.tz),
    clockSource: photoAt ? "photo" : when.at ? "slot" : "now",
  };
}

/**
 * Draft/message/busy/save state and the slot lookup, pulled out of the component body so the
 * default export stays under the file's function-length budget. `settle` and `run` are the
 * brief's, unchanged: `settle` closes over the method the hook derives from `initialMode` (the
 * same rule the component uses for `mode`), and `run` takes only the work.
 */
function useCaptureFlow(initialMode: CaptureMethod | "confirm", initialDraft: ProposeResponse | undefined,
  at?: Date, slot?: SlotId) {
  const method = initialMode === "confirm" ? "text" : initialMode;
  const [draft, setDraft] = useState<ProposeResponse | null>(
    initialMode === "confirm" ? (initialDraft ?? EMPTY_DRAFT("text")) : null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<TimingStep>("propose");
  const [saving, setSaving] = useState(false);
  /** The timing run this capture opened, held across the confirm step so the commit closes it. */
  const runRef = useRef<TimingRun | null>(null);
  /** The plate photo's shot times and its thumbnail's upload, from the moment it was taken (W125). */
  const photoRef = useRef<{ times: PhotoTimes; thumbnail: Promise<string | null> | null } | null>(null);
  const when = useCaptureWhen(at);
  const slotNow = useSlotNow(when.localDate, slot);

  function settle(outcome: CaptureOutcome, inputKey: string | null) {
    if (outcome.kind === "draft") {
      // Closes the propose hop and opens the one the user is actually looking at (T0 §1). The run the
      // capture opened is held so the commit closes THAT one, not whichever is latest on the path.
      mark(method, "confirm-shown", outcome.run);
      runRef.current = outcome.run ?? null;
      const saved = saveDraft(outcome.draft, undefined, undefined, inputKey ?? undefined);
      setDraft(outcome.draft);
      setMessage(draftSaveWarning(saved));
      return;
    }
    if (outcome.kind === "duplicate") {
      // A032: only this same input's draft, never another capture's; none means it was saved.
      const held = draftForInput(inputKey);
      if (held !== null) { setDraft(held); setMessage(outcome.message); return; }
      setMessage(DUPLICATE_NO_DRAFT);
      return;
    }
    if (outcome.kind === "empty") setDraft(EMPTY_DRAFT(method));
    setMessage(outcome.message);
  }

  async function run(work: Promise<CaptureOutcome>, inputKey: Promise<string | null>) {
    setBusy(true);
    try { settle(await work, await inputKey); } finally { setBusy(false); }
  }

  /** Remembers what the phone read off a photo, and starts its thumbnail's upload (W125). */
  function photoTaken(mode: MediaMethod, meta: PhotoMeta): void {
    photoRef.current = { times: meta.times,
      thumbnail: mode === "photo" && meta.thumbnail ? uploadThumbnail(meta.thumbnail) : null };
  }

  /** The photo's shot time on this capture's day, else null. */
  function photoAt(): Date | null {
    const times = photoRef.current?.times;
    return times ? photoEatenAt(times, { localDate: when.localDate, tz: when.tz, now: new Date() })?.at ?? null
      : null;
  }

  /** The verdict goes back to CaptureConfirm, whose shared feedback shows a refusal as an alert. */
  async function save(edits: DraftEdits, saveLabelAsFood: boolean,
    onLogged: (entryId: string) => void, details?: CaptureDetails): Promise<SaveResult | void> {
    if (draft === null) return;
    const entryId = crypto.randomUUID();
    setSaving(true);
    const edited = details?.clock ? atClock(when.localDate, details.clock, when.tz) : null;
    const thumbnailPath = draft.method === "photo" ? await (photoRef.current?.thumbnail ?? null) : null;
    const outcome = await commitAndReport(draft, edits, entryId, when.tz, slotNow(), saveLabelAsFood, {
      eatenAt: edited ?? photoAt() ?? when.at, title: details?.title.trim() || undefined,
      thumbnailPath, saveAsRecipe: details?.saveAsRecipe === true,
    }, runRef.current ?? undefined);
    setSaving(false);
    if (outcome.ok) {
      clearDraft(draft.draftId);
      onLogged(entryId);
    }
    return outcome;
  }

  /** Dismissed without saving: this capture's own run goes, not whichever is latest on the path. */
  function discard(): void { discardRun(method, runRef.current ?? undefined); }

  return { draft, message, busy, step, setStep, saving, when, slotNow, run, save, discard,
    photoTaken, photoAt };
}

/**
 * The one capture sheet — architecture §4.2. The mode never changes once it is open: the user chose it
 * on Today, and swapping mid-flow would throw away a clip the user just recorded. Offline it does not
 * pretend: one line and a way into the Phase 2 search, which logs with no signal.
 */
export default function CaptureSheet({
  open, initialMode, initialDraft, projection, onClose, onLogged, onOpenSearch, at, slot,
}: CaptureSheetProps): React.JSX.Element | null {
  const online = useOnline();
  const [text, setText] = useState("");
  const flow = useCaptureFlow(initialMode, initialDraft, at, slot);
  const [coachProjection, setCoachProjection] = useState<DayProjection | null>(null);
  useEffect(() => {
    if (!open || projection) return;
    const read = () => {
      const day = resolveDay(loadStore(), flow.when.localDate);
      setCoachProjection({ consumed: day.consumed, targets: day.targets });
    };
    read();
    window.addEventListener(SYNCED_EVENT, read);
    window.addEventListener(LOG_QUEUED_EVENT, read);
    window.addEventListener("focus", read);
    return () => {
      window.removeEventListener(SYNCED_EVENT, read);
      window.removeEventListener(LOG_QUEUED_EVENT, read);
      window.removeEventListener("focus", read);
    };
  }, [open, projection, flow.when.localDate]);

  if (!open) return null;

  if (flow.draft !== null) {
    const draft = flow.draft;
    return (
      <CaptureConfirm draft={draft} saving={flow.saving} message={flow.message}
        projection={projection ?? coachProjection ?? undefined}
        details={detailsFor(draft, flow.photoAt(), flow.when)}
        onSave={(edits, saveLabelAsFood, _slot, details) =>
          flow.save(edits, saveLabelAsFood, onLogged, details)}
        onDismiss={() => {
          // Dismissed without saving: nothing will close this run, and leaving it open would let
          // its marks land in whatever the user captures next (T0 §1).
          flow.discard();
          clearDraft(draft.draftId);
          onClose();
        }} />
    );
  }

  const mode = initialMode as CaptureMethod;

  return (
    <Sheet title={CAPTURE_LABELS[mode]} subtitle={SUBTITLE[mode]}
      onClose={() => { discardRun(mode); onClose(); }}>
      {/* pb-4: room inside the sheet's scrolling body for the primary's drop, which it would clip. */}
      <div className="flex flex-col gap-4 px-1 pb-4">
        <CaptureBody
          online={online}
          mode={mode}
          text={text}
          onChangeText={setText}
          busy={flow.busy}
          onSubmitText={() => {
            void flow.run(captureText(text,
              { ...flow.when, slot: flow.slotNow(), onStep: flow.setStep }),
            captureInputKey({ method: "text", text }));
          }}
          onVoiceReady={(clip) => {
            void flow.run(captureMedia("voice", clip,
              { ...flow.when, slot: flow.slotNow(), onStep: flow.setStep }),
            captureInputKey({ method: "voice", blob: clip }));
          }}
          onPhotoReady={(photo, meta) => {
            // CaptureBody only invokes this when mode is "label" or "photo" (never "text"), but
            // that runtime fact is not visible to TS at this closure's definition site.
            flow.photoTaken(mode as MediaMethod, meta);
            void flow.run(captureMedia(mode as MediaMethod, photo,
              { ...flow.when, slot: flow.slotNow(), onStep: flow.setStep }),
            captureInputKey({ method: mode, blob: photo }));
          }}
          onOpenSearch={onOpenSearch}
        />

        {/* T0 §2: after two seconds of any hop, say which hop it is. */}
        <WorkingLine active={flow.busy} step={flow.step} method={mode} />

        {flow.message !== null && (
          <p role="status" className={MUTED_STATUS}>{flow.message}</p>
        )}
      </div>
    </Sheet>
  );
}
