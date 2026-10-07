"use client";
/**
 * The Plan panel's photo state: the uploaded photo (kept, so "Not right?" re-reads it without a
 * second upload), the plate or menu result on show, and the one log in flight. Every log goes
 * through lib/plan/photo-log.ts, the app's capture pipeline, filed under this slot. A caller whose
 * slot moves with the clock (the recipe widget) passes `where`, read again at the tap, so a log
 * files under the meal of that moment rather than the one of the last render.
 *
 * A log is made as the account `h` it was tapped as, and its result is believed only while `h` is
 * still the bound account (audit r4): a log that lands after a switch reports neither "Logged." nor
 * an error to the account now on screen; it calls `onAccountChanged` instead.
 *
 * `read` makes the same promise for a plate/menu/ingredients read (audit f2 MAJOR): whatever the
 * upload or the read itself throws, if the account is no longer `h` by the time it settles this
 * re-throws as `AccountChanged`, so a caller's catch never mistakes a stale-account failure for an
 * ordinary one and misses the "Account changed" copy.
 *
 * The Plan panel checks before it logs (2026-10-04, AI audit B3): `reviewPlate`, `reviewPick` and
 * `reviewText` only propose, and hold the capture's draft in `review` for the card to show in the
 * capture editor; `confirm` commits it with the person's edits; `cancelReview` drops it. Nothing is
 * logged before `confirm`. The recipe hub uses the same review (2026-10-04); `logPlate`, `logPick`
 * and `logText` remain only for callers that already showed what they log.
 */
import { useRef, useState } from "react";
import { AccountChanged, assertCurrent, isCurrent, type AccountHandle } from "@/lib/device/account";
import { readPlanPhoto, uploadPlanPhoto, type UploadedPhoto } from "@/lib/plan/inspire-client";
import type { InspireResult, PhotoRead } from "@/lib/plan/inspire-types";
import {
  commitPanelDraft, logDescribed, logPlatePhoto, proposeDescribed, proposePlate,
  type PanelDraft, type PanelLogResult, type PanelProposal,
} from "@/lib/plan/photo-log";
import type { DraftEdits } from "@/lib/capture-client";
import type { MenuPick } from "@/lib/plan/photo-result";
import type { SlotId } from "@/lib/types";

export type PhotoSource = { file: Blob; as?: PhotoRead } | { as: PhotoRead };

/** Where a log from here files, and the calorie target a read sizes to. */
export type PhotoWhere = { slot: SlotId; date: string; time: string; targetKcal: number | undefined };

