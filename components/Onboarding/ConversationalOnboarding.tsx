"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "motion/react";
import Button from "@/components/ui/Button";
import SproutGuide, { type OnboardingPose } from "@/components/Onboarding/SproutGuide";
import OnboardingDock, { type OnboardingDockMode } from "@/components/Onboarding/dock/OnboardingDock";
import AllergyConditionGate, { type AllergySafetyAnswer } from "@/components/Onboarding/AllergyConditionGate";
import FallingFoodPile from "@/components/Onboarding/FallingFoodPile";
import FoodsTopPickChips from "@/components/Onboarding/FoodsTopPickChips";
import { pickForMeIds } from "@/components/Onboarding/FoodsStep";
import {
  effectiveBand, emptyFacts, firstMissingField, GoalPillRow, PlaybackSentence, SexChipRow,
  type Goal, type OnboardingFactKey,
} from "@/components/Onboarding/facts";
import RewardPlateCard, { type RewardPlateFood, type RewardPlateTargets }
  from "@/components/Onboarding/reward/RewardPlateCard";
import { useOnboardingFoodAccess } from "@/components/Onboarding/useOnboardingFoodAccess";
import { useStarterStep } from "@/components/Onboarding/useStarterStep";
import {
  applyFactsToSettings, buildOnboardingStateFromFacts, factsToPartialSettings, type FactsLike,
} from "@/components/Onboarding/v2/facts-bridge";
import { clearOnboardingDraft, loadOnboardingDraft, saveOnboardingDraft }
  from "@/components/Onboarding/v2/draft-store";
// Followups #18 (CONTRACT fu-backend, coord.md): the backend lane is adding this helper
// (lib/profile/onboarding-events-client.ts) — batches/queues events client-side, flushing on
// screen transition and page hide, posting to POST /api/onboarding/events. NOT on this branch yet
// — see the PR report's cross-branch-imports list. These are this call site's own expected names;
// adjust once the real CONTRACT line for the helper's exact exports posts.
import {
  flushOnboardingEventsNow, recordPilotArmAssigned, recordQuestionEntered, recordQuestionLeft,
  recordStepAbandoned, recordStepEntered, recordStepLeft,
} from "@/lib/profile/onboarding-events-client";
import type { OnboardingEventQuestion, OnboardingEventStep } from "@/lib/profile/onboarding-events";
import { dbFood } from "@/lib/food-db";
import { starterSelectionValid } from "@/lib/foods/starter";
import { starterProteinAvailability } from "@/lib/foods/starter-availability";
import { persistStarterSelection } from "@/lib/foods/starter-client";
import { mealCountFor } from "@/lib/plan";
import { accountHandle, onAccountGone, onAccountReady } from "@/lib/device/account";
import {
  CONSTRAINT_SAVE_WARNING, loadOnboardingSettings, mirroredOnboardedAt, ONBOARDING_SYNC_WARNING,
  persistCompletedOnboarding, persistSkippedOnboarding, retryOnboardingConstraints,
} from "@/lib/profile/onboarding-client";
import { buildCompletedSettings, missingProfileFields } from "@/lib/profile/onboarding-state";
import { flushOutboxNow } from "@/lib/sync/client";
import { INSTANT } from "@/lib/design/motion";
import type { Settings } from "@/lib/types";
import styles from "./ConversationalOnboarding.module.css";

/** VISUAL-SPEC.md §7 — see the identical constant and comment in `OnboardingDock.tsx`: one
 *  container-choreography vocabulary, shared verbatim by every generative container in this shell,
 *  dock modes and stream beats alike. */
const CONTAINER_EASE = [0.23, 1, 0.32, 1] as const;
const CONTAINER_ENTER = { duration: 0.24, ease: CONTAINER_EASE };
const CONTAINER_EXIT = { duration: 0.16, ease: CONTAINER_EASE };

/**
 * Onboarding v2's full-screen conversational shell (lane L2 shipped the shell/dock; lane L5 wires
 * the real safety/foods/reward content and the write path — BRIEF.md §4/§6). One scroller, Sprout
 * as the only progress indicator, one morphing dock — no page transitions between beats, ever.
 * Flag-gated by `app/onboarding/page.tsx` behind NEXT_PUBLIC_CHAT_ONBOARDING; the existing form
 * (`components/Onboarding/OnboardingFlow.tsx`) stays the fallback and stays reachable with the
 * flag off, and is also what `OnboardingErrorBoundary` falls back to if this shell throws.
 *
 * Reduced motion collapses every beat change to an instant swap (DESIGN.md fluid rule 11) — there
 * is deliberately no separate "reduced" branch of this component; every motion value here already
 * reads `reduce` and substitutes INSTANT.
 *
 * AI input scope: this whole flow is one declared scope, `{kind:"page", page:"onboarding"}`
 * (DESIGN.md §Motion, "AI input scope is declared per surface"). "onboarding" is not yet a
 * registered `CoachPage` (`lib/coach/types.ts`'s `COACH_PAGES`) — that is backend territory this
 * lane does not own — so `ONBOARDING_SCOPE` below is declarative documentation for whichever lane
 * wires the real coach-turn call, not a `ChatScope` value yet. See coord.md UI-NEEDS.
 */
export const ONBOARDING_SCOPE = { kind: "page", page: "onboarding" } as const;

/**
 * The five beats this shell knows about today. "opener" ships a working default (goal pills) so
 * the shell is a complete, usable flow on its own; "facts" renders a slot if lane 3 has landed,
 * else a clearly-labelled placeholder a reviewer can tell apart from real content. Safety, foods
 * and the reward beat default to real content (lane 4's cards, this lane's own reward card and
 * write path) unless a caller overrides the slot — see `ConversationalOnboardingSlots`.
 */
export type OnboardingBeat = "opener" | "facts" | "safety" | "foods" | "reward";

