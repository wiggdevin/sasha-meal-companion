"use client";

/**
 * T11b: the logic behind the four body-profile fields — the draft the user types, the patch a blur
 * commits, and the retry a rejected save leaves. `components/BodyProfileFields.tsx` is the view over
 * this module.
 *
 * What is in a box while the user types is a raw string draft (Sol audit finding 2): clamping every
 * keystroke turned "1" into "50" mid-word, so "165" could never be typed. The draft is validated and
 * saved on blur (or Enter, or picking a sex), never on change. A rejected save shows a retry, like
 * T5's day-type sheet, and leaves the stored row alone (finding 7). Out-of-range values stay raw
 * and fail visibly; they are never silently clamped into a different value.
 *
 * Third round (Sol audit finding 4): the commit tells three outcomes apart — a value, an
 * intentional clear (an empty box) and text that is not a number. The last one keeps the draft,
 * shows an inline error under that row and enqueues nothing; a birth year must be a whole number.
 * A rejected IndexedDB read is retryable here too (finding 6).
 *
 * Fourth round (audit finding 4): a save's own signal and a sync pull both reload the profile, and
 * replacing EVERY draft on that reload wiped text still being typed in another box. The boxes the user
 * is holding — the one with the cursor in it, and the one the user has typed into but not committed —
 * keep their draft; only a clean box follows the row.
 *
 * Fifth round (audit finding 1): "Try again" used to re-send the patch with a bare write, so a save
 * that landed on the retry left the box held forever and a later refresh could never reach it. The
 * retry now goes back through the SAME commit path, which releases the box before the write.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_BIRTH_YEAR, PROFILE_READ_ERROR, saveBodyProfile, subscribeBodyProfile,
  type BodyProfileColumns, type BodyProfileSubscription }
  from "@/lib/body-profile-client";
import { EMPTY_BODY_PROFILE, type BodyProfile, type Sex } from "@/lib/tdee";

/** "Couldn't save. Try again." — the inline error, and the retry button under it. */
export const SAVE_ERROR = "Couldn't save. Try again.";

export type DraftKey = "heightCm" | "birthYear" | "bodyFatPct";

/** The text in the three number boxes, exactly as typed. Sex is a picker, so it is not a draft. */
export type Drafts = Record<DraftKey, string> & { sex: Sex | "" };

export const EMPTY_DRAFTS: Drafts = { heightCm: "", birthYear: "", bodyFatPct: "", sex: "" };

function text(value: number | null): string {
  return value === null ? "" : String(value);
}

export function draftsFromProfile(profile: BodyProfile | null): Drafts {
  const current = profile ?? EMPTY_BODY_PROFILE;
  return { heightCm: text(current.heightCm), birthYear: text(current.birthYear),
    bodyFatPct: text(current.bodyFatPct), sex: current.sex ?? "" };
}

/** One keystroke: the raw text becomes the draft and nothing else happens. */
export function draftWith(drafts: Drafts, key: DraftKey, raw: string): Drafts {
  return { ...drafts, [key]: raw };
}

/** Enter takes the same path as leaving the field: blur owns the one commit attempt. */
export function blurOnEnter(key: string, blur: () => void): void {
  if (key === "Enter") blur();
}

/** A box's draft is "theirs" while it has the cursor or holds text the user has not committed. */
export type HeldKey = DraftKey | "sex";

/**
 * A refresh — a same-page save landing, or a sync pull — replaces only the boxes the user is not
 * holding (T11b audit finding 4). The text in the box the user is typing in is a draft, not a stale
 * copy of the row, and writing the row over it mid-keystroke loses what the user was entering.
 */
export function refreshDrafts(current: Drafts, next: Drafts, held: ReadonlySet<HeldKey>): Drafts {
  return {
    heightCm: held.has("heightCm") ? current.heightCm : next.heightCm,
    birthYear: held.has("birthYear") ? current.birthYear : next.birthYear,
    bodyFatPct: held.has("bodyFatPct") ? current.bodyFatPct : next.bodyFatPct,
    sex: held.has("sex") ? current.sex : next.sex,
  };
}

