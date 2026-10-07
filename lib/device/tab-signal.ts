/**
 * Signals between tabs of this origin about the account (Phase 9 slice 1, reload boundary).
 *
 *  - `leaving`: a tab is signing this account out. Every other tab of the same account closes its
 *    gate at once and reloads once its own state is durable.
 *  - `handover`: a tab of this account asks the writer tab to give up the writer lock
 *    (lib/device/writer-lock.ts). The writer makes its state durable and reloads.
 *
 * Sent on a BroadcastChannel and, for browsers without one, as a `storage` event. A receiver can
 * see one signal twice (both carriers): each signal carries a nonce and is delivered once.
 */
export type TabSignal = { type: "leaving" | "handover"; userId: string };

const CHANNEL = "smc:device";
/** Device-level key (not account data): the last signal, for the `storage` event carrier. */
export const TAB_SIGNAL_KEY = "smc:device:signal";

type Envelope = TabSignal & { nonce: string; from: string };

function nonce(): string {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
}

/** This document. A BroadcastChannel also delivers to other channel objects of the sender's own
 *  document, so a signal names its sender and the sender ignores it. */
const SELF = nonce();

function channel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
}

function parse(value: unknown): Envelope | null {
  const v = (typeof value === "string" ? safeJson(value) : value) as Partial<Envelope> | null;
  if (!v || (v.type !== "leaving" && v.type !== "handover")) return null;
  if (typeof v.userId !== "string" || typeof v.nonce !== "string") return null;
  if (typeof v.from !== "string" || v.from === SELF) return null;
  return { type: v.type, userId: v.userId, nonce: v.nonce, from: v.from };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

export function announce(signal: TabSignal): void {
  const envelope: Envelope = { ...signal, nonce: nonce(), from: SELF };
  const ch = channel();
  if (ch) {
    try { ch.postMessage(envelope); } catch { /* the storage carrier still runs */ }
    ch.close();
  }
  try { localStorage.setItem(TAB_SIGNAL_KEY, JSON.stringify(envelope)); } catch { /* best effort */ }
}

/** Calls `fn` once per signal another tab sent. Returns the unsubscribe. */
export function onTabSignal(fn: (signal: TabSignal) => void): () => void {
  const seen = new Set<string>();
  const deliver = (value: unknown): void => {
    const envelope = parse(value);
    if (!envelope || seen.has(envelope.nonce)) return;
    seen.add(envelope.nonce);
    fn({ type: envelope.type, userId: envelope.userId });
  };
  const ch = channel();
  const onMessage = (event: MessageEvent): void => deliver(event.data);
  ch?.addEventListener("message", onMessage);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === TAB_SIGNAL_KEY && event.newValue) deliver(event.newValue);
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    ch?.removeEventListener("message", onMessage);
    ch?.close();
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}