/** VISUAL-SPEC.md §2's hero-Sprout table, mapped onto this shell's five beats. "facts" is the one
 *  row the table itself splits in two — "Facts sentence playback" (`thinking`) vs. "Gap-fill
 *  prompt, one missing fact" (`pointing`) — both of which this shell renders as the same "facts"
 *  beat; `guidePose` below (not this static table) picks between them per the current render, via
 *  `PlaybackSentence`'s own `firstMissingField`. §2 also calls for mirroring `pointing` with
 *  `scaleX(-1)` when its target sits to Sprout's LEFT: this shell's layout (VISUAL-SPEC.md §1, the
 *  `.guide` stage always top-center with the beat's card centered below it, never beside Sprout)
 *  never puts a target to either side — polish pass (2026-10-07), checked and intentionally not
 *  applied here; it only matters for a side-by-side layout this shell doesn't have. */
const BEAT_POSE: Record<OnboardingBeat, OnboardingPose> = {
  opener: "wave", facts: "thinking", safety: "content", foods: "content", reward: "joyful",
};
/** VISUAL-SPEC.md §2's three large-Sprout sizes (96/120/140/168) — "Opener/greeting" and "Reward
 *  plate reveal" are the two rows that get a size other than the 96px baseline. */
const BEAT_SIZE: Record<OnboardingBeat, number> = {
  opener: 168, facts: 96, safety: 96, foods: 96, reward: 140,
};
const BEAT_LINE: Record<OnboardingBeat, string> = {
  opener: "Sprout is listening for your goal.",
  facts: "Sprout is checking what it heard.",
  safety: "Sprout is waiting for anything you must never eat.",
  foods: "Sprout is watching for what you love.",
  reward: "Sprout is holding up tomorrow's breakfast.",
};
/** Every beat's own card now owns its primary action directly (`GoalPillRow`'s pills,
 *  `PlaybackSentence`'s own "That's me", `AllergyConditionGate`'s "No, nothing") — the dock's
 *  "chips" mode with an empty row is this shell's one way to render an otherwise-idle glass bar
 *  rather than inventing a fifth, unused mode. Only "foods" (the escape chip) and "reward" (the
 *  dock's own confirm) still drive a real dock control. */
const BEAT_DOCK: Record<OnboardingBeat, OnboardingDockMode> = {
  opener: "chips", facts: "chips", safety: "chips", foods: "game", reward: "confirm",
};

/** Followups #18: this shell's five beats, mapped onto the W15 event log's own fixed step
 *  vocabulary (`ONBOARDING_EVENT_STEPS`, which also has a sixth, "done", this shell reaches only
 *  on a completed finish — never a beat of its own). "safety" is named "allergy" there, matching
 *  what that beat actually asks. */
const BEAT_STEP: Record<OnboardingBeat, OnboardingEventStep> = {
  opener: "intro", facts: "facts", safety: "allergy", foods: "foods", reward: "reward",
};

/** Clear extension points for a caller that wants to render something other than this lane's own
 *  default (tests, mainly): each slot replaces this beat's default content, with no change to the
 *  beats around it. */
export type ConversationalOnboardingSlots = {
  /** L3: the playback-sentence card (goal/sex/birth-year/height/weight, one "That's me" tap). */
  factsSentence?: ReactNode;
  /** L4: the allergy/condition card ("No, nothing" as the largest chip). Defaults to
   *  `AllergyConditionGate`, wired to this shell's own safety state and ONB2-RULE-REREAD. */
  allergyCard?: ReactNode;
  /** L4: the falling-food game (legacy accounts) or the pilot/open-world top-pick chips. Defaults
   *  to the real card, branched on the account's own `foodAccess.status`. */
  foodGame?: ReactNode;
  /** The composed "tomorrow's breakfast" plate, numbers behind "See the numbers". Defaults to
   *  `RewardPlateCard`, fed this lane's own preview-target computation. */
  plateReward?: ReactNode;
};

function Placeholder({ label }: { label: string }) {
  return <p role="status" className="text-center text-caption text-muted">{label}</p>;
}

const NUMBER_FIELD_LABEL: Record<"heightCm" | "weightKg", string> = {
  heightCm: "Height (cm)", weightKg: "Weight (kg)",
};
// Same bounds `lib/profile/onboarding-state.ts`'s own `finiteInRange`/`parsedWeightKg` enforce
// (unedited) — GPT-6 Sol round-1 BLOCK: this editor accepted any positive number, including ones
// the completion gate would later silently reject (`finiteInRange`/`parsedWeightKg` return `null`
// outside these ranges, which reads back as "still missing", not an error the user ever sees).
const NUMBER_FIELD_RANGE: Record<"heightCm" | "weightKg", { min: number; max: number }> = {
  heightCm: { min: 50, max: 260 }, weightKg: { min: 20, max: 400 },
};

/**
 * Lane 3 (facts flow) ships `GoalPillRow`/`SexChipRow`/`BirthYearStepper` — this lane's own
 * minimal stand-in for the two remaining required fields, since no dedicated height/weight
 * picker landed with it. A plain labelled number field, not the legacy form's unit-aware
 * stepper: a known, documented simplification (QA-L5.md), not a silently skipped field — the
 * value still writes to the same `heightCm`/`weightKg` facts either way.
 */
function NumberFieldEditor({ field, value, onSave }: {
  field: "heightCm" | "weightKg"; value: number | undefined; onSave: (value: number) => void;
}) {
  const [text, setText] = useState(value !== undefined ? String(value) : "");
  const parsed = Number(text);
  const { min, max } = NUMBER_FIELD_RANGE[field];
  const valid = text.trim() !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max;
  return <form className="flex items-end gap-2"
    onSubmit={(event) => { event.preventDefault(); if (valid) onSave(parsed); }}>
    <label className="flex flex-col gap-1 text-caption text-graphite">
      {NUMBER_FIELD_LABEL[field]}
      <input type="number" inputMode="decimal" value={text} min={min} max={max}
        onChange={(event) => setText(event.target.value)}
        className="matte-reset well min-h-11 rounded-[12px] px-3 text-body text-charcoal" />
      {text.trim() !== "" && !valid && <span role="alert" className="text-tiny text-alert">
        Must be between {min} and {max}.
      </span>}
    </label>
    <Button type="submit" variant="primary" size="sm" disabled={!valid}>Save</Button>
  </form>;
}