export type NumberField = { key: DraftKey; column: keyof BodyProfileColumns; label: string;
  unit: string; min: number; max: number; /** A birth year is a count of years, not a fraction. */
  integer: boolean };

export const NUMBER_FIELDS = [
  { key: "heightCm", column: "height_cm", label: "Height", unit: "cm", min: 50, max: 260,
    integer: false },
  { key: "birthYear", column: "birth_year", label: "Birth year", unit: "", min: 1900,
    max: MAX_BIRTH_YEAR, integer: true },
  { key: "bodyFatPct", column: "body_fat_pct", label: "Body fat", unit: "%", min: 3, max: 70,
    integer: false },
] as const satisfies readonly NumberField[];

/**
 * What one box's text means (Sol audit finding 4). Three distinct results, where a single
 * `number | null` could not tell "the user emptied the box" from "the user typed something that is not a
 * number" — and the second one used to silently clear a stored column.
 */
export type NumberDraft =
  | { kind: "value"; value: number }
  | { kind: "clear" }
  | { kind: "invalid"; message: string };

export const INVALID_NUMBER = "Enter a number.";
export const INVALID_YEAR = "Enter a whole year.";

function rangeMessage(field: NumberField): string {
  return `Enter a value from ${field.min} to ${field.max}.`;
}

/** A finite number inside the field's range, or an error that leaves the raw draft untouched. */
export function numberDraft(field: NumberField, raw: string): NumberDraft {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "clear" };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { kind: "invalid", message: INVALID_NUMBER };
  if (field.integer && !Number.isInteger(value)) return { kind: "invalid", message: INVALID_YEAR };
  if (value < field.min || value > field.max) {
    return { kind: "invalid", message: rangeMessage(field) };
  }
  return { kind: "value", value };
}

/** What a blur does: save a patch, keep the draft with an inline error, or do nothing at all. */
export type CommitPlan =
  | { kind: "save"; patch: Partial<BodyProfileColumns> }
  | { kind: "keep"; error: string }
  | { kind: "unchanged" };

export function commitPlan(field: NumberField, raw: string, stored: number | null): CommitPlan {
  const draft = numberDraft(field, raw);
  if (draft.kind === "invalid") return { kind: "keep", error: draft.message };
  if (draft.kind === "clear") {
    return stored === null ? { kind: "unchanged" }
      : { kind: "save", patch: { [field.column]: null } };
  }
  return draft.value === stored ? { kind: "unchanged" }
    : { kind: "save", patch: { [field.column]: draft.value } };
}

export function sexOrNull(raw: string): Sex | null | undefined {
  if (raw === "") return null;
  return raw === "female" || raw === "male" || raw === "unspecified" ? raw : undefined;
}

/** The controlled picker's current draft and the write its selection requests. */
export type SexChange = {
  drafts: Drafts;
  patch: Partial<BodyProfileColumns> | null;
};

/**
 * Keep the picker's state transition next to its validation so tests can drive the same move as
 * the hook. This extraction intentionally preserves the existing behavior; T12b's failure-path
 * test defines whether a rejected selection must remain in the controlled picker.
 */
export function sexChange(drafts: Drafts, raw: string, stored: Sex | null): SexChange {
  const sex = sexOrNull(raw);
  if (sex === undefined) return { drafts, patch: null };
  const next: Drafts = { ...drafts, sex: sex ?? "" };
  return { drafts: next, patch: sex === stored ? null : { sex } };
}

/** What a blur asks the field's coordinator to do: keep the draft with an error, or write. */
export type BlurAction =
  | { kind: "keep"; error: string }
  | { kind: "write"; patch: Partial<BodyProfileColumns> | null };

export function blurAction(field: NumberField, raw: string, stored: number | null): BlurAction {
  const plan = commitPlan(field, raw, stored);
  if (plan.kind === "keep") return plan;
  return { kind: "write", patch: plan.kind === "save" ? plan.patch : null };
}

/** One number row's inline message, gone once the user edits that box again. */
export function clearedMessage(errors: Partial<Record<DraftKey, string>>, key: DraftKey):
    Partial<Record<DraftKey, string>> {
  const next = { ...errors };
  delete next[key];
  return next;
}

