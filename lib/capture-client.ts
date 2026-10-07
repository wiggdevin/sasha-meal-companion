/**
 * The browser half of Phase 4 capture — contracts §5.
 *
 * Three calls and nothing else: text goes straight to propose; media signs, uploads, then
 * proposes; a checked draft commits through the Phase 2 path, because Phase 4 adds no commit type
 * of its own. The server owns every number and every policy verdict — this file moves bytes and
 * turns the spec's status table into a line the user can read. Model text is data: an error body is
 * never echoed back to the user's, only mapped.
 */
import { isDeadline } from "@/lib/fetch-with-deadline";
import { putSignedUpload } from "@/lib/capture/upload";
import {
  accountFetch, accountHandle, accountJson, rethrowAccountChanged, type AccountHandle,
} from "@/lib/device/account";
import {
  beginRun, discardRun, mark, markMs, type TimingPath, type TimingRun, type TimingStep,
} from "@/lib/timing";
import type { CaptureMethod } from "@/lib/capture/flags";
import type { DraftItem, ProposeRequest, ProposeResponse, SignRequest, SignResponse } from "@/lib/capture/types";
import { buildCommitRequest } from "@/lib/log-client";
import { commitLogEntry, type CommitResult } from "@/lib/log-commit-client";
import type { LogCommitRequest } from "@/lib/log/contract";
import type { LoggedFood, LoggedItem, SlotId } from "@/lib/types";

export const PROPOSE_URL = "/api/log/propose";
export const SIGN_URL = "/api/media/sign";

/**
 * The capture vocabulary — the labels, the action rows, the policy copy, `captureMetaFrom` and
 * `slotForNow` — lives in lib/capture/presentation.ts and is re-exported here, so this file stays
 * the one import a capture surface needs.
 */
export {
  AUDIO_MIME_TYPES, CAPTURE_LABELS, LOW_CONFIDENCE, SHORT_CAPTURE_LABELS, captureActions,
  captureMetaFrom, captureOverlayProps, pickAudioMimeType, policyCopy, slotForNow, spendNote,
} from "@/lib/capture/presentation";
export type { CaptureAction, CaptureMeta } from "@/lib/capture/presentation";

export type CaptureContext = {
  localDate: string; tz: string; slot: SlotId; fetchFn?: typeof fetch;
  /** The account the capture started as (Phase 9 §0.5a). Default: the bound one. */
  account?: AccountHandle;
  /**
   * Told which hop is starting, so the sheet can name it in `components/WorkingLine.tsx`. The
   * same hops are marked for `client_timings` either way; this is only the UI's copy of it.
   */
  onStep?: (step: TimingStep) => void;
};

export type CaptureOutcome =
  /** `run` is this capture's own timing run: the commit that follows closes THAT one, so two
   *  captures started together are two taps rather than one row set (Grok pass 5, LOW). */
  | { kind: "draft"; draft: ProposeResponse; run?: TimingRun }
  | { kind: "empty"; message: string }
  | { kind: "duplicate"; message: string }
  | { kind: "error"; status: number; message: string };

const FALLBACK = "Capture did not answer. Try search.";

/** One line per row of the spec §5 status table. `spend_cap` and `provider_unavailable` are the
 *  two the contract fixes word for word. */
const ERROR_COPY: Record<string, string> = {
  unauthorized: "Sign in again, then try once more.",
  media_not_owned: "That upload is not on this account.",
  too_large: "That file is too big. Try a shorter clip or one photo.",
  unsupported_media: "That file type does not work here.",
  schema_invalid: "Nothing came back to check.",
  rate_limited: "Too many tries. Give it a minute.",
  spend_cap: "Daily capture limit reached",
  provider_unavailable: "Capture is resting, try search",
  duplicate_request: "You just sent this. Here it is again.",
  not_found: "That way of logging is off right now.",
  method_disabled: "That way of logging is off right now.",
};

/** Everything a refused call can end as: never a draft, so a failure always carries a line. */
export type UploadFailure = Exclude<CaptureOutcome, { kind: "draft" }>;

export function mapCaptureError(status: number, error: string): UploadFailure {
  if (status === 422) return { kind: "empty", message: ERROR_COPY.schema_invalid };
  if (status === 409) return { kind: "duplicate", message: ERROR_COPY.duplicate_request };
  if (status === 503) return { kind: "error", status, message: ERROR_COPY.provider_unavailable };
  return { kind: "error", status, message: ERROR_COPY[error] ?? FALLBACK };
}

