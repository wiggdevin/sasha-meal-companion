"use client";

import { useEffect, useRef, useState } from "react";
import BarcodeScanSheet from "@/components/BarcodeScanSheet";
import CatalogSearch from "@/components/CatalogSearch";
import Sheet from "@/components/Sheet";
import Button from "@/components/ui/Button";
import { barcodeAttachment } from "@/components/coach/attachments/photo-barcode";
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

export default function ScanAttachmentSheet({
  open, onClose, onAttachment, onSearchManually, now = () => new Date(), initialChoice = null,
}: {
  open: boolean;
  /** A barcode read from a photo that matched several products: start on "Which one?". */
  initialChoice?: BarcodeResponse | null;
  onClose: () => void;
  onAttachment: (attachment: CoachAttachment, optimisticText: string) => void | Promise<boolean>;
  onSearchManually?: (description: string) => void;
  now?: () => Date;
}) {
  const [choice, setChoice] = useState<BarcodeResponse | null>(initialChoice);
  const [searching, setSearching] = useState(false);
  const claimed = useRef(false);
  useEffect(() => {
    if (open) claimed.current = false;
  }, [open]);
  if (!open) return null;

  async function send(response: BarcodeResponse, match: BarcodeMatch): Promise<void> {
    if (claimed.current) return;
    claimed.current = true;
    const sent = await onAttachment(
      barcodeAttachment(response, match, now()), `Scanned ${match.description}`,
    );
    if (sent === false) {
      claimed.current = false;
      return;
    }
    setChoice(null);
    onClose();
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
      <div className="flex flex-col gap-2">
        {choice.matches.map((match) => <button key={match.revisionId} type="button"
          className={`tap flex w-full flex-col justify-center px-3.5 py-3 text-left ${ROW_CLASS}`} style={ROW}
          onClick={() => void send(choice, match)}>
          <span className="text-caption font-normal text-charcoal">{match.description}</span>
          {match.brand && <span className={META}>{match.brand}</span>}
        </button>)}
      </div>
    </Sheet>;
  }

  return <BarcodeScanSheet onClose={onClose} onResolved={(response) => {
    if (response.status === "resolved") void send(response, response.match);
    else setChoice(response);
  }} />;
}
