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
import { useState } from "react";
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

function toDraft(names: readonly string[]): DraftItem[] {
  return names.map((name) => ({ id: crypto.randomUUID(), name, grams: "" }));
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
  const [requestId, setRequestId] = useState<string | null>(null);

  function openFresh() {
    setPhase("start"); setItems([]); setNewName(""); setError(null); setFailed([]);
    setWritten([]); setRequestId(null);
  }

  async function onPhoto(photo: Blob) {
    setPhase("reading");
    setError(null);
    try {
      const h = accountHandle();
      const mediaPath = await uploadPantryPhoto(h, photo);
      const names = await draftPantryPhoto(h, mediaPath);
      setItems(toDraft(names));
      setRequestId(crypto.randomUUID());
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
    const name = newName.trim();
    if (!name) return;
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
    if (keepable.length === 0 || !requestId) return;
    setPhase("saving");
    setError(null);
    try {
      const h = accountHandle();
      const payload = keepable.map((item) => ({
        name: item.name.trim(),
        grams: item.grams.trim() === "" ? null : Math.max(0, Number(item.grams) || 0),
      }));
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
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-2">
                <input value={item.name} onChange={(event) => updateName(item.id, event.target.value)}
                  aria-label="Item name" className="well min-h-11 flex-1 px-3 text-caption text-charcoal" />
                <input value={item.grams} onChange={(event) => updateGrams(item.id, event.target.value)}
                  inputMode="numeric" placeholder="g"
                  aria-label={`${item.name.trim() || "Item"} weight in grams, optional`}
                  className="well min-h-11 w-16 px-2 text-caption text-charcoal" />
                <button type="button" aria-label={`Remove ${item.name.trim() || "item"}`}
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
          <div className="flex items-center gap-2">
            <input value={newName} onChange={(event) => setNewName(event.target.value)}
              placeholder="Add an item" aria-label="Add an item"
              className="well min-h-11 flex-1 px-3 text-caption text-charcoal"
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addItem(); } }} />
            <Button variant="tertiary" size="sm" onClick={addItem}>Add</Button>
          </div>
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
