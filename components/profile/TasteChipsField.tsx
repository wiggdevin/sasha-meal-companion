"use client";

/**
 * The shared "one taste text" field (Phase 18 W5b-2 UI): Settings and the gated onboarding cuisine
 * step both mount this with a different `source`. The flow:
 *
 *   0. On mount, `readTasteChipsEnabled()` (lib/profile/taste-enabled-client.ts, W5b-3) asks the
 *      server whether `TASTE_CHIPS_ENABLED` is on. The whole block renders nothing (not even the
 *      text input) until that answers "enabled" — "disabled" and "unknown" (offline, a timeout, any
 *      non-200) both hide it, so an off or unreachable flag never shows an inert field.
 *   1. The user types a short taste text and blurs. `requestTasteChips` (lib/profile/prefs-client.ts)
 *      runs the phone's local safety check first and either keeps the text local (a rule, a symptom,
 *      unsure text — nothing is ever sent) or sends it to the suggestion endpoint.
 *   2. `route: "local"` shows the existing rule hand-off (`DietaryTextHint`, #461): a rule/condition
 *      reads as a food rule, unsure text asks for plain likes and dislikes. Nothing is sent.
 *   3. `route: "send"` shows the suggested dislikes and cuisines as toggleable chips, up to
 *      `TASTE_PICK_MAX` (3) picked at a time. `likes` are deliberately never shown here: the confirm
 *      RPC (`tasteConfirmRequestSchema`, lib/profile/taste-confirm.ts) has no `likes` field — only
 *      `dislikes` and `cuisines` are ever written, so a like chip would have nowhere to go.
 *   4. Nothing is written until "Confirm". One `newTasteActionId()` is minted per tap and reused for
 *      that tap's retries (same id, same chips) — a changed selection always mints a fresh one, so
 *      an id is never replayed against a different request. The outcome (`ok` / `offline` / `retry` /
 *      `refused`) is shown through the shared ActionFeedback; a success offers Undo, which removes
 *      exactly what that action added (`undoTasteChips`).
 *   5. A dislike only lowers a food's rank — the copy here never says a food is removed or banned.
 *
 * **Transient failure.** `requestTasteChips` tells a 404 `not_enabled` (reason `"disabled"`) apart
 * from any other failure (reason `"failed"`: offline, a timeout, a bad shape). A `disabled` answer
 * folds the block the same as the mount-time gate (the flag flipped off mid-session). A `failed`
 * answer never folds anything — the field stays and shows "No suggestions right now. Try again."
 * so a one-off network blip looks transient, not broken; the cuisine chips next to this field
 * (`CuisineChips`, a separate component) are unaffected either way.
 */
import { useEffect, useRef, useState } from "react";
import { Pill } from "@/components/Sheet";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import Button from "@/components/ui/Button";
import DietaryTextHint from "@/components/ui/DietaryTextHint";
import Thinking from "@/components/ui/Thinking";
import { accountHandle } from "@/lib/device/account";
import { syncOnce } from "@/lib/sync/client";
import { CUISINE_LABELS, CUISINES, type CuisineKey } from "@/lib/profile/cuisines";
import { requestTasteChips } from "@/lib/profile/prefs-client";
import { readTasteChipsEnabled, type TasteChipsAvailability } from "@/lib/profile/taste-enabled-client";
import {
  confirmTasteChips, newTasteActionId, undoTasteChips, type TasteWriteOutcome,
} from "@/lib/profile/taste-confirm-client";
import {
  TASTE_CONFIRM_ERRORS,
  type TasteConfirmRequest, type TasteConfirmResult, type TasteConfirmSource, type TasteKeys,
} from "@/lib/profile/taste-confirm";
import { SENSORY_TAG_TEXT, type TasteSuggestion } from "@/lib/profile/taste-chips";
import type { TasteDislike } from "@/lib/profile/taste";