/** A save the store rejected. `false` means IndexedDB refused the write and the retry is theirs. */
export type ProfileWrite = (patch: Partial<BodyProfileColumns>) => Promise<boolean>;

/** The rejected save: the box to re-hold, and the patch "Try again" re-sends. */
export type FailedSave = { key: HeldKey; patch: Partial<BodyProfileColumns> };

/**
 * The draft/commit/retry coordination, with React left out of it — this repo has no React Testing
 * Library (Sol audit), so the state that carried the bugs is a plain object a test can drive.
 *
 * The invariant that matters: a box is theirs from the first keystroke (or the cursor moving into it)
 * until a write LANDS. A commit releases it BEFORE the write, so the save's own signal can land the
 * saved value in it; a rejected write re-holds it and keeps its patch; and "Try again" re-sends
 * that patch through the SAME commit path, so a write that lands this time releases the box for
 * good — the fifth-audit finding was a retry that skipped this and left the box held forever.
 *
 * Eighth round (finding 3): the completions are ordered per box. Two saves for the same box can
 * finish in either order, and an OLD rejection landing after a NEWER success used to re-hold the box
 * and make "Try again" re-send the superseded patch. Each commit takes the box's next attempt number
 * and only the newest one may set or clear its failure state.
 *
 * Ninth round (finding 3): the failure state is per box too. One shared `FailedSave` meant a save
 * for a DIFFERENT box cleared it — field A's rejected save lost its retry the moment field B landed.
 * The failures live in one map keyed by the box, only that box's own commit clears its entry, and
 * "Try again" re-sends the newest failure without touching the others.
 */
export type FieldCoordinator = {
  /** The boxes that are theirs right now — read by every refresh. */
  readonly held: ReadonlySet<HeldKey>;
  /** The save waiting for "Try again", or null. */
  failed: () => FailedSave | null;
  /** A keystroke, or a cursor: the box is theirs until a commit releases it. */
  hold: (key: HeldKey) => void;
  /** The box already agrees with the row, so there is nothing to save and nothing to hold. */
  release: (key: HeldKey) => void;
  /** Release the box, then write the patch; a rejected write re-holds it and keeps the patch. */
  commitPatch: (key: HeldKey, patch: Partial<BodyProfileColumns>) => void;
  /** True when it re-sent the failed save; false when only the read is left to retry. */
  retry: () => boolean;
};

export function createFieldCoordinator(write: ProfileWrite,
    onFailed: (failed: FailedSave | null) => void): FieldCoordinator {
  const held = new Set<HeldKey>();
  /** The newest save per box: only its completion may re-hold the box or raise the failure. */
  const attempts = new Map<HeldKey, number>();
  /** The saves waiting for "Try again", one entry per box, oldest failure first. */
  const failures = new Map<HeldKey, Partial<BodyProfileColumns>>();
  /** The newest failure, which is the one "Try again" re-sends (the error line has no room for two). */
  const current = (): FailedSave | null => {
    const last = [...failures].at(-1);
    return last === undefined ? null : { key: last[0], patch: last[1] };
  };
  const notify = () => onFailed(current());
  const coordinator: FieldCoordinator = {
    held,
    failed: current,
    hold: (key) => { held.add(key); },
    release: (key) => {
      // Returning to the stored value cancels any older failed or in-flight patch for this box.
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      held.delete(key);
      failures.delete(key);
      notify();
    },
    commitPatch: (key, patch) => {
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      held.delete(key);
      // Only THIS box's failure is superseded by this attempt: another box's retry is still theirs.
      failures.delete(key);
      notify();
      void write(patch).then((saved) => {
        if (attempts.get(key) !== attempt) return;   // a newer save for this box owns its state
        if (saved) { failures.delete(key); notify(); return; }
        held.add(key);
        failures.delete(key);                        // re-insert: the newest failure is the retry
        failures.set(key, patch);
        notify();
      });
    },
    retry: () => {
      const next = current();
      if (next === null) return false;
      coordinator.commitPatch(next.key, next.patch);
      return true;
    },
  };
  return coordinator;
}

