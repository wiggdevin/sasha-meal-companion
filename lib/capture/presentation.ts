/**
 * What the capture flow SAYS and SHOWS: its words, its rows, and what Today reads off a synced
 * entry. Split out of lib/capture-client.ts when that file passed 400 lines (Grok pass 3, LOW 10);
 * no behaviour moved with it. The division is by question: that file moves bytes — sign, upload,
 * propose, commit — and this one holds the vocabulary around them, which is why nothing here
 * fetches anything.
 *
 * lib/capture-client.ts re-exports all of it, so every call site still imports from there.
 */
import { enabledMethods } from "@/lib/capture/flags";
import { publicFeatureScan } from "@/lib/capture/public-flags";
import type { CaptureMethod } from "@/lib/capture/flags";
import type { PolicyVerdict } from "@/lib/policy/constraints";
import type { SlotId } from "@/lib/types";
import { reasonLabel } from "@/lib/policy/reason-words";

/** Under this, the confirm sheet and Today both say "check this" (spec §6). */
export const LOW_CONFIDENCE = 0.6;

/** Safari and current Chrome record `audio/mp4`. Order is preference, first supported wins.
 *  Every entry must be in `ACCEPTED_AUDIO_TYPES` (lib/media/validate.ts): `audio/webm` was here
 *  once, and the bucket, the sign route and validateAudio all refused it, so a webm-only browser
 *  (Firefox) recorded a clip that was then lost. Such a browser now hears "unsupported" up front. */
export const AUDIO_MIME_TYPES = ["audio/mp4", "audio/aac"] as const;

export function pickAudioMimeType(isSupported: (type: string) => boolean): string | null {
  return AUDIO_MIME_TYPES.find((type) => isSupported(type)) ?? null;
}

/** The text method reads "Say or type": its box always carries the dictation mic
 *  (components/DictateMic.tsx), so saying the meal is the first thing offered. The separate
 *  `voice` method — a recorded clip sent to the model — is its own flag and is unchanged. */
export const CAPTURE_LABELS: Record<CaptureMethod, string> = {
  text: "Say or type a meal",
  voice: "Say a meal",
  label: "Scan a label",
  photo: "Photograph the plate",
};

/** The same four actions as a sheet pill. A sheet is narrower than the FAB's menu, so the pill
 *  carries this short word and `aria-label` carries the full `CAPTURE_LABELS` line (T2 decision 2). */
export const SHORT_CAPTURE_LABELS: Record<CaptureMethod, string> = {
  text: "Say or type",
  voice: "Speak",
  label: "Label",
  photo: "Photo",
};

export type CaptureAction = { method: CaptureMethod; label: string };

/** The rows Today offers. The flag is the only gate: a method not in it has no action and its
 *  propose branch answers 404 (spec §11). No `env` means "read the real flags": the server's
 *  CAPTURE_METHODS first, then the literally-inlined public twin (audit finding T2/P1). */
export function captureActions(env?: Record<string, string | undefined>): CaptureAction[] {
  // An explicit record is authoritative even when it names nothing: only `undefined` (no
  // record) may fall through to the ambient flags.
  const raw = env ? (env.CAPTURE_METHODS ?? env.NEXT_PUBLIC_CAPTURE_METHODS ?? "") : undefined;
  return enabledMethods(raw).map((method) => ({ method, label: CAPTURE_LABELS[method] }));
}

/** The prop pair an overlay that offers capture needs: the capture flow, and the barcode sheet
 *  only when its flag is on — `QuickActions`' own gate, shared rather than repeated per call site.
 *  `app/page.tsx` spreads it, so the two new props cost the page one line total (finding T2/P3). */
export function captureOverlayProps(
  onCapture: (method: CaptureMethod) => void,
  onScan: () => void,
): { onCapture: (method: CaptureMethod) => void; onScan?: () => void } {
  const scan = publicFeatureScan();
  return scan ? { onCapture, onScan } : { onCapture };
}

export function policyCopy(policy: PolicyVerdict): string | null {
  if (policy.verdict === "allowed") return null;
  if (policy.verdict === "unverified") return "Not checked";
  const reason = policy.reason ?? "";
  if (reason.startsWith("allergen:")) return `Has ${reason.slice(9)}`;
  if (reason === "avoid_list") return "On your avoid list";
  if (reason.startsWith("category:")) {
    const category = reason.slice(9).replace(/_/g, " ");
    return category.charAt(0).toUpperCase() + category.slice(1);
  }
  // Phase 18 W2c: diet and religious rules block with facet:* ("Meat", "Contains pork").
  return reasonLabel(reason, "Blocked");
}

/** The day's capture count against the soft cap, or nothing when there is no cap to count against
 *  (an empty draft, a coach draft): "0 of 0 today" says nothing (W139). */
export function spendNote(spend: { usedToday: number; softCap: number }): string | undefined {
  if (!(spend.softCap > 0)) return undefined;
  return `${spend.usedToday} of ${spend.softCap} today`;
}

export type CaptureMeta = { method: CaptureMethod; lowConfidence: boolean };

const CAPTURE_METHOD_SET = new Set<string>(["text", "voice", "label", "photo"]);

/**
 * What Today needs off a synced `log_entries` row: the method glyph, and whether any item came
 * back under 0.6. The row is `_sync_current`'s shape — the entry with `items[]` inline — and the
 * legacy `LoggedFood` type carries neither field, which is why this reads the row and not the
 * view model. A row with no `confidence` is not a low-confidence row: `null` is not `0`.
 */
export function captureMetaFrom(row: Record<string, unknown> | null | undefined): CaptureMeta | null {
  const method = typeof row?.method === "string" ? row.method : "";
  if (!CAPTURE_METHOD_SET.has(method)) return null;
  const items = Array.isArray(row?.items) ? row.items : [];
  const lowConfidence = items.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).confidence === "number" &&
      ((item as Record<string, unknown>).confidence as number) < LOW_CONFIDENCE,
  );
  return { method: method as CaptureMethod, lowConfidence };
}

/** The slot a capture belongs to right now — the same rule Today uses for its current slot: the
 *  last slot whose time has arrived, else the first slot of the day, else meal-1. Contracts §5
 *  gives the sheet no slot prop; Phase 7 mounts it with none. */
export function slotForNow(slots: { slot: SlotId; time: string }[], nowMinutes: number): SlotId {
  let current: SlotId | null = null;
  for (const s of slots) {
    const [h, m] = s.time.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
    if (h * 60 + m <= nowMinutes) current = s.slot;
  }
  return current ?? slots[0]?.slot ?? "meal-1";
}
