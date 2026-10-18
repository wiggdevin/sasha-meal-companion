"use client";

import { useEffect, useRef, useState } from "react";
import BarcodeScanSheet from "@/components/BarcodeScanSheet";
import CatalogSearch from "@/components/CatalogSearch";
import Sheet from "@/components/Sheet";
import Button from "@/components/ui/Button";
import { barcodeAttachment } from "@/components/coach/attachments/photo-barcode";
import type { AttachmentSendOptions } from "@/components/coach/attachments/useAttachmentTurn";
import type { CoachAttachment } from "@/lib/coach/attachments";
import type { BarcodeMatch, BarcodeResponse } from "@/lib/barcode/client";
import { loadStore } from "@/lib/store";

const ROW: React.CSSProperties = {
  minHeight: 44,
  background: "var(--grad-card)",
  boxShadow: "0 0 0 1px rgb(var(--ink-rgb) / 0.08), 0 2px 3px -1px rgba(0,0,0,0.12)",
};
const ROW_CLASS = "rounded-2xl";
const META = "text-tiny font-normal text-muted";
/** The coach could not take the scan (a reply still running, or the coach paused). */
export const SCAN_REFUSED_COPY = "The coach is still answering. Try again in a moment.";

export default function ScanAttachmentSheet({
  open, onClose, onAttachment, onSearchManually, now = () => new Date(), initialChoice = null,
}: {
  open: boolean;
  /** A barcode read from a photo that matched several products: start on "Which one?". */
  initialChoice?: BarcodeResponse | null;
  onClose: () => void;
  onAttachment: (attachment: CoachAttachment, optimisticText: string,
    opts?: AttachmentSendOptions) => void | Promise<boolean>;
  onSearchManually?: (description: string) => void;
  now?: () => Date;
}) {
  const [choice, setChoice] = useState<BarcodeResponse | null>(initialChoice);
  const [searching, setSearching] = useState(false);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState(false);
  const claimed = useRef(false);
  useEffect(() => {
    if (open) claimed.current = false;
  }, [open]);
  // A reopened sheet starts clean: no refusal line left from an earlier scan.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setSending(false); setRefused(false); }
  }
  if (!open) return null;

  /**
   * The sheet closes the moment the scan is in the chat, never after the whole reply: the chat
   * shows "Scanned …" and its own retry from there. A send the coach refuses before posting
   * anything keeps the sheet and says so, so it never sits on "Looking it up…" (UI audit
   * 2026-10-18 §6). Answers true when the scan was taken.
   */
  async function send(response: BarcodeResponse, match: BarcodeMatch): Promise<boolean> {
    if (claimed.current) return true;
    claimed.current = true;
    setSending(true);
    setRefused(false);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      setSending(false);
      setChoice(null);
      onClose();
    };
    const sent = await onAttachment(
      barcodeAttachment(response, match, now()), `Scanned ${match.description}`,
      { onDispatched: close },
    );
    if (sent === false && !closed) {
      claimed.current = false;
      setSending(false);
      setRefused(true);
      return false;
    }
    close();
    return true;
  }

  if (choice?.status === "not_found" && searching) {
    return <Sheet title="Search foods" subtitle="Find what is on the pack."
      onClose={() => setSearching(false)}>
      <CatalogSearch mine={loadStore().foods} autoFocus onPick={(row) => {
        onSearchManually?.(row.description);
        setSearching(false);
        setChoice(null);
        onClose();
      }} />
    </Sheet>;
  }

  if (choice?.status === "not_found") {
    return <Sheet title="Not in the database" subtitle="Search for it by what is on the pack."
      onClose={() => { setChoice(null); onClose(); }}>
      <div className="flex flex-col gap-3">
        <p className={`m-0 ${META}`}>We do not know this barcode yet.</p>
        <Button variant="secondary" block onClick={() => setSearching(true)}>Search manually</Button>
      </div>
    </Sheet>;
  }

  if (choice?.status === "ambiguous") {
    return <Sheet title="Which one?" subtitle="This barcode matches more than one product."
      onClose={() => { setChoice(null); onClose(); }}>
      <div className="flex flex-col gap-2" aria-busy={sending}>
        {choice.matches.map((match) => <button key={match.revisionId} type="button" disabled={sending}
          className={`tap flex w-full flex-col justify-center px-3.5 py-3 text-left disabled:opacity-40 ${ROW_CLASS}`}
          style={ROW} onClick={() => void send(choice, match)}>
          <span className="text-caption font-normal text-charcoal">{match.description}</span>
          {match.brand && <span className={META}>{match.brand}</span>}
        </button>)}
        {(sending || refused) && <p role="status" className={`m-0 px-1.5 ${META}`}>
          {sending ? "Sending…" : SCAN_REFUSED_COPY}
        </p>}
      </div>
    </Sheet>;
  }

  return <BarcodeScanSheet onClose={onClose} refusedCopy={SCAN_REFUSED_COPY} onResolved={(response) => {
    if (response.status === "resolved") return send(response, response.match);
    setChoice(response);
    return true;
  }} />;
}