/** Up to this many chips (dislikes and cuisines together) are picked per confirm tap (W5b spec:
 *  "up to 3 taste chips or one taste text"). */
export const TASTE_PICK_MAX = 3;

type Picked =
  | { kind: "dislike"; key: TasteDislike; label: string }
  | { kind: "cuisine"; key: CuisineKey; label: string };

function pickedId(p: Picked): string {
  return `${p.kind}:${p.key}`;
}

/** A stored or suggested dislike key, read as a short label (the sensory vocabulary for `t:`, the
 *  family name itself for `f:`). Shared with the Settings read-only list. */
export function tasteDislikeLabel(key: TasteDislike): string {
  if (key.startsWith("t:")) {
    const tag = key.slice(2) as keyof typeof SENSORY_TAG_TEXT;
    return SENSORY_TAG_TEXT[tag]?.label ?? tag;
  }
  return key.slice(2);
}

function writeFailureMessage(error: unknown): string {
  const outcome = error as TasteWriteOutcome<unknown> | null | undefined;
  if (outcome && outcome.ok === false) {
    if (outcome.reason === "offline") return "This waits for a connection.";
    if (outcome.reason === "retry") return outcome.message || "No connection. Try again.";
    if (outcome.reason === "refused") return outcome.message || "That did not save. Try again.";
  }
  return "That did not save. Try again.";
}

/**
 * A small, fixed set of chips offered when Jev is down (D9 followup #3): `suggestion.jev === false`
 * means nothing was classified from the text, so `suggestion.dislikes`/`cuisines` are empty and the
 * field would otherwise show "Nothing to suggest from that yet." with no way to add a chip at all.
 * These are explicitly CHOSEN by the user, never inferred from the text that failed to classify —
 * the six most commonly disliked sensory tags and the six most broadly recognized cuisines, both
 * already fixed, reviewed vocabularies (lib/profile/taste.ts, lib/profile/cuisines.ts), so nothing
 * new is introduced here. The local safety check already ran before this point (the module
 * docblock's step 1): a rule, a symptom or medical text never reaches here at all — only text that
 * was safe to send, and for which Jev happened to be unavailable.
 */
const PRESET_DISLIKE_KEYS: readonly TasteDislike[] = [
  "t:spicy_hot", "t:bitter", "t:sour", "t:strong_fish", "t:slimy", "t:gamey",
];
const PRESET_CUISINE_KEYS: readonly CuisineKey[] = CUISINES.slice(0, 6);

function SuggestedChips({ suggestion, picked, confirmed, pending, onToggle }: {
  suggestion: Extract<TasteSuggestion, { route: "send" }>;
  picked: Picked[];
  confirmed: ReadonlySet<string>;
  /** A confirm or undo write is in flight: toggling is paused so a resolving write's "clear what I
   *  sent" never discards a selection the user changed in the meantime (verified finding). */
  pending: boolean;
  onToggle: (p: Picked) => void;
}) {
  // `likes` is never rendered: the confirm RPC has no field to write it to (see module docblock).
  const usingPresets = !suggestion.jev;
  const options: Picked[] = usingPresets
    ? [
      ...PRESET_DISLIKE_KEYS.map((key): Picked => ({ kind: "dislike", key, label: tasteDislikeLabel(key) })),
      ...PRESET_CUISINE_KEYS.map((key): Picked => ({ kind: "cuisine", key, label: CUISINE_LABELS[key] })),
    ]
    : [
      ...suggestion.dislikes.map((chip): Picked => ({ kind: "dislike", key: chip.key, label: chip.label })),
      ...suggestion.cuisines.map((chip): Picked => ({ kind: "cuisine", key: chip.key, label: CUISINE_LABELS[chip.key] })),
    ];
  if (options.length === 0) {
    return <p className="m-0 text-tiny font-light text-muted">Nothing to suggest from that yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {usingPresets && (
        <p className="m-0 text-tiny font-light text-muted">
          We couldn&rsquo;t read suggestions from that just now — pick any that fit instead:
        </p>
      )}
      <div role="group" aria-label={usingPresets ? "Taste chips to pick from" : "Suggested taste chips"}
        className="flex flex-wrap gap-2">
        {options.map((option) => {
          const id = pickedId(option);
          const isConfirmed = confirmed.has(id);
          const isPicked = isConfirmed || picked.some((p) => pickedId(p) === id);
          const full = !isPicked && picked.length >= TASTE_PICK_MAX;
          return <Pill key={id} active={isPicked} disabled={isConfirmed || full || pending}
            onClick={() => onToggle(option)}>
            {option.label}
          </Pill>;
        })}
      </div>
      <p className="m-0 text-tiny font-light text-muted">
        A dislike only lowers how often a food comes up — it never rules a food out.
      </p>
    </div>
  );
}

