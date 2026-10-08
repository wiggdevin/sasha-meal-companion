"use client";

/**
 * W12 pantry-from-a-photo (docs/specs/phase-18-open-world-foods.md §W12; CONTRACT W12 on the
 * coordination board). The flow: a photo (resized on-device by `PhotoCapture` before it ever
 * reaches this component) is uploaded, then read for ingredient names -- nothing is written yet
 * (acceptance 1). The names come back as an editable draft: every name can be renamed, given an
 * optional weight, removed, or added to by hand, before the user confirms. Only confirming writes
 * anything (acceptance 2); a blocked or unverified confirmed item is shown with its rule mark,
 * never hidden (acceptance 3), and an item that failed to save is listed by name and reason
 * rather than silently dropped -- the written items still land even when one did not.
 *
 * `PhotoPrivacyNotice` renders before the capture control every time this opens, never only once
 * (acceptance 8: present before capture, not a dismissible one-time notice).
 *
 * Pilot-only by construction: this mounts only where `ShoppingRoot` already does, which the
 * `recipeAccess.enabled` gate (components/FoodsTabs.tsx) keeps off-screen for every other
 * account -- the same shopping-pilot boundary the backend's `requireRecipeUser` enforces.
 */
import { useRef, useState } from "react";
import PhotoCapture from "@/components/PhotoCapture";
import PhotoPrivacyNotice from "@/components/ui/PhotoPrivacyNotice";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import RuleMark from "@/components/ui/RuleMark";
import { accountHandle } from "@/lib/device/account";
import {
  confirmPantryPhoto, draftPantryPhoto, uploadPantryPhoto, PantryPhotoError,
  type FailedPantryPhotoItem,
} from "@/lib/shopping/pantry-photo-client";
import type { PantryItem } from "@/lib/shopping/types";

type DraftItem = { id: string; name: string; grams: string };
type Phase = "closed" | "start" | "reading" | "draft" | "saving" | "done";

/** Matches the confirm route's own ceiling (app/api/pantry/photo/confirm/route.ts Body schema):
 *  1-40 items, each name 1-160 characters. Enforced here too so the draft never silently builds
 *  a batch the route would reject whole. */
const MAX_ITEMS = 40;
const MAX_NAME_LENGTH = 160;
/** The SAME route's `MAX_BYTES` (Followups #21: raised from 4 KB to 48 KB, item caps unchanged —
 *  see app/api/pantry/photo/confirm/route.ts). Checked against the real encoded body right before
 *  sending, rather than guessing a safe static per-field length that would either be wrong for
 *  some item count or needlessly strict for most. */
const CONFIRM_BODY_MAX_BYTES = 48 * 1024;

function toDraft(names: readonly string[]): DraftItem[] {
  return names.map((name) => ({ id: crypto.randomUUID(), name, grams: "" }));
}

/** Blank is "not confirmed" (null), same as never typing a weight at all. Text that doesn't parse
 *  as a number ("abc") is ALSO left as null rather than silently coerced to 0 -- 0 g reads on the
 *  pantry list as a known, confirmed zero quantity (ShoppingView.tsx: `confirmedGrams === null ?
 *  "quantity not confirmed" : ...`), which is not what someone who typed garbage meant. A negative
 *  number floors to 0 rather than being discarded, since it did parse. */