/** One keyed beat's stream content: while it is the one LEAVING, it goes `inert` and gives up focus
 *  at once (Sol review — the same fix as the dock's own mode layers), so a departing card is never
 *  still reachable, and the overlap never shifts scroll under a control someone is about to tap. */
function BeatLayer({ reduce, children }: { reduce: boolean; children: ReactNode }) {
  const present = useIsPresent();
  const self = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (present) return;
    if (self.current?.contains(document.activeElement)) (document.activeElement as HTMLElement)?.blur();
  }, [present]);
  return <motion.div ref={self} inert={!present} aria-hidden={present ? undefined : true}
    className="flex w-full flex-col items-center gap-4"
    initial={reduce ? false : { opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }}
    exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, scale: 0.97, transition: CONTAINER_EXIT }}
    transition={reduce ? INSTANT : CONTAINER_ENTER}>
    {children}
  </motion.div>;
}

const ROLE_ORDER = ["protein", "carb", "fat"] as const;

/** `PlaybackSentence.tsx`'s own `REQUIRED_FIELDS` (not exported — mirrored here, same five keys
 *  its module doc names: birth year, sex, height, weight, goal). */
const REQUIRED_FACT_KEYS = ["goal", "sex", "birthYear", "heightCm", "weightKg"] as const;

/** GPT-6 Sol round-2 BLOCK: `firstMissingField` only flags a field whose band is "empty" — a
 *  ghost-confidence birth year (the seeded guess `openFieldEditor` plants before it is nudged or
 *  explicitly confirmed) passes that check without ever being confirmed. "That's me" must require
 *  every required field at HIGH confidence, not merely "not blank". */
function allRequiredFactsConfirmed(facts: FactsLike): boolean {
  return REQUIRED_FACT_KEYS.every((key) => effectiveBand(facts, key) === "high");
}

/** GPT-6 Sol round-3 BLOCK: the draft used to snapshot every SET field regardless of confidence
 *  — a seeded-but-never-confirmed ghost birth year got saved the same as a real answer. On resume
 *  every restored field is stamped confidence `1` (deliberately — see that effect's own comment),
 *  so a ghost value saved this way came back as if it had been confirmed, letting `allRequiredFactsConfirmed`
 *  wave it through "That's me" with no actual confirmation ever having happened. Only a field
 *  already at HIGH confidence is worth remembering across a reload; a still-ghost one should be
 *  asked (or re-seeded) again next session, not silently promoted by surviving a reload. */
function confirmedFactsOnly(facts: FactsLike): FactsLike {
  const keys = Object.keys(facts)
    .filter((key) => key !== "confidence") as OnboardingFactKey[];
  const highConfidenceKeys = keys.filter((key) => effectiveBand(facts, key) === "high");
  const kept = Object.fromEntries(highConfidenceKeys.map((key) => [key, facts[key]]));
  return { ...kept, confidence: {} } as FactsLike;
}