async function errorFrom(h: AccountHandle, res: Response): Promise<UploadFailure> {
  let body: { error?: string } = {};
  try {
    body = await accountJson<{ error?: string }>(h, res);
  } catch (e) {
    rethrowAccountChanged(e);
    // The budget covers the body, so the read itself can run out of it. That is the timeout's
    // line, not whatever the status alone would have said (Grok pass 26, HIGH 2).
    if (isDeadline(e)) return timedOut();
  }
  return mapCaptureError(res.status, body.error ?? "");
}

/** A deadline is not "no answer" — the server may well be mid-model — so it reads as the
 *  provider line the status table already owns, not as the generic transport fallback. */
function timedOut(): UploadFailure {
  return { kind: "error", status: 0, message: ERROR_COPY.provider_unavailable };
}

/**
 * The run this capture belongs to. The method IS the path (spec §1), and the run stays open until
 * the commit closes it, so one tap is one row set even though three different modules marked it.
 */
function pathFor(method: CaptureMethod): TimingPath {
  return method;
}

async function propose(
  h: AccountHandle, req: ProposeRequest, fetchFn: typeof fetch,
  onStep?: (step: TimingStep) => void, opened?: TimingRun,
): Promise<CaptureOutcome> {
  const path = pathFor(req.method);
  const run = opened ?? beginRun(path);
  mark(path, "propose", run);
  onStep?.("propose");
  let res: Response;
  try {
    res = await accountFetch(h, PROPOSE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(req),
    }, { budget: "propose", fetchImpl: fetchFn });
  } catch (e) {
    // This capture's OWN run, by its handle: a failed tap that leaves a run open on the path has
    // the next tap's bare marks filed into it (Grok pass 25, LOW 4).
    discardRun(path, run);
    rethrowAccountChanged(e);
    return isDeadline(e) ? timedOut() : { kind: "error", status: 0, message: FALLBACK };
  }
  if (!res.ok) {
    discardRun(path, run);
    return errorFrom(h, res);
  }
  let draft: ProposeResponse;
  try {
    draft = await accountJson<ProposeResponse>(h, res);
  } catch (e) {
    // A 200 whose body never arrives is the same wait as a request that never answered, and the
    // sheet needs the same words for it (Grok pass 26, HIGH 2).
    discardRun(path, run);
    rethrowAccountChanged(e);
    return isDeadline(e) ? timedOut() : { kind: "error", status: 0, message: FALLBACK };
  }
  // The two hops only the server could time, filed into this run rather than a run of their own.
  if (draft.timings) {
    markMs(path, "model", draft.timings.model, run);
    markMs(path, "ground", draft.timings.ground, run);
  }
  return { kind: "draft", draft, run };
}

export async function captureText(text: string, ctx: CaptureContext): Promise<CaptureOutcome> {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { kind: "error", status: 0, message: "Type what you ate first." };
  }
  return propose(ctx.account ?? accountHandle(),
    { method: "text", localDate: ctx.localDate, tz: ctx.tz, slot: ctx.slot, text: trimmed },
    ctx.fetchFn ?? fetch, ctx.onStep,
  );
}

export type MediaMethod = Exclude<CaptureMethod, "text">;

/** Voice is the only audio of the three; both photo paths are images (contracts §5). */
const MEDIA_KIND: Record<MediaMethod, SignRequest["kind"]> = {
  voice: "audio", label: "image", photo: "image",
};

export const UPLOAD_FAILED = "The upload did not finish. Try again.";

/** The two ends of an upload: the server's own path, or the line the user reads instead. */
export type SignedUpload =
  | { kind: "uploaded"; path: string }
  | { kind: "failed"; outcome: UploadFailure };

/**
 * Sign, then PUT the bytes. One helper rather than two copies of it: the coach's voice fallback
 * (T7 §2, `lib/coach-transcribe-client.ts`) uploads a clip to the same bucket, under the same
 * `media_objects` row and the same 24 h sweep, and a second implementation would be a second
 * lifecycle to keep honest.
 *
 * The path in the answer is the server's own string; nothing here builds one, because every
 * reader re-checks its first segment against `auth.uid()` and a client-made path would be a
 * capability we are not allowed to hold (architecture §4.2).
 */