function parseGrams(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

export default function PantryPhotoCapture({ onConfirmed }: {
  /** The newly-written items (already rule-marked); the caller merges them into its own list. */
  onConfirmed: (items: PantryItem[]) => void;
}) {
  const [phase, setPhase] = useState<Phase>("closed");
  const [items, setItems] = useState<DraftItem[]>([]);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<FailedPantryPhotoItem[]>([]);
  const [written, setWritten] = useState<PantryItem[]>([]);
  /**
   * The exact payload the last confirm attempt sent, keyed with the request id it used. The
   * server derives each write's idempotency key from `requestId` + the item's position
   * (lib/server/pantry-photo.ts itemRequestId) so an EXACT retry (same id, same array) safely
   * no-ops into the rows already written -- but if the draft was edited since (a rename, a
   * removal, reordering, a new item), the SAME positions now hold different content, and reusing
   * that id could write the wrong item at an already-used position. A changed payload always
   * mints a fresh id, mirroring the same "a changed selection is a new intent" rule
   * components/coach/TasteChipsCard.tsx already uses for its own confirm (Sol BLOCK, verified).
   */
  const attempted = useRef<{ requestId: string; payload: string } | null>(null);

  function openFresh() {
    setPhase("start"); setItems([]); setNewName(""); setError(null); setFailed([]);
    setWritten([]); attempted.current = null;
  }

  async function onPhoto(photo: Blob) {
    setPhase("reading");
    setError(null);
    try {
      const h = accountHandle();
      const mediaPath = await uploadPantryPhoto(h, photo);
      const names = await draftPantryPhoto(h, mediaPath);
      setItems(toDraft(names.slice(0, MAX_ITEMS)));
      attempted.current = null;
      setPhase("draft");
    } catch (e) {
      setError(e instanceof PantryPhotoError ? e.message : "Couldn’t read that photo. Try again.");
      setPhase("start");
    }
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }
  function addItem() {
    const name = newName.trim().slice(0, MAX_NAME_LENGTH);
    if (!name || items.length >= MAX_ITEMS) return;
    setItems((prev) => [...prev, ...toDraft([name])]);
    setNewName("");
  }
  function updateName(id: string, name: string) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, name } : item)));
  }
  function updateGrams(id: string, grams: string) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, grams } : item)));
  }

  const keepable = items.filter((item) => item.name.trim().length > 0);

  async function onConfirm() {
    if (keepable.length === 0) return;
    const payload = keepable.map((item) => ({
      name: item.name.trim(),
      grams: parseGrams(item.grams),
    }));
    const payloadKey = JSON.stringify(payload);
    // Reuse the id only while it still names exactly this payload; any edit since the last
    // attempt is a fresh intent and gets a fresh id (see the `attempted` docblock above). A
    // UUID is always 36 characters, so the id picked below never changes this size check.
    const requestId = attempted.current?.payload === payloadKey
      ? attempted.current.requestId : crypto.randomUUID();
    const bodySize = new TextEncoder().encode(JSON.stringify({ requestId, items: payload })).length;
    if (bodySize > CONFIRM_BODY_MAX_BYTES) {
      setError("That’s too many items, or some names are too long. Remove a few and try again.");
      return;
    }
    attempted.current = { requestId, payload: payloadKey };
    setPhase("saving");
    setError(null);
    try {
      const h = accountHandle();
      const result = await confirmPantryPhoto(h, requestId, payload);
      setWritten(result.items);
      setFailed(result.failed);
      onConfirmed(result.items);
      setPhase("done");
    } catch (e) {
      setError(e instanceof PantryPhotoError ? e.message : "Couldn’t save those. Try again.");
      setPhase("draft");
    }
  }

  if (phase === "closed") {
    return <Button variant="tertiary" size="sm" onClick={openFresh}>Add from a photo</Button>;
  }

  return (
    <div className="flex flex-col gap-3 rounded-[16px] border border-hairline p-3">
      {/* Shown every time this opens, before the camera control -- never a one-time notice
          (acceptance 8). */}
      <PhotoPrivacyNotice />

      {phase === "start" && (
        <>
          <PhotoCapture label="Photograph your pantry" busy={false}
            onReady={(photo) => void onPhoto(photo)} />
          <Button variant="tertiary" size="sm" onClick={() => setPhase("closed")}>Cancel</Button>
        </>
      )}

      {phase === "reading" && (
        <p role="status" className="m-0 text-tiny text-muted">Reading what’s in the photo…</p>
      )}

      {(phase === "draft" || phase === "saving") && (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-caption font-medium text-charcoal">Is this right?</p>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {items.map((item, index) => (
              <li key={item.id} className="flex items-center gap-2">
                <input value={item.name} onChange={(event) => updateName(item.id, event.target.value)}
                  maxLength={MAX_NAME_LENGTH} aria-label={`Item ${index + 1} name`}
                  className="well min-h-11 flex-1 px-3 text-caption text-charcoal" />
                <input value={item.grams} onChange={(event) => updateGrams(item.id, event.target.value)}
                  inputMode="numeric" placeholder="g"
                  aria-label={`Item ${index + 1} weight in grams, optional`}
                  className="well min-h-11 w-16 px-2 text-caption text-charcoal" />
                <button type="button" aria-label={`Remove item ${index + 1}${item.name.trim() ? `, ${item.name.trim()}` : ""}`}
                  onClick={() => removeItem(item.id)}
                  className="tap flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted">
                  ×
                </button>
              </li>
            ))}
            {items.length === 0 && (
              <li className="text-tiny text-muted">Nothing recognised. Add what you have below.</li>
            )}
          </ul>
          {items.length >= MAX_ITEMS ? (
            <p className="m-0 text-tiny text-muted">Up to {MAX_ITEMS} items at a time.</p>
          ) : (
            <div className="flex items-center gap-2">
              <input value={newName} onChange={(event) => setNewName(event.target.value)}
                maxLength={MAX_NAME_LENGTH} placeholder="Add an item" aria-label="Add an item"
                className="well min-h-11 flex-1 px-3 text-caption text-charcoal"
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addItem(); } }} />
              <Button variant="tertiary" size="sm" onClick={addItem}>Add</Button>
            </div>
          )}
          <Button variant="primary" status={phase === "saving" ? "pending" : undefined}
            disabled={keepable.length === 0} onClick={() => void onConfirm()}>
            Confirm
          </Button>
        </div>
      )}

      {phase === "done" && (
        <div className="flex flex-col gap-2">
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-caption">
            {written.map((item) => (
              <li key={item.id} className="flex flex-col gap-0.5">
                <span>{item.name}</span>
                {/* Never hidden, even blocked or unverified (acceptance 3). */}
                <RuleMark mark={item.ruleMark} className="flex-wrap" />
              </li>
            ))}
          </ul>
          {failed.length > 0 && (
            <Notice tone="attention"
              title={`${failed.length} ${failed.length === 1 ? "item" : "items"} didn’t save`}>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-tiny">
                {failed.map((item) => (
                  <li key={item.name}>{item.name}: {item.message}</li>
                ))}
              </ul>
            </Notice>
          )}
          <Button variant="tertiary" size="sm" onClick={() => setPhase("closed")}>Done</Button>
        </div>
      )}

      {error && <Notice tone="error" title={error} />}
    </div>
  );
}