export default function ConversationalOnboarding({ slots = {}, onSkip, onComplete, onAllergyAnswer }: {
  slots?: ConversationalOnboardingSlots;
  /** Overrides the shell's own exit. Defaults to the account's real skip path (below) so the route
   *  always has a working way out, flag on or off. */
  onSkip?: () => void;
  /** Overrides the shell's own "Use this plan" write. Defaults to the real write path
   *  (`persistCompletedOnboarding` + the starter-food write, the same functions
   *  `OnboardingFlow.tsx` calls) once every required fact is confirmed; until then — or without a
   *  real account to write for — a confirm here does the same honest thing Skip does rather than
   *  looping on the same beat or fabricating a profile from nothing. */
  onComplete?: () => void;
  /** L4: told every safety-chip key tapped, including one that is not "none". */
  onAllergyAnswer?: (key: string) => void;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const router = useRouter();
  const [beat, setBeat] = useState<OnboardingBeat>("opener");
  const [facts, setFacts] = useState<FactsLike>(emptyFacts());
  const [editingField, setEditingField] = useState<OnboardingFactKey | null>(null);
  const [base, setBase] = useState<Settings | null>(null);
  const [safety, setSafety] = useState<{ confirmed: boolean; answer: AllergySafetyAnswer | null }>(
    { confirmed: false, answer: null });
  const [showNumbers, setShowNumbers] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const leaving = useRef(false);
  /** GPT-6 Sol round-1 BLOCK: without these, a retry after a failure in a LATER step (the starter
   *  write, the drain) re-ran `persistCompletedOnboarding` too — it is not safe to call twice (it
   *  mints a new target revision each time), the same reason `OnboardingFlow.tsx`'s own `savePlan`
   *  tracks a `completed` flag before ever touching the drain. `profileWritten` covers the
   *  settings/target-revision half specifically; `constraintsSaved` tracks the separate
   *  `constraint_profiles` write `persistCompletedOnboarding` can fail independently (round-2
   *  BLOCK: the original fix only flipped `profileWritten` AFTER checking `constraintsSaved`, so
   *  a constraints-only failure still re-ran the whole function, including the already-succeeded
   *  settings write, on retry — `OnboardingFlow.tsx`'s own `savePlan` retries constraints alone
   *  via `retryOnboardingConstraints`, which this now does too). */
  const profileWritten = useRef(false);
  const constraintsSaved = useRef(false);
  const foodsWritten = useRef(false);
  /** Gates the draft-save effect below until the resume-draft read (or its failure) has actually
   *  settled — see that effect's own comment for why. */
  const [draftChecked, setDraftChecked] = useState(false);

  /**
   * Followups #18: the W15 onboarding event log. Privacy-safe by construction — every call below
   * names a step or question from the fixed enum (`lib/profile/onboarding-events.ts`), never an
   * answer or free text. `pilotArmSent` guards the one-per-session `pilot_arm_assigned` emit;
   * `stepEnteredRef` times the current beat (so its `step_left`/`step_abandoned` carries a real
   * duration); `activeQuestionRef` is the single "question currently on screen", closed out by
   * `leaveQuestion` whichever way it ends (answered, or the beat moves on without it — the fixed
   * enum does not distinguish, by design: no answer content ever reaches this log either way);
   * `finishedRef` tells the unmount cleanup a completed/skipped exit from an abandoned one, so a
   * normal finish never double-counts as both.
   *
   * There is no real pilot-arm randomization yet (W15 itself, still ahead) — every session reports
   * "control" as a documented placeholder so the event stream exists before that lands; nothing
   * here claims to be running a live A/B.
   */
  const pilotArmSent = useRef(false);
  const stepEnteredRef = useRef<{ step: OnboardingEventStep; at: number } | null>(null);
  const activeQuestionRef = useRef<{ question: OnboardingEventQuestion; at: number } | null>(null);
  const finishedRef = useRef(false);

  // useCallback with an empty dependency array (only refs and imported functions inside, both
  // stable) so these stay the same function identity across renders — plain function declarations
  // here would otherwise make every effect below that lists them re-run on every render.
  const leaveQuestion = useCallback(() => {
    const open = activeQuestionRef.current;
    if (!open) return;
    activeQuestionRef.current = null;
    recordQuestionLeft(open.question, Date.now() - open.at);
  }, []);
  const enterQuestion = useCallback((question: OnboardingEventQuestion) => {
    leaveQuestion();
    activeQuestionRef.current = { question, at: Date.now() };
    recordQuestionEntered(question);
  }, [leaveQuestion]);

  function advance(next: OnboardingBeat) {
    setBeat(next);
  }

  /** Followups #18: a real finish (skip or "Use this plan"), called right before the navigate
   *  away — closes the current step as a normal `step_left` (never `step_abandoned`), marks
   *  "done", flips `finishedRef` so the unmount cleanup does not also fire an abandon for the same
   *  exit, and flushes at once rather than leaving the last batch to the debounce on a page that is
   *  about to unload. */
  const finishOnboardingEvents = useCallback(() => {
    leaveQuestion();
    const open = stepEnteredRef.current;
    if (open) recordStepLeft(open.step, Date.now() - open.at);
    stepEnteredRef.current = null;
    recordStepEntered("done");
    finishedRef.current = true;
    flushOnboardingEventsNow();
  }, [leaveQuestion]);

  /** Loads the account's own settings (the base every write merges onto, same as
   *  `OnboardingFlow`'s own `base`), then checks for a resumable draft — a reload mid-setup should
   *  not send the account back to a blank opener (requirement: resume after reload). Best-effort:
   *  a missing or unreadable draft just means "start from the opener," never an onboarding error.
   *
   *  Driven by `onAccountReady`, not a bare mount-only effect (GPT-6 Sol round-2 BLOCK): this
   *  shell used to load once on mount and never again, so if the bound account changed while it
   *  stayed mounted (a switch, not a reload), every piece of this shell's local state — facts,
   *  beat, safety, the write guards — kept belonging to the PREVIOUS account. `onAccountReady`
   *  fires at once for whichever account is already bound, and again on every later switch; the
   *  `epoch` on each handle de-duplicates redundant re-fires for the same bind. Every reset below
   *  happens BEFORE the new account's own load starts, so a slow load can never show the previous
   *  account's state in the meantime. */
  useEffect(() => {
    let live = true;
    let handledEpoch = -1;
    const unreadyFn = onAccountReady((h) => {
      if (h.epoch === handledEpoch) return;
      handledEpoch = h.epoch;
      setBase(null);
      setFacts(emptyFacts());
      setBeat("opener");
      setSafety({ confirmed: false, answer: null });
      setEditingField(null);
      setDraftChecked(false);
      profileWritten.current = false;
      foodsWritten.current = false;
      leaving.current = false;
      // A switched account is a fresh onboarding session for the event log too.
      pilotArmSent.current = false;
      stepEnteredRef.current = null;
      activeQuestionRef.current = null;
      finishedRef.current = false;
      void (async () => {
        let settings: Settings;
        try {
          settings = await loadOnboardingSettings();
        } catch {
          // GPT-6 Sol round-3 WARN: an unhandled rejection here (loadOnboardingSettings itself
          // already fails soft to a local cache, lib/profile/onboarding-client.ts unedited, but
          // defend this call site too) must not escape this async IIFE as an unhandled rejection.
          return;
        }
        if (!live || h.epoch !== handledEpoch) return;
        setBase(settings);
        try {
          const draft = await loadOnboardingDraft();
          if (!live || h.epoch !== handledEpoch || !draft) return;
          const { goal, sex, birthYear, heightCm, weightKg, activityLevel } = draft.settings;
          // GPT-6 Sol round-1 BLOCK: restoring a value with no matching `confidence` entry left
          // `PlaybackSentence` rendering it as an empty gap chip (`effectiveBand` reads
          // confidence, not bare presence) — a resumed session looked exactly like a blank one.
          // A resumed value is exactly as confirmed as it was when it was saved; restore it at
          // high confidence, the same as every other direct-answer path in this shell. Every
          // field's confidence entry is merged into ONE object (not built independently per
          // field — an earlier draft of this fix had each field spread `current.confidence` on
          // its own, so only the last field in the object literal actually kept its bump).
          const restoredFields: Partial<FactsLike> = {
            ...(goal ? { goal } : {}),
            ...(sex ? { sex } : {}),
            ...(typeof birthYear === "number" ? { birthYear } : {}),
            ...(typeof heightCm === "number" ? { heightCm } : {}),
            ...(typeof weightKg === "number" ? { weightKg } : {}),
            ...(activityLevel ? { activity: activityLevel } : {}),
          };
          const restoredConfidence = Object.fromEntries(
            Object.keys(restoredFields).map((key) => [key, 1]));
          setFacts((current) => ({
            ...current, ...restoredFields,
            confidence: { ...current.confidence, ...restoredConfidence },
          }));
          // Never resume straight into or past the safety beat (BRIEF.md: allergy confirmation
          // is asked every time, not cached) — only "facts" is restorable; anything past it
          // collapses back to "facts" so the account re-answers the allergy/condition question.
          if (draft.beat && draft.beat !== "opener") setBeat("facts");
        } finally {
          if (live && h.epoch === handledEpoch) setDraftChecked(true);
        }
      })();
    });
    // GPT-6 Sol round-3 BLOCK: this used to clear only `base` — a draft/settings read already in
    // flight for the DEPARTING account could still resolve after `onAccountGone` fired (nothing
    // stopped it) and repopulate `facts`/`beat` with that account's answers for whatever brief
    // window existed before the next account's `onAccountReady` arrived. Resetting `handledEpoch`
    // to a sentinel no real epoch can match makes every `h.epoch !== handledEpoch` guard above
    // reject that in-flight read's own callback, on top of clearing every piece of local state
    // here immediately — the same full reset `onAccountReady` does, not just `base`.
    const ungoneFn = onAccountGone(() => {
      if (!live) return;
      handledEpoch = -1;
      setBase(null);
      setFacts(emptyFacts());
      setBeat("opener");
      setSafety({ confirmed: false, answer: null });
      setEditingField(null);
      setDraftChecked(false);
      profileWritten.current = false;
      foodsWritten.current = false;
      leaving.current = false;
      pilotArmSent.current = false;
      stepEnteredRef.current = null;
      activeQuestionRef.current = null;
      finishedRef.current = false;
    });
    return () => { live = false; unreadyFn(); ungoneFn(); };
  }, []);

  /** Followups #18: one `pilot_arm_assigned` per bound account, the moment its settings load (the
   *  same signal the rest of this shell treats as "a real account is here"). See this field's own
   *  declaration above for why "control" is a documented placeholder, not a live assignment. */
  useEffect(() => {
    if (!base || pilotArmSent.current) return;
    pilotArmSent.current = true;
    recordPilotArmAssigned("control");
  }, [base]);

  /** Followups #18: one step_entered/step_left pair per beat change, timed against the moment this
   *  effect last saw a different step. Closes out any question still open in the departing beat in
   *  the same tick (`leaveQuestion`), so a question never straddles two steps. */
  useEffect(() => {
    const step = BEAT_STEP[beat];
    const previous = stepEnteredRef.current;
    if (previous && previous.step === step) return;
    if (previous) {
      recordStepLeft(previous.step, Date.now() - previous.at);
      leaveQuestion();
    }
    stepEnteredRef.current = { step, at: Date.now() };
    recordStepEntered(step);
    // "opener" is the goal question and nothing else — there is no separate editor-open moment to
    // hook, the way facts' other fields have (`openFieldEditor`).
    if (step === "intro") enterQuestion("goal");
  }, [beat, enterQuestion, leaveQuestion]);

  /** Followups #18: a session that ends by closing the tab, navigating away or an uncaught error —
   *  never through the finish/skip paths below, which already flip `finishedRef` first — is the
   *  one case `step_abandoned` exists for. */
  useEffect(() => () => {
    if (finishedRef.current) return;
    leaveQuestion();
    const open = stepEnteredRef.current;
    if (open) recordStepAbandoned(open.step, Date.now() - open.at);
    flushOnboardingEventsNow();
  }, [leaveQuestion]);

  /** Best-effort draft save on every confirmed change — see `draft-store.ts`'s own fail-soft
   *  contract; a failed save here never surfaces to the user. Gated on `draftChecked` so this
   *  effect can never fire with the fresh-mount's still-empty `facts`/`beat` before the resume
   *  read above has had a chance to apply a saved draft onto them — otherwise this save, racing
   *  the resume read's own IndexedDB transaction, could win and overwrite a real draft with an
   *  empty one, permanently losing the account's answers on reload. Only CONFIRMED fields are
   *  snapshotted (`confirmedFactsOnly`, GPT-6 Sol round-3 BLOCK) — a still-ghost value (a seeded
   *  birth year nobody has nudged or confirmed yet) must not survive a reload as if it had been. */
  useEffect(() => {
    if (!base || !draftChecked) return;
    void saveOnboardingDraft({ beat, settings: factsToPartialSettings(confirmedFactsOnly(facts)) });
  }, [base, draftChecked, beat, facts]);

  const settings = useMemo(() => (base ? applyFactsToSettings(base, facts) : null), [base, facts]);
  const onboardingState = useMemo(
    () => (settings ? buildOnboardingStateFromFacts(settings, facts) : null), [settings, facts]);

  const foodAccess = useOnboardingFoodAccess(onboardingState);
  // GPT-6 Sol round-1 BLOCK: `useStarterStep` was only enabled for "legacy", so a pilot account's
  // `FoodsTopPickChips` (which reads `starter.choices`) always saw `null` — an empty picker and a
  // "Sprout, pick for me" that could never select anything. Pilot accounts need the same
  // safety-filtered starter list this shell now shows them.
  const starter = useStarterStep(onboardingState,
    foodAccess.status === "legacy" || foodAccess.status === "pilot");

  const selectedStarterIds = Object.entries(starter.marks)
    .filter(([, mark]) => mark === "eats").map(([id]) => id);
  const starterSelectionReady = !!starter.choices
    && starterSelectionValid(selectedStarterIds, starter.choices);
  // GPT-6 Sol round-1 BLOCK: the legacy form also requires `starterProteinAvailability(...).ready`
  // — enough distinct proteins selected to cover every planned meal without repeating one, not
  // just the flat "≥2 per role" `starterSelectionValid` checks — before it will let a legacy
  // account save. This shell's own gate was missing that second check.
  const incompleteForPlan = !onboardingState || missingProfileFields(onboardingState).length > 0;
  // GPT-6 Sol round-2 WARN: an unexpected `buildCompletedSettings` error used to fall back to
  // `plannedCount = 0`, which makes `starterProteinAvailability(..., 0).ready` trivially true
  // (`selected >= 0`) — an error state silently looked exactly like "nothing to plan for, so
  // anything passes" instead of "not ready". `plannedCountFailed` keeps that distinction and
  // `planReady` below treats a failed derivation as NOT ready, fail-closed.
  const [plannedCountFailed, plannedCount] = (() => {
    if (incompleteForPlan || !settings || !onboardingState) return [false, 0] as const;
    try {
      return [false, mealCountFor(buildCompletedSettings(settings, onboardingState, new Date()))] as const;
    } catch {
      return [true, 0] as const;
    }
  })();
  const proteinAvailability = starter.choices
    ? starterProteinAvailability(starter.marks, starter.choices, plannedCount) : null;
  const planReady = settings !== null && onboardingState !== null
    && missingProfileFields(onboardingState).length === 0 && !plannedCountFailed
    && (
      // GPT-6 Sol round-2 BLOCK: pilot used to need no verified food state at all — reaching
      // "Use this plan" with `starter.choices` still `null` (never loaded, or a failed reread)
      // was possible. Pilot now needs the same "a safety-filtered list exists and the current
      // marks are valid against it" floor legacy already had.
      (foodAccess.status === "pilot" && starter.choices !== null && starterSelectionReady)
      || (foodAccess.status === "legacy" && starterSelectionReady
        && proteinAvailability?.ready === true)
    );

  /** A pure preview of tomorrow's targets — never writes anything. `null` while a required fact
   *  is still missing (every account starts here until the facts beat, lane 3, is answered); the
   *  reward card renders its own "preparing" state for that, not a crash. */
  const targets = useMemo<RewardPlateTargets | null>(() => {
    if (!settings || !onboardingState) return null;
    if (missingProfileFields(onboardingState).length > 0) return null;
    try {
      const completed = buildCompletedSettings(settings, onboardingState, new Date());
      const profile = completed.activeTargetProfile;
      return profile ? { training: profile.training, rest: profile.rest } : null;
    } catch {
      return null;
    }
  }, [settings, onboardingState]);

  const lovedFoods = useMemo<RewardPlateFood[]>(() => {
    if (!starter.choices) return [];
    const foods: RewardPlateFood[] = [];
    for (const role of ROLE_ORDER) {
      const pick = starter.choices.find((item) => item.role === role && starter.marks[item.id] === "eats");
      if (pick) foods.push({ id: pick.id, name: dbFood(pick.id)?.name ?? pick.id, role });
    }
    return foods;
  }, [starter.choices, starter.marks]);

  /** "That's me" — PlaybackSentence's own confirm only requires ONE required field at high
   *  confidence to render at all (`hasAnyHighConfidence`, not "every" field); without a gate here
   *  a tap right after picking just the goal would advance straight past sex/birth year/height/
   *  weight to a reward beat with nothing left to answer them on (GPT-6 Sol round-1 BLOCK). Round
   *  2 found the first gate (`firstMissingField(facts) === null`, "not blank") still let a
   *  ghost-confidence seeded birth year through unconfirmed — require every required field at
   *  HIGH confidence instead. */
  function confirmFacts() {
    if (allRequiredFactsConfirmed(facts)) advance("safety");
  }

  /** Followups #18: closes out the open question only if it is really the one this answer ends —
   *  `confirmGhostField` reaches here for any ghost-confidence field, not only one this shell ever
   *  opened an editor (and so a tracked question) for. */
  function leaveQuestionFor(key: OnboardingFactKey) {
    if (activeQuestionRef.current?.question === key) leaveQuestion();
  }

  function pickGoal(key: Goal) {
    // A direct tap is a confirmed, high-confidence answer — never a ghost guess (BRIEF.md §2:
    // "no safe default exists for this field... a tap is the only way this resolves").
    setFacts((current) => ({ ...current, goal: key, confidence: { ...current.confidence, goal: 1 } }));
    leaveQuestionFor("goal");
    advance("facts");
  }

  /** A direct tap on a chip-based field (goal/sex) — same "confirmed, high-confidence, never a
   *  guess" rule `pickGoal` documents, generalised for any editor this beat opens. */
  function setFieldValue<K extends OnboardingFactKey>(key: K, value: NonNullable<FactsLike[K]>) {
    setFacts((current) => ({ ...current, [key]: value, confidence: { ...current.confidence, [key]: 1 } }));
    setEditingField(null);
    leaveQuestionFor(key);
  }

  /** The facts sentence's gap-chip tap (BRIEF.md §4: "gaps point, they don't ask"). Birth year is
   *  the one field `PlaybackSentence` edits entirely in-place (its own inline stepper) once it has
   *  ANY value — tapping its empty gap seeds a plausible starting year at ghost confidence (never
   *  "high": it is a seed, not a confirmed answer) so the stepper appears for the user to nudge or
   *  confirm; every other field opens this beat's own editor panel below the sentence. */
  function openFieldEditor(key: OnboardingFactKey) {
    if (key === "birthYear") {
      const seedYear = new Date().getUTCFullYear() - 25;
      setFacts((current) => ({
        ...current, birthYear: seedYear, confidence: { ...current.confidence, birthYear: 0.6 },
      }));
      enterQuestion("birthYear");
      return;
    }
    setEditingField(key);
    enterQuestion(key);
  }

  /** A ghost chip's "Confirm" tap — the value is already there, this only raises it to high
   *  confidence; birth year's own ghost "Confirm" chip (next to its stepper) reaches this too. */
  function confirmGhostField(key: OnboardingFactKey) {
    setFacts((current) => ({ ...current, confidence: { ...current.confidence, [key]: 1 } }));
    leaveQuestionFor(key);
  }

  function nudgeBirthYear(birthYear: number) {
    setFacts((current) => ({
      ...current, birthYear, confidence: { ...current.confidence, birthYear: 0.6 },
    }));
  }

  function confirmNoAllergy() {
    setSafety({ confirmed: true, answer: "none" });
    onAllergyAnswer?.("none");
    advance("foods");
  }
  function addAllergyRule() {
    setSafety((current) => ({ ...current, answer: "rule" }));
    onAllergyAnswer?.("rule");
  }
  /** "I'm done — continue" after opening the rule editor or clinician guidance. ONB2-RULE-REREAD
   *  discipline, one level up from `useStarterStep`'s own fix: re-read the account's rules before
   *  trusting the starter list this beat is about to show, so a rule saved just now can never
   *  leave an already-excluded food still offered to tap. */
  async function allergyRulesConfirmed() {
    const freshChoices = await starter.reread();
    // GPT-6 Sol round-2 BLOCK: a failed reread (offline, a dropped connection) was silently
    // ignored — the beat still advanced to Foods on whatever list was already rendered, which
    // could predate the rule this editor was just used to save. Never advance to food UI without
    // a confirmed-fresh list.
    if (!freshChoices) {
      setLeaveError("Couldn’t verify your food rules. Try again.");
      return;
    }
    setSafety((current) => ({ confirmed: true, answer: current.answer ?? "rule" }));
    advance("foods");
  }

  function pickForMe() {
    for (const id of pickForMeIds(starter.choices ?? [], starter.marks)) starter.mark(id, "eats");
    advance("reward");
  }

  /** The account's real skip path (`lib/profile/onboarding-client.ts`, the same functions and the
   *  same gate `OnboardingFlow.tsx`'s own `skip()`/`settingsAccepted()` use): queues the skip stamp,
   *  then only leaves once BOTH halves of that gate hold — the drain (the queued write actually
   *  reached the server) and the mirror (the device's own row really carries the stamp). A queued-
   *  only write is what sends a "finished" account back to onboarding on its next load. */
  const leaveOnboarding = useCallback(async () => {
    if (leaving.current) return;
    leaving.current = true;
    setLeaveError(null);
    try {
      const accountSettings = base ?? await loadOnboardingSettings();
      await persistSkippedOnboarding(accountSettings);
      const drained = await flushOutboxNow(accountHandle());
      const mirrored = drained ? await mirroredOnboardedAt() : null;
      if (mirrored === null) throw new Error(ONBOARDING_SYNC_WARNING);
      await clearOnboardingDraft();
      finishOnboardingEvents();
      router.replace("/");
    } catch {
      setLeaveError(ONBOARDING_SYNC_WARNING);
      leaving.current = false;
    }
  }, [router, base, finishOnboardingEvents]);

  /** "Use this plan": the same write path `OnboardingFlow.tsx`'s `savePlan()` drives —
   *  `persistCompletedOnboarding` (mints the target revision, writes `constraint_profiles`), then
   *  the starter-food write for a legacy account (re-read first, per ONB2-RULE-REREAD), then the
   *  same drain-and-mirror gate `leaveOnboarding` uses before it ever navigates away. */
  const savePlanAndFinish = useCallback(async () => {
    if (leaving.current) return;
    if (!settings || !onboardingState) { setLeaveError(ONBOARDING_SYNC_WARNING); return; }
    leaving.current = true;
    setSaving(true);
    setLeaveError(null);
    try {
      // GPT-6 Sol round-2 BLOCK: the settings/target-revision write and the separate
      // `constraint_profiles` write inside `persistCompletedOnboarding` can fail independently.
      // Marking `profileWritten` only AFTER checking `constraintsSaved` meant a constraints-only
      // failure still re-ran the WHOLE function — including the settings write that had already
      // succeeded — on retry. `profileWritten` now flips as soon as the call returns at all;
      // `constraintsSaved` tracks its own half and retries narrowly via
      // `retryOnboardingConstraints`, the same split `OnboardingFlow.tsx`'s own `savePlan` uses.
      if (!profileWritten.current) {
        const result = await persistCompletedOnboarding(settings, onboardingState);
        profileWritten.current = true;
        constraintsSaved.current = result.constraintsSaved;
      }
      if (!constraintsSaved.current) {
        if (!await retryOnboardingConstraints(onboardingState.flags)) {
          throw new Error(CONSTRAINT_SAVE_WARNING);
        }
        constraintsSaved.current = true;
      }
      // GPT-6 Sol round-2 BLOCK: pilot accounts could mark foods "loved" and see them on the
      // reward plate, but this write only ever ran for "legacy" — the selection was silently
      // never saved. Also re-validates the FRESH (post-reread) choices before writing, not just
      // the ones `planReady` was computed from a moment earlier — a rule saved in the gap between
      // opening "Use this plan" and this write finishing could otherwise still let a selection
      // through that no longer actually satisfies the two-per-role or protein-count floor.
      if ((foodAccess.status === "legacy" || foodAccess.status === "pilot") && !foodsWritten.current) {
        const freshChoices = await starter.reread();
        if (!freshChoices) {
          throw new Error("Couldn’t verify your food rules. Go back to Foods and retry.");
        }
        const freshSelectedIds = Object.entries(starter.marks)
          .filter(([, mark]) => mark === "eats").map(([id]) => id);
        if (!starterSelectionValid(freshSelectedIds, freshChoices)) {
          throw new Error("A rule just changed what's safe to eat — go back to Foods and choose again.");
        }
        if (foodAccess.status === "legacy"
          && !starterProteinAvailability(starter.marks, freshChoices, plannedCount).ready) {
          throw new Error("A rule just changed what's safe to eat — go back to Foods and choose again.");
        }
        await persistStarterSelection(starter.marks, freshChoices);
        foodsWritten.current = true;
      }
      const drained = await flushOutboxNow(accountHandle());
      const mirrored = drained ? await mirroredOnboardedAt() : null;
      if (mirrored === null) throw new Error(ONBOARDING_SYNC_WARNING);
      await clearOnboardingDraft();
      finishOnboardingEvents();
      router.replace("/");
    } catch (error) {
      setLeaveError(error instanceof Error ? error.message : "Couldn’t save your plan. Try again.");
      leaving.current = false;
      setSaving(false);
    }
  }, [router, settings, onboardingState, foodAccess.status, starter, plannedCount, finishOnboardingEvents]);

  const handleSkip = onSkip ?? (() => void leaveOnboarding());
  const handleComplete = onComplete
    ?? (() => { if (planReady) void savePlanAndFinish(); else void leaveOnboarding(); });

  /** The dock no longer drives opener/facts (their own cards own that action now — see
   *  `BEAT_DOCK`'s doc comment); only the reward beat's confirm reaches this. */
  function handleDockConfirm() {
    if (beat === "reward") handleComplete();
  }

  const foodsContent = (() => {
    if (foodAccess.status === "pilot") {
      return <FoodsTopPickChips choices={starter.choices ?? []} marks={starter.marks} onMark={starter.mark} />;
    }
    if (foodAccess.status === "legacy") {
      if (starter.choices) {
        return <FallingFoodPile choices={starter.choices} marks={starter.marks} onMark={starter.mark} />;
      }
      return <Placeholder label={starter.error ?? "Checking your food rules…"} />;
    }
    return <Placeholder label={foodAccess.status === "review"
      ? "Review your food rules in Foods › Avoids before choosing suggestions."
      : "Checking your food rules…"} />;
  })();

  const factsEditor = (() => {
    if (editingField === "goal") return <GoalPillRow value={facts.goal}
      onSelect={(value) => setFieldValue("goal", value)} />;
    if (editingField === "sex") return <SexChipRow value={facts.sex}
      onSelect={(value) => setFieldValue("sex", value)} />;
    if (editingField === "heightCm" || editingField === "weightKg") {
      return <NumberFieldEditor key={editingField} field={editingField}
        value={facts[editingField]} onSave={(value) => setFieldValue(editingField, value)} />;
    }
    return null;
  })();

  const streamContent = (() => {
    if (beat === "opener") return <GoalPillRow value={facts.goal} onSelect={pickGoal} />;
    if (beat === "facts") return slots.factsSentence ?? <div className="flex w-full flex-col gap-4">
      <PlaybackSentence facts={facts} onHoldEdit={openFieldEditor} onGhostConfirm={confirmGhostField}
        onEmptyTap={openFieldEditor} onBirthYearNudge={nudgeBirthYear}
        onConfirmAll={confirmFacts} />
      {factsEditor}
    </div>;
    if (beat === "safety") return slots.allergyCard ?? <AllergyConditionGate answer={safety.answer}
      onConfirmNone={confirmNoAllergy} onAddRule={addAllergyRule}
      onRulesConfirmed={() => void allergyRulesConfirmed()} />;
    if (beat === "foods") return slots.foodGame ?? foodsContent;
    return slots.plateReward ?? <RewardPlateCard targets={targets} lovedFoods={lovedFoods}
      showNumbers={showNumbers} onToggleNumbers={() => setShowNumbers((value) => !value)} />;
  })();

  /** VISUAL-SPEC.md §2: within the "facts" beat, `pointing` once a required field is still an
   *  empty gap (the same field `PlaybackSentence`'s own `firstMissingField` already points Sprout
   *  at in its own screen-reader copy, "Sprout is pointing at what's still missing") — `thinking`
   *  otherwise, the general playback-review moment. Every other beat keeps its static §2 pose. */
  const guidePose: OnboardingPose = beat === "facts"
    ? (firstMissingField(facts) ? "pointing" : "thinking")
    : BEAT_POSE[beat];

  return <div className={`${styles.shell} matte`} data-onboarding-v2="true"
    data-scope-kind={ONBOARDING_SCOPE.kind} data-scope-page={ONBOARDING_SCOPE.page}>
    {/* VISUAL-SPEC.md §1: matte charcoal, the same family as the meal card and dock — never flat
        black, never the oat ground (this is a full-screen onboarding surface, not a card standing
        on it). §3: a soft backdrop so the stage is never an empty field; it quiets to one glow for
        the reward beat, the deliberate exception to "always busy". */}
    <div className={styles.backdrop} data-reward={beat === "reward" || undefined} aria-hidden="true" />
    {/* ui-ux-buddy NIT: `.guide`'s `layout="position"` projects inside this scrolling ancestor —
        `layoutScroll` keeps that projection correct if the account has scrolled mid-transition,
        instead of animating from a stale offset. */}
    <motion.div layoutScroll className={styles.scroller}>
      <div className={styles.stream}>
        {/* ui-ux-buddy's Sonnet lane (polish pass, 2026-10-07): `.stream`'s own `justify-content:
            center` (below, the empty-middle fix) re-centers the whole block on every beat change,
            and beats differ in height — without this, Sprout would jump straight to its new Y
            position with no transition, fighting the sync this same pass is after. `layout` makes
            Framer track that position shift and animate it via transform instead, on the same
            CONTAINER_ENTER timing as the card swap beside it, so the whole stage settles together.
            (`.guide`'s own box no longer changes size with BEAT_SIZE — SproutGuide.tsx now renders
            a constant BASE_SIZE box and scales its child via transform — so this `layout` only ever
            has a position shift to track here, never a size one.) */}
        <motion.div layout="position" transition={reduce ? INSTANT : CONTAINER_ENTER}
          className={styles.guide}>
          <SproutGuide pose={guidePose} line={BEAT_LINE[beat]} size={BEAT_SIZE[beat]} />
        </motion.div>
        {/* Sol review round 2: a simultaneous crossfade kept two full beats (wildly different
            heights) in flow at once, which could shift the scroller under a control mid-tap — this
            is sequential, matching DESIGN.md's own rule ("content-then-frame on close"). The dock's
            own mode layers stay simultaneous: they are bounded by one glass pill, not a free-height
            stream. */}
        <AnimatePresence mode="wait" initial={false}>
          <BeatLayer key={beat} reduce={reduce}>{streamContent}</BeatLayer>
        </AnimatePresence>
      </div>
    </motion.div>
    {leaveError && <p role="alert" className="px-4 text-center text-caption text-alert">{leaveError}</p>}
    <div className={styles.skipLink}>
      <Button variant="ghost" size="sm" onClick={handleSkip}>Skip for now</Button>
    </div>
    <div className={styles.dockRow}>
      <OnboardingDock mode={BEAT_DOCK[beat]} reduce={reduce}
        chips={[]}
        /* Sol review round 2: labelling this "Use this plan" when no real plan has been built yet
         * said more than the shell can back up; it earns the real label once either a caller
         * explicitly hands this shell a real `onComplete`, or this lane's own write path has every
         * required fact and a ready food selection. Orchestrator review round 3: "Skip for now"
         * here duplicated the standing skip link's own label — same exit, but two controls sharing
         * one name read as a bug, not an intentional pair. "Not now" stays just as honest without
         * colliding. */
        confirmLabel={beat === "reward" ? ((onComplete || planReady) ? "Use this plan" : "Not now") : "That's me"}
        confirmStatus={saving ? "pending" : undefined}
        onConfirm={handleDockConfirm}
        escapeLabel="Sprout, pick for me" onEscape={beat === "foods" ? pickForMe : () => advance("reward")} />
    </div>
  </div>;
}
