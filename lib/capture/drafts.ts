/**
 * Where a draft lives — contracts §5 and architecture §4.2. Propose persists nothing on the
 * server, so the phone is the only copy: `localStorage` under the bound account's own
 * `draft:<draftId>` key (Phase 9 §0.4: `smc:u:<userId>:draft:<draftId>`), one key per draft,
 * cleared on commit or dismiss. With no account bound there is nowhere to keep one.
 *
 * Pure apart from the store it is handed. Every call takes an injectable store so the sheet can be
 * driven in a test and a private-browsing failure is a return value, never a throw.
 */
import type { ProposeResponse } from "@/lib/capture/types";
import { accountKey, currentAccountOrNull } from "@/lib/device/account";

export const DRAFT_NAME_PREFIX = "draft:";
export const DRAFT_MAX_BYTES = 65_536;

/** The bound account's draft key prefix, or null when no account is bound. */
export function draftPrefix(): string | null {
  const h = currentAccountOrNull();
  return h === null ? null : accountKey(h, DRAFT_NAME_PREFIX);
}

export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
/** `inputKey`: what the capture sent (`captureInputKey`), so a 409 finds THIS capture's draft. */
export type StoredDraft = { draft: ProposeResponse; savedAt: string; inputKey?: string };

function defaultStore(): DraftStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // private browsing can throw on the property itself
  }
}

export function saveDraft(
  draft: ProposeResponse,
  store: DraftStore | null = defaultStore(),
  now: Date = new Date(),
  inputKey?: string,
): "ok" | "too_large" | "unavailable" {
  const prefix = draftPrefix();
  if (store === null || prefix === null) return "unavailable";
  const body = JSON.stringify({ draft, savedAt: now.toISOString(),
    ...(inputKey ? { inputKey } : {}) } satisfies StoredDraft);
  if (new TextEncoder().encode(body).length > DRAFT_MAX_BYTES) return "too_large";
  try {
    store.setItem(prefix + draft.draftId, body);
    return "ok";
  } catch {
    return "unavailable";
  }
}

/** The message to show them when `saveDraft` did not persist the draft — `null` when it did.
 *  Pure, so the sheet's branch on a failed save is testable without a DOM. */
export function draftSaveWarning(result: "ok" | "too_large" | "unavailable"): string | null {
  if (result === "ok") return null;
  return result === "too_large"
    ? "That capture is too big to save here. Log it before you close this."
    : "Couldn't save this capture on your phone. Log it before you close this.";
}

function read(store: DraftStore, key: string): StoredDraft | null {
  const raw = store.getItem(key);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as StoredDraft;
    return typeof parsed?.draft?.draftId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function loadDraft(draftId: string, store: DraftStore | null = defaultStore()): ProposeResponse | null {
  const prefix = draftPrefix();
  if (store === null || prefix === null) return null;
  return read(store, prefix + draftId)?.draft ?? null;
}

export function clearDraft(draftId: string, store: DraftStore | null = defaultStore()): void {
  const prefix = draftPrefix();
  if (store === null || prefix === null) return;
  try {
    store.removeItem(prefix + draftId);
  } catch {
    /* nothing to clear is the same outcome as cleared */
  }
}

/**
 * The draft a 409 `duplicate_request` is telling us we already hold: the one saved for this same
 * input (audit 2026-10-10 A032). Never another capture's draft — the newest of any capture used
 * to come back, so an abandoned draft could be saved as the wrong food. A committed draft is
 * cleared, so the same input logged twice finds none, and the sheet says so instead.
 */
export function draftForInput(
  inputKey: string | null, store: DraftStore | null = defaultStore(),
): ProposeResponse | null {
  const prefix = draftPrefix();
  if (inputKey === null || store === null || prefix === null) return null;
  let best: StoredDraft | null = null;
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key === null || !key.startsWith(prefix)) continue;
    const row = read(store, key);
    if (row === null || row.inputKey !== inputKey) continue;
    if (best === null || row.savedAt > best.savedAt) best = row;
  }
  return best?.draft ?? null;
}

/** The copy for a duplicate with no held draft: it was most likely saved a moment ago. */
export const DUPLICATE_NO_DRAFT = "You just sent this. If you saved it, it is on Today.";

/**
 * What a capture sent, as a key: the text itself, or a digest of the clip or photo. Two captures
 * of the same input get the same key, which is what the server's duplicate guard compares too.
 */
export async function captureInputKey(
  input: { method: "text"; text: string } | { method: string; blob: Blob },
): Promise<string | null> {
  if ("text" in input) return `text:${input.text.trim().toLowerCase()}`;
  try {
    const digest = await crypto.subtle.digest("SHA-256", await input.blob.arrayBuffer());
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${input.method}:${hex}`;
  } catch {
    return null; // no digest, no key: a duplicate then shows no draft rather than a wrong one
  }
}