export function usePlanPhoto({ slot, date, time, targetKcal, where, onLogged, onError, onAccountChanged }: PhotoWhere & {
  /** Read at each call instead of the values above, when the slot can change while open. */
  where?: () => PhotoWhere;
  onLogged: (filedDate: string) => void; onError: (message: string | null) => void;
  onAccountChanged: () => void;
}) {
  const [photo, setPhoto] = useState<UploadedPhoto | null>(null);
  const [shown, setShown] = useState<InspireResult | null>(null);
  const [logging, setLogging] = useState<string | null>(null);
  const [review, setReview] = useState<PanelDraft | null>(null);
  const loggingRef = useRef(false);
  const now = (): PhotoWhere => where?.() ?? { slot, date, time, targetKcal };

  /**
   * Upload a new photo, or re-read the one already uploaded another way. Normalizes any failure
   * that lands once the account has moved on to `AccountChanged`, even one the upload or read
   * call itself reported as something else (audit f2 MAJOR): a caller's catch only has to handle
   * one case for "this isn't `h`'s any more."
   */
  async function read(h: AccountHandle, source: PhotoSource): Promise<InspireResult | null> {
    try {
      const uploaded = "file" in source ? await uploadPlanPhoto(h, source.file) : photo;
      if (!uploaded) return null;
      assertCurrent(h);
      if ("file" in source) { setPhoto(uploaded); setShown(null); }
      const at = now();
      const result = await readPlanPhoto(h, uploaded.mediaPath, at.date, { as: source.as, targetKcal: at.targetKcal });
      assertCurrent(h);
      return result;
    } catch (caught) {
      if (caught instanceof AccountChanged || !isCurrent(h)) throw new AccountChanged();
      throw caught;
    }
  }

  async function log(h: AccountHandle, key: string, run: () => Promise<PanelLogResult>) {
    if (loggingRef.current) return;
    loggingRef.current = true;
    setLogging(key);
    onError(null);
    try {
      assertCurrent(h);
      const out = await run();
      if (!isCurrent(h)) { onAccountChanged(); return; }
      if (out.ok) onLogged(out.date);
      else onError(out.message);
    } catch (caught) {
      if (caught instanceof AccountChanged || !isCurrent(h)) { onAccountChanged(); return; }
      onError("That didn’t log. Check your connection and try again.");
    } finally {
      loggingRef.current = false;
      setLogging(null);
    }
  }

  /** Propose only: the draft waits in `review` until the person confirms it. */
  async function propose(h: AccountHandle, key: string, run: () => Promise<PanelProposal>) {
    if (loggingRef.current) return;
    loggingRef.current = true;
    setLogging(key);
    onError(null);
    try {
      assertCurrent(h);
      const out = await run();
      if (!isCurrent(h)) { onAccountChanged(); return; }
      if (out.ok) setReview(out.pending);
      else onError(out.message);
    } catch (caught) {
      if (caught instanceof AccountChanged || !isCurrent(h)) { onAccountChanged(); return; }
      onError("That didn’t go through. Check your connection and try again.");
    } finally {
      loggingRef.current = false;
      setLogging(null);
    }
  }

  /** Commit the draft on show, with the editor's edits. The result is the caller's to confirm
   *  ("Logged") before it reports `onLogged`; null when nothing was sent or the account moved on. */
  async function confirm(h: AccountHandle, edits: DraftEdits): Promise<PanelLogResult | null> {
    const pending = review;
    if (!pending || loggingRef.current) return null;
    loggingRef.current = true;
    setLogging("review");
    onError(null);
    try {
      assertCurrent(h);
      const out = await commitPanelDraft(h, pending, edits);
      if (!isCurrent(h)) { onAccountChanged(); return null; }
      return out;
    } catch (caught) {
      if (caught instanceof AccountChanged || !isCurrent(h)) { onAccountChanged(); return null; }
      return { ok: false, message: "That didn’t log. Check your connection and try again." };
    } finally {
      loggingRef.current = false;
      setLogging(null);
    }
  }

  return {
    photo, shown, setShown, logging, read, review, confirm,
    cancelReview: () => setReview(null),
    reviewPlate: (h: AccountHandle, factor: number) => {
      const current = photo;
      if (current) void propose(h, "plate", () => {
        const at = now();
        return proposePlate(h, current.image, at.slot, factor, { date: at.date, time: at.time });
      });
    },
    reviewPick: (h: AccountHandle, pick: MenuPick) => void propose(h, pick.name, () => {
      const at = now();
      return proposeDescribed(h, pick.name, at.slot, { date: at.date, time: at.time });
    }),
    reviewText: (h: AccountHandle, text: string) => propose(h, "text", () => {
      const at = now();
      return proposeDescribed(h, text, at.slot, { date: at.date, time: at.time });
    }),
    /** Drop the kept photo: a result from an uploaded document has no photo to re-read. */
    forget: () => setPhoto(null),
    busy: () => loggingRef.current,
    logPlate: (h: AccountHandle, factor: number) => {
      const current = photo;
      if (current) void log(h, "plate", () => {
        const at = now();
        return logPlatePhoto(h, current.image, at.slot, factor, { date: at.date, time: at.time });
      });
    },
    logPick: (h: AccountHandle, pick: MenuPick) => void log(h, pick.name, () => {
      const at = now();
      return logDescribed(h, pick.name, at.slot, { date: at.date, time: at.time });
    }),
    logText: (h: AccountHandle, text: string) => log(h, "text", () => {
      const at = now();
      return logDescribed(h, text, at.slot, { date: at.date, time: at.time });
    }),
  };
}