/**
 * The read half: the shared subscription, plus the flag a rejected IndexedDB read raises. The
 * callback rides a ref, so a re-render never resubscribes.
 */
function useProfileRead(apply: (profile: BodyProfile) => void):
    { readError: boolean; retry: () => void } {
  const [readError, setReadError] = useState(false);
  const subscription = useRef<BodyProfileSubscription | null>(null);
  const latest = useRef(apply);

  // The ref, not the dependency: a re-render must never resubscribe (and lint forbids the write
  // during render, so it lands in its own effect before the subscription's first callback).
  useEffect(() => { latest.current = apply; });
  useEffect(() => {
    const sub = subscribeBodyProfile((next) => { latest.current(next); setReadError(false); },
      () => setReadError(true));
    subscription.current = sub;
    return sub.stop;
  }, []);

  return { readError, retry: () => subscription.current?.retry() };
}

/** Everything the view needs: the boxes, their messages, and the handlers behind them. */
export type BodyProfileFieldsState = {
  drafts: Drafts;
  draftErrors: Partial<Record<DraftKey, string>>;
  error: string | null;
  onEdit: (key: DraftKey, raw: string) => void;
  onCommit: (key: DraftKey) => void;
  onSex: (raw: string) => void;
  onFocus: (key: DraftKey) => void;
  onRetry: () => void;
};

/** The one store the four boxes share — one read, one write, one hand-off of each draft. */
export function useBodyProfileFields(): BodyProfileFieldsState {
  const [profile, setProfile] = useState<BodyProfile | null>(null);
  const [drafts, setDrafts] = useState<Drafts>(EMPTY_DRAFTS);
  const [draftErrors, setDraftErrors] = useState<Partial<Record<DraftKey, string>>>({});
  const [failed, setFailed] = useState<FailedSave | null>(null);
  const write = useCallback<ProfileWrite>(async (patch) => {
    try { await saveBodyProfile(patch); return true; } catch { return false; }
  }, []);
  const [coordinator] = useState(() => createFieldCoordinator(write, setFailed));
  /* One shared read: a same-page save and a sync pull both land here, so the boxes follow the row. */
  const { readError, retry: retryRead } = useProfileRead((next) => {
    setProfile(next);
    setDrafts((prev) => refreshDrafts(prev, draftsFromProfile(next), coordinator.held));
  });

  function edit(key: DraftKey, raw: string): void {
    coordinator.hold(key);
    setDrafts((prev) => draftWith(prev, key, raw));
    setDraftErrors((prev) => clearedMessage(prev, key));
  }

  function commit(key: DraftKey): void {
    const field = NUMBER_FIELDS.find((f) => f.key === key);
    if (!field) return;
    // Text that is not a number keeps its draft, says so under the row, and enqueues nothing.
    const action = blurAction(field, drafts[key], (profile ?? EMPTY_BODY_PROFILE)[key]);
    if (action.kind === "keep") { setDraftErrors((prev) => ({ ...prev, [key]: action.error })); return; }
    setDraftErrors((prev) => clearedMessage(prev, key));
    // A null patch is 'unchanged': the box already agrees with the row, so it is not theirs any more.
    if (action.patch === null) coordinator.release(key);
    else coordinator.commitPatch(key, action.patch);
  }

  function pickSex(raw: string): void {
    const change = sexChange(drafts, raw, (profile ?? EMPTY_BODY_PROFILE).sex);
    setDrafts(change.drafts);
    if (change.patch === null) coordinator.release("sex");
    else {
      coordinator.hold("sex");
      coordinator.commitPatch("sex", change.patch);
    }
  }

  /** "Try again" re-commits the failed save through `commitPatch`; otherwise it retries the read. */
  function retry(): void {
    if (!coordinator.retry()) retryRead();
  }

  return { drafts, draftErrors, error: failed ? SAVE_ERROR : readError ? PROFILE_READ_ERROR : null,
    onEdit: edit, onCommit: commit, onSex: pickSex,
    onFocus: (key) => coordinator.hold(key), onRetry: retry };
}