export async function signAndUpload(
  kind: SignRequest["kind"], blob: Blob, fetchFn: typeof fetch,
  hooks: {
    beforeSign?: () => void; beforeUpload?: () => void; signal?: AbortSignal;
    account?: AccountHandle;
  } = {},
): Promise<SignedUpload> {
  const h = hooks.account ?? accountHandle();
  const signRequest: SignRequest = { kind, contentType: blob.type, bytes: blob.size };
  hooks.beforeSign?.();
  let signed: SignResponse;
  try {
    const res = await accountFetch(h, SIGN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(signRequest),
      ...(hooks.signal ? { signal: hooks.signal } : {}),
    }, { budget: "sign", fetchImpl: fetchFn });
    if (!res.ok) return { kind: "failed", outcome: await errorFrom(h, res) };
    signed = await accountJson<SignResponse>(h, res);
  } catch (e) {
    rethrowAccountChanged(e);
    return { kind: "failed",
      outcome: isDeadline(e) ? timedOut() : { kind: "error", status: 0, message: FALLBACK } };
  }

  hooks.beforeUpload?.();
  const put = await putSignedUpload(signed.uploadUrl, blob, fetchFn, hooks.signal);
  if (put !== null) return { kind: "failed", outcome: { kind: "error", status: put, message: UPLOAD_FAILED } };
  return { kind: "uploaded", path: signed.path };
}

/** Sign, upload, propose — the three hops of one media capture, in one timing run. */
export async function captureMedia(
  kind: MediaMethod,
  blob: Blob,
  ctx: CaptureContext,
): Promise<CaptureOutcome> {
  const fetchFn = ctx.fetchFn ?? fetch;
  const h = ctx.account ?? accountHandle();
  const path = pathFor(kind);
  // One run for the whole capture: sign, upload and propose are hops of the same tap, and the
  // commit closes it.
  const run = beginRun(path);
  const uploaded = await signAndUpload(MEDIA_KIND[kind], blob, fetchFn, {
    account: h,
    beforeSign: () => { mark(path, "sign", run); ctx.onStep?.("sign"); },
    beforeUpload: () => { mark(path, "upload", run); ctx.onStep?.("upload"); },
  });
  if (uploaded.kind === "failed") {
    discardRun(path, run);
    return uploaded.outcome;
  }

  return propose(h,
    { method: kind, localDate: ctx.localDate, tz: ctx.tz, slot: ctx.slot, mediaPath: uploaded.path },
    fetchFn, ctx.onStep, run,
  );
}

export type DraftEdit = {
  grams?: number; qty?: number; unit?: string; portionId?: number | null;
  foodRefId?: string; catalogFoodRevisionId?: number | null; label?: string; removed?: boolean;
};
export type DraftEdits = Record<number, DraftEdit>;
export type EditedItem = DraftItem & { removed: boolean; wasEdited: boolean };

/**
 * The sheet holds edits by `seq` and never mutates the draft it was given, so a dismissed sheet
 * leaves the stored draft exactly as the server returned it.
 *
 * Typing grams or swapping the food clears the old portion. A swap drops the verdict to
 * `unverified`: the server rechecks the chosen food at commit, and the old verdict cannot be reused.
 * A server-grounded alternative may carry its own revision pin for an accurate preview.
 */
export function applyEdits(items: DraftItem[], edits: DraftEdits): EditedItem[] {
  return items.map((item) => {
    const edit = edits[item.seq] ?? {};
    const grams = edit.grams ?? item.grams;
    const gramsMoved = grams !== item.grams;
    const swapped = edit.foodRefId !== undefined && edit.foodRefId !== item.foodRefId;
    return {
      ...item,
      label: edit.label ?? item.label,
      foodRefId: edit.foodRefId ?? item.foodRefId,
      catalogFoodRevisionId: swapped ? (edit.catalogFoodRevisionId ?? null)
        : (edit.catalogFoodRevisionId ?? item.catalogFoodRevisionId),
      grams,
      qty: edit.qty ?? (gramsMoved || swapped ? grams : item.qty),
      unit: edit.unit ?? (gramsMoved || swapped ? "g" : item.unit),
      portionId: edit.portionId !== undefined ? edit.portionId : (gramsMoved || swapped ? null : item.portionId),
      policy: swapped ? { verdict: "unverified" as const } : item.policy,
      removed: edit.removed === true,
      wasEdited: gramsMoved || swapped,
    };
  });
}

export function keptItems(items: EditedItem[]): EditedItem[] {
  return items.filter((item) => !item.removed);
}

/** Spec AC9: a blocked item never leaves this sheet. An ungrounded item has no `food_ref_id` to
 *  commit, so it blocks Save the same way until the user swaps or removes it. */
export function canSave(items: EditedItem[]): boolean {
  const kept = keptItems(items);
  return kept.length > 0
    && kept.every((item) => item.policy.verdict !== "blocked" && item.foodRefId !== null);
}

