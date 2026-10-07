"use client";

import { useCallback, useEffect, useState } from "react";
import { awardByKey } from "@/components/today/care/awards";
import type { CareNote } from "@/components/today/care/CareNotes";
import { readCareMessages, readCareShop, type CareMessageRow, type CareShopSnapshot } from "@/components/today/care/care-api";

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

/**
 * A server message as a note the well can show, or null when the phone cannot draw it (an unknown
 * type, a payload missing what its type needs, an award the phone has no scene for). Today only
 * accolade messages are written by the server; the rest are ready for when they are.
 */
export function noteOf(message: CareMessageRow): CareNote | null {
  const p = (message.payload && typeof message.payload === "object" ? message.payload : {}) as Record<string, unknown>;
  const at = Date.parse(message.createdAt) || undefined;
  const id = message.id;
  switch (message.type) {
    case "accolade": {
      const award = text(p.key) ? awardByKey(p.key as string) : undefined;
      return award ? { id, type: "accolade", award, at } : null;
    }
    case "tip":
    case "shop": {
      const title = text(p.title); const body = text(p.text);
      return title && body ? { id, type: message.type, title, text: body, at } : null;
    }
    case "observation":
    case "system": {
      const body = text(p.text);
      return body ? { id, type: message.type, text: body, at } : null;
    }
    case "streak": {
      const body = text(p.text);
      const days = Array.isArray(p.days) && p.days.length === 7 && p.days.every((d) => typeof d === "boolean") ? p.days as boolean[] : null;
      return body && days ? { id, type: "streak", text: body, days, at } : null;
    }
    default:
      return null;
  }
}

export type CareData = {
  /** The shop and recent Seeds, null until read (or when the read failed). */
  shop: CareShopSnapshot | null;
  notes: CareNote[];
  /** Read the shop and Seeds again (after a change, or a change on another device). */
  refresh: () => void;
  setShop: (next: CareShopSnapshot) => void;
  /** Take a note off the well for this visit. */
  drop: (id: string) => void;
};

/**
 * Seeds, the shop and the message inbox for the open well (UI-NEEDS SPROUT-CARE, #5). Read when the
 * well opens on today, again on `refresh`; a failed read shows nothing extra (no Seeds chip, no
 * notes), never a guess. Nothing is read while closed.
 */
export function useCare(active: boolean): CareData {
  const [shop, setShop] = useState<CareShopSnapshot | null>(null);
  const [notes, setNotes] = useState<CareNote[]>([]);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!active) return;
    let live = true;
    // A failed read keeps what is on screen (an open shop never vanishes under a refresh); only a
    // fold forgets it (below), so a first read that fails still shows nothing.
    void readCareShop().then((answer) => { if (live && answer !== "failed") setShop(answer); });
    return () => { live = false; };
  }, [active, reads]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void readCareMessages().then((answer) => {
      if (!live) return;
      // A failed read shows no notes rather than the last visit's.
      setNotes(answer === "failed" ? [] : answer.map(noteOf).filter((note): note is CareNote => note !== null));
    });
    return () => { live = false; };
  }, [active]);
  // The well folded or left today: forget what it showed, so a reopening never shows an old balance
  // or note while the new read is out (or when it fails).
  useEffect(() => {
    if (!active) return;
    return () => { setShop(null); setNotes([]); };
  }, [active]);
  const refresh = useCallback(() => setReads((n) => n + 1), []);
  const drop = useCallback((id: string) => setNotes((list) => list.filter((note) => note.id !== id)), []);
  return { shop, notes, refresh, setShop, drop };
}
