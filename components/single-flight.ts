"use client";
/**
 * Writes that must run once, whoever is still mounted (audit r4, 2026-10-04). A ref lock lives and
 * dies with its component: close a picker mid-save, open it again, and a second write goes out
 * while the first is still on the wire. These locks live at module level instead, keyed by what
 * the write is for (a recipe's day and slot, a hub action, a day's slot), and clear only when the
 * write settles. A component that mounts while one is up reads it through `useFlying` and stays
 * busy until it lands.
 */
import { useCallback, useSyncExternalStore } from "react";

const flights = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/**
 * What the last write under a key settled as (audit f2, finding 2): a flight's lock dies with
 * `fly`, but a picker that unmounted mid-flight and remounts after it lands has no other way to
 * learn the outcome. Keyed the same as the lock it rode on, this outlives the component too, so a
 * remounted caller can hydrate instead of showing a blank, re-enabled control over a write that
 * already happened.
 */
const outcomes = new Map<string, unknown>();

/** The result the write at `key` settled with, or undefined before any write has. */
export function flightOutcome<T>(key: string): T | undefined {
  return outcomes.get(key) as T | undefined;
}

/**
 * Records what the write at `key` settled as, for a later mount to hydrate from. Emits through
 * the same store `useFlying` subscribes to (audit g1 MAJOR): a picker that mounted while the
 * write was still in flight has nothing to read until the lock itself clears, so this outcome
 * must be visible by the time that happens, not only to a caller that reads it fresh on its own
 * next mount.
 */
export function setFlightOutcome(key: string, value: unknown): void {
  outcomes.set(key, value);
  emit();
}

/** Forgets the outcome at `key`, once it has been shown and acknowledged. */
export function clearFlightOutcome(key: string): void {
  outcomes.delete(key);
}

/** Forgets every outcome whose key starts with `prefix` (a whole picker or widget closing). */
export function clearFlightOutcomesUnder(prefix: string): void {
  for (const key of outcomes.keys()) if (key.startsWith(prefix)) outcomes.delete(key);
}

/** Whether a write with exactly this key is in flight. */
export function flying(key: string): boolean { return flights.has(key); }

/** Whether any write whose key starts with `prefix` is in flight. */
export function flyingUnder(prefix: string): boolean {
  for (const key of flights) if (key.startsWith(prefix)) return true;
  return false;
}

/**
 * Runs `work` and holds `key` until it settles. Returns null, and runs nothing, when that key is
 * already held. The key is taken before `work` starts, so two calls in one tick run it once.
 */
export function fly<T>(key: string, work: () => Promise<T>): Promise<T> | null {
  if (flights.has(key)) return null;
  flights.add(key);
  emit();
  return (async () => {
    try { return await work(); }
    finally { flights.delete(key); emit(); }
  })();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Re-renders while any write under `prefix` is in flight, and once more when it lands. */
export function useFlying(prefix: string | null): boolean {
  const read = useCallback(() => prefix !== null && flyingUnder(prefix), [prefix]);
  return useSyncExternalStore(subscribe, read, () => false);
}

/** Tests only: forget every lock and outcome. */
export function resetFlightsForTests(): void { flights.clear(); outcomes.clear(); emit(); }