/**
 * `buildCommitRequest` reads exactly one field off `revision` — `revision_id` — and the server
 * recomputes every snapshot from it (spec §8, AC10). A draft item carries
 * `catalogFoodRevisionId` and no cached row, so this is the smallest object that satisfies the
 * call without inventing a number that would then be ignored. A null id commits without a pin and
 * the server resolves the active revision.
 */
function revisionRef(revisionId: number | null): { revision_id: number | null } {
  return { revision_id: revisionId };
}

export type CommitContext = {
  entryId?: string; eatenAt?: Date; tz: string; slot: SlotId; note?: string;
  saveLabelAsFood?: boolean; fetchImpl?: typeof fetch;
  /** The account the capture started as, so the commit files under it (Phase 9 §0.5a). */
  account?: AccountHandle;
  /** The run the capture opened, so this commit closes that one rather than the path's latest. */
  run?: TimingRun;
};

/**
 * The card Today shows the moment the user taps Save on the confirm sheet (T0 §3, Grok 4.6 MEDIUM 6).
 *
 * A draft carries no nutrients — they come from the catalog rows the items were grounded to, and
 * only the server has those — so this card starts at zero and the commit's reply fills each
 * item's snapshot in. `entryMacros` reads the snapshots in preference to `macros`, so the day's
 * numbers are right from the reply onwards; the window before it is the length of the commit,
 * and the card carries the pending mark throughout it.
 */
function draftCard(
  draft: ProposeResponse, kept: EditedItem[], entryId: string, itemIds: string[], at: Date,
  note: string | undefined,
): LoggedFood {
  const zero = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  const grams = Math.round(kept.reduce((sum, item) => sum + item.grams, 0) * 10) / 10;
  const name = draft.labelFood?.name
    ?? (kept.length === 1 ? kept[0].label : `${kept.length} items`);
  const items: LoggedItem[] = kept.map((item, i) => ({
    id: itemIds[i], seq: i + 1, food_ref_id: item.foodRefId as string,
    grams: item.grams, qty: item.qty, unit: item.unit,
    snapshot: {}, foodId: `catalog:${item.catalogFoodRevisionId ?? 0}`,
    name: item.label, portionLabel: `${item.qty} ${item.unit}`, macros: zero,
  }));
  return {
    id: entryId, foodId: items[0]?.foodId ?? "capture", name,
    portionLabel: kept.length === 1 ? `${kept[0].qty} ${kept[0].unit}` : `${kept.length} items`,
    qty: 1, grams, macros: zero,
    ...(note?.trim() ? { note: note.trim() } : {}),
    items, at: at.toISOString(),
  };
}

export async function commitDraft(
  draft: ProposeResponse,
  edits: DraftEdits,
  ctx: CommitContext,
): Promise<CommitResult> {
  // The write path asks `canSave` itself rather than re-deriving a narrower rule: spec AC9 says a
  // blocked item never leaves this sheet, and that promise has to hold here, not only where the
  // Save button is wired.
  const applied = applyEdits(draft.items, edits);
  if (!canSave(applied)) {
    return { status: "invalid", issues: [{ path: "items", message: "nothing to save" }] };
  }
  const kept = keptItems(applied);
  const entryId = ctx.entryId ?? crypto.randomUUID();
  const eatenAt = ctx.eatenAt ?? new Date();
  const itemIds = kept.map(() => crypto.randomUUID());
  const base = buildCommitRequest({
    entryId,
    eatenAt,
    tz: ctx.tz,
    slot: ctx.slot,
    note: ctx.note,
    items: kept.map((item, i) => ({
      id: itemIds[i],
      foodRefId: item.foodRefId as string,
      revision: revisionRef(item.catalogFoodRevisionId),
      grams: item.grams, qty: item.qty, unit: item.unit,
      portionId: item.portionId, wasEdited: item.wasEdited,
      confidence: item.confidence,
    })),
  });
  const req: LogCommitRequest = { ...base, method: draft.method, draft_id: draft.draftId };
  if (ctx.saveLabelAsFood === true && draft.method === "label") req.save_label_as_food = true;
  // The capture method IS the timing path (spec §1), so this commit closes the run the sign /
  // upload / propose marks opened.
  return commitLogEntry(req, {
    fetchImpl: ctx.fetchImpl, timingPath: pathFor(draft.method), run: ctx.run,
    ...(ctx.account ? { account: ctx.account } : {}),
    // The same day the request itself files under (base.local_date), not a re-derive off the
    // device's own zone — the optimistic card and the commit must agree.
    optimistic: { date: base.local_date,
      entry: draftCard(draft, kept, entryId, itemIds, eatenAt, ctx.note) },
  });
}