function keysToIds(keys: TasteKeys): string[] {
  return [...keys.dislikes.map((key) => `dislike:${key}`), ...keys.cuisines.map((key) => `cuisine:${key}`)];
}

export default function TasteChipsField({ source, heading, availability, onDisabled }: {
  source: TasteConfirmSource;
  /** Onboarding's own lead-in ("Any taste you want to add?") plus its divider: rendered around the
   *  field, and ONLY while the field itself would render, so the flag being off or unreachable
   *  never leaves a heading and a rule with nothing underneath (verified finding). Settings has no
   *  heading of its own here — its surrounding fieldset legend already covers it. */
  heading?: string;
  /**
   * When a caller already needs the SAME `readTasteChipsEnabled()` answer for its own decision
   * (CuisinesSection, which shows or hides its surrounding Card by it), it passes that answer here
   * instead of letting this field run its own, separate probe — two independent reads of the same
   * flag can land two different answers (a transient blip on one, or the flag flipping between
   * them), which would show the card with nothing inside it again, the exact bug this probe exists
   * to prevent (Sol BLOCK, verified). Omitted (onboarding's `CuisineStep`, which has no probe of
   * its own to share): this field probes for itself, as before.
   */
  availability?: TasteChipsAvailability;
  /**
   * Fires once, the moment this field itself learns `requestTasteChips` now answers "disabled"
   * (the flag flipping off mid-session) — ONLY when the caller supplied `availability` in the
   * first place: that caller is holding its own copy of the same answer to decide whether to show
   * surrounding chrome (CuisinesSection's Card), and needs to hear this field's newer finding or
   * that chrome keeps showing over a field that just hid itself (Sol BLOCK, verified). Unused when
   * `availability` is omitted — nothing outside this field depends on its state then.
   */
  onDisabled?: () => void;
}) {
  // Hidden until the server says the flag is on; "disabled"/"unknown" both render nothing (see the
  // module docblock). `availability`, when given, is read directly below rather than copied into
  // state, so there is nothing here to fall out of sync with the caller's own answer; `forcedOff`
  // is this field's OWN later finding (a "disabled" from `requestTasteChips`, the flag flipping off
  // mid-session) and overrides either source, since it is strictly newer information than either.
  const [selfProbed, setSelfProbed] = useState(false);
  const [forcedOff, setForcedOff] = useState(false);
  const enabled = !forcedOff && (availability !== undefined ? availability === "enabled" : selfProbed);
  const [text, setText] = useState("");
  const [checking, setChecking] = useState(false);
  const [suggestion, setSuggestion] = useState<TasteSuggestion | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());
  const pendingActionId = useRef<string | null>(null);
  const sequence = useRef(0);
  /** Onboarding only (D9 followup #2): the one action id, if any, that already got the bounded
   *  settings-sync retry below, so a user who taps Confirm again on the SAME tap (same actionId,
   *  e.g. after the retry itself failed) is shown the failure rather than retried forever. */
  const syncRetriedFor = useRef<string | null>(null);
  const feedback = useActionFeedback();

  useEffect(() => {
    // A caller-supplied answer is the single source of truth: nothing to probe separately.
    if (availability !== undefined) return;
    let live = true;
    // readTasteChipsEnabled can reject (an account change mid-read); swallow it the same way
    // CuisineStep's own useProfilePilot does -- a rejected probe just leaves the field hidden
    // rather than surfacing an unhandled rejection (verified finding).
    void readTasteChipsEnabled().then((result) => {
      if (live && result === "enabled") setSelfProbed(true);
    }, () => {});
    return () => { live = false; };
  }, [availability]);

  async function check(value: string) {
    const mySequence = ++sequence.current;
    setChecking(true);
    const answer = await requestTasteChips(value).catch(() => ({ ok: false, reason: "failed" }) as const);
    if (mySequence !== sequence.current) return; // superseded by a later blur
    setChecking(false);
    if (!answer.ok) {
      if (answer.reason === "disabled") { setForcedOff(true); onDisabled?.(); return; }
      setSuggestion(null);
      setFailed(true);
      return;
    }
    setFailed(false);
    setSuggestion(answer.suggestion);
    setPicked([]);
    pendingActionId.current = null;
  }

  function onBlur() {
    const value = text.trim();
    if (!value) {
      // Invalidate any in-flight check for the text just cleared, so its answer can never land
      // late and show (or fold away) chips for blank text (verified finding).
      sequence.current += 1;
      setChecking(false);
      setSuggestion(null);
      setFailed(false);
      return;
    }
    void check(value);
  }

  function toggle(option: Picked) {
    if (feedback.phase === "pending") return; // see SuggestedChips' `pending` prop
    pendingActionId.current = null; // a changed selection is a new confirm intent
    setPicked((prev) => {
      const id = pickedId(option);
      if (prev.some((p) => pickedId(p) === id)) return prev.filter((p) => pickedId(p) !== id);
      if (prev.length >= TASTE_PICK_MAX) return prev;
      return [...prev, option];
    });
  }

  /**
   * One confirm attempt, with the bounded onboarding-only retry (D9 followup #2): a 409
   * `settings_not_synced` means the account's settings row has not reached the server yet — the
   * onboarding step that mounts this field races its own first settings push, so the confirm can
   * land just ahead of it. Retried exactly once, for `source: "onboarding"` only, after a sync pass
   * that ACTUALLY LANDS (no throw, and nothing left in the outbox): the SAME action id and chips,
   * so the server answers its stored receipt rather than writing twice if the first attempt really
   * landed. A sync that fails or still has work queued never retries Confirm — resending the exact
   * request that just got `settings_not_synced` into a settings row that still has not reached the
   * server would only repeat the same 409 — so this surfaces that first outcome as a failure
   * instead (the user's own retry tap bounds it the same way a second 409 would). A second
   * `settings_not_synced` after a sync that did land (or anything else) is also shown as a
   * failure, never retried again.
   */
  async function attemptConfirm(request: TasteConfirmRequest, actionId: string): Promise<TasteConfirmResult> {
    const first = await confirmTasteChips(request);
    if (first.ok) return first.result;
    const settingsNotSynced = first.reason === "refused" && first.code === TASTE_CONFIRM_ERRORS.settingsNotSynced;
    if (source !== "onboarding" || !settingsNotSynced || syncRetriedFor.current === actionId) throw first;
    syncRetriedFor.current = actionId;
    const synced = await syncOnce(accountHandle()).then((result) => !result?.push?.failed, () => false);
    if (!synced) throw first;
    const second = await confirmTasteChips(request);
    if (second.ok) return second.result;
    throw second;
  }

  function confirm() {
    if (picked.length === 0) return;
    const actionId = pendingActionId.current ?? newTasteActionId();
    pendingActionId.current = actionId;
    const ids = picked.map(pickedId);
    const request: TasteConfirmRequest = {
      actionId,
      source,
      dislikes: picked.filter((p): p is Extract<Picked, { kind: "dislike" }> => p.kind === "dislike")
        .map((p) => p.key),
      cuisines: picked.filter((p): p is Extract<Picked, { kind: "cuisine" }> => p.kind === "cuisine")
        .map((p) => p.key),
    };
    const sent = attemptConfirm(request, actionId);
    sent.catch(() => {});
    // The server may answer `ok` while some requested chips were `present` already (a no-op) or
    // `capped` (the 50-dislike / 6-cuisine limit, written to neither) — only `added` is what Undo
    // can remove, and a capped chip was never saved, so neither the message nor the confirmed set
    // may just assume every requested chip landed (verified finding).
    void feedback.run(() => sent, { kind: "commit", failureMessage: writeFailureMessage })
      .then((result) => {
        if (!result.ok) return;
        pendingActionId.current = null;
        const addedIds = keysToIds(result.value.added);
        const settledIds = new Set([...addedIds, ...keysToIds(result.value.present)]);
        setConfirmed((prev) => new Set([...prev, ...settledIds]));
        setPicked((prev) => prev.filter((p) => !ids.includes(pickedId(p))));
        const cappedCount = result.value.capped.dislikes.length + result.value.capped.cuisines.length;
        const message = cappedCount > 0
          ? `Saved. ${cappedCount} ${cappedCount === 1 ? "wasn't" : "weren't"} added — the limit is reached.`
          : addedIds.length > 0 ? "Saved." : "Already set.";
        feedback.notify({
          tone: "success", message,
          action: addedIds.length > 0 ? { label: "Undo", action: () => undo(actionId, addedIds) } : undefined,
        });
      });
  }

  function undo(actionId: string, ids: string[]) {
    const sent = undoTasteChips(actionId).then((outcome) => {
      if (outcome.ok) return outcome.result;
      throw outcome;
    });
    sent.catch(() => {});
    void feedback.run(() => sent, {
      kind: "commit",
      // The control that started this (the toast's own "Undo" button) is gone once the toast
      // clears, so the confirmation needs a toast of its own ("notice") rather than relying on a
      // control to confirm in place.
      confirm: "notice",
      successMessage: "Removed.",
      failureMessage: writeFailureMessage,
    }).then((result) => {
      if (!result.ok) return;
      setConfirmed((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
    });
  }

  if (!enabled) return null;

  const field = (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-2">
        <span className="text-caption font-medium text-charcoal">A taste, in your own words</span>
        <input value={text} onChange={(event) => setText(event.target.value)} onBlur={onBlur}
          placeholder="e.g. I can&rsquo;t stand cilantro, or I grew up on Tex-Mex"
          className="well px-3 py-3 outline-none min-h-11 text-caption font-normal text-charcoal" />
      </label>
      {checking && <Thinking label="Reading what you wrote…" size="compact" />}
      {!checking && failed && (
        <p className="m-0 text-tiny font-light text-muted">No suggestions right now. Try again.</p>
      )}
      {!checking && suggestion?.route === "local" && <DietaryTextHint offer={suggestion.offer} />}
      {!checking && suggestion?.route === "send" && <>
        <SuggestedChips suggestion={suggestion} picked={picked} confirmed={confirmed}
          pending={feedback.phase === "pending"} onToggle={toggle} />
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" {...feedback.controlProps}
            disabled={feedback.controlProps.disabled || picked.length === 0}
            confirmLabel="Saved" onClick={confirm}>
            Confirm
          </Button>
          <span className="text-tiny font-light text-muted" aria-live="polite">
            {picked.length} of {TASTE_PICK_MAX} picked
          </span>
        </div>
      </>}
      <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
    </div>
  );

  if (!heading) return field;
  return (
    <div className="border-t border-hairline pt-4">
      <p className="m-0 mb-2 text-caption font-normal text-charcoal">{heading}</p>
      {field}
    </div>
  );
}
