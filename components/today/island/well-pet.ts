"use client";

import { useSyncExternalStore } from "react";
import { MASCOTS, mascotOf, type MascotKey } from "@/components/today/island/mascots";
import { loadStore } from "@/lib/store";
import { SYNCED_EVENT } from "@/lib/sync/client";
import { PET_ART, petState, type PetDay, type PetMood, type PetState, type PetWhen } from "@/lib/today/pet-mood";

/**
 * The well's pet for the chosen companion (owner, 2026-10-07: "Choose a mascot"; Settings.mascot,
 * CONTRACT MASCOT #8). Its mood and lines come from petState with the companion's name; before the
 * clock is read it is simply here, and when the day's log grows it cheers.
 */
export function wellPet(day: PetDay, hour: number | null, when: PetWhen, cheer: boolean, mascot: MascotKey): PetState {
  const name = MASCOTS[mascot].name;
  const base: PetState = hour === null ? { mood: "content", vitality: null, line: `${name} is here with you.` }
    : petState(day, hour, when, mascot);
  // A meal going in on the viewed day: the companion cheers for a moment (owner, 2026-10-06).
  return cheer ? { ...base, mood: "joyful", line: `${name} cheers: today's log grew.` } : base;
}

/** The companion's art for a mood in the well: Sprout keeps its own well art; the others their hero art. */
export const wellArt = (mascot: MascotKey, mood: PetMood): string =>
  mascot === "sprout" ? PET_ART[mood] : MASCOTS[mascot].art[mood];

/** Fired after the companion is changed on this phone (Settings), so an open well redraws at once. */
export const MASCOT_EVENT = "companion-changed";

// The settings live in a JSON blob that loadStore parses on every call: read once, and again only
// after a sync pass, a local change, or a new subscriber (a well that just opened).
let cached: MascotKey | null = null;
const snapshot = (): MascotKey => (cached ??= mascotOf(loadStore().settings.mascot).key);
function subscribe(onChange: () => void): () => void {
  cached = null;
  const fresh = () => { cached = null; onChange(); };
  window.addEventListener(SYNCED_EVENT, fresh);
  window.addEventListener(MASCOT_EVENT, fresh);
  return () => { window.removeEventListener(SYNCED_EVENT, fresh); window.removeEventListener(MASCOT_EVENT, fresh); };
}

/** The chosen companion: Sprout on the server render, the phone's own choice once mounted. */
export function useMascot(): MascotKey {
  return useSyncExternalStore(subscribe, snapshot, () => "sprout");
}
