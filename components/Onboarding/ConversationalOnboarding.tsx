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
  effectiveBand, emptyFacts, FactQuestion, firstUnconfirmedField, GoalPillRow, PlaybackSentence,
  type FactAnswer, type Goal, type OnboardingFactKey,
} from "@/components/Onboarding/facts";
import SavingStage from "@/components/Onboarding/SavingStage";
import { readTypedAnswer } from "@/components/Onboarding/typed-answer";
import type { StarterMark } from "@/lib/foods/starter";
import type { FastPathFacts } from "@/lib/coach/onboarding-fast-path";
import RewardPlateCard, { type RewardPlateFood, type RewardPlateTargets }
  from "@/components/Onboarding/reward/RewardPlateCard";
import { useOnboardingFoodAccess } from "@/components/Onboarding/useOnboardingFoodAccess";
import { useStarterStep } from "@/components/Onboarding/useStarterStep";
import {
  applyFactsToSettings, buildOnboardingStateFromFacts, factsToPartialSettings, type FactsLike,
} from "@/components/Onboarding/v2/facts-bridge";
import { clearOnboardingDraft, loadOnboardingDraft, saveOnboardingDraft }
  from "@/components/Onboarding/v2/draft-store";
import { dbFood } from "@/lib/food-db";
import { foodShortName } from "@/components/Onboarding/food-display-names";
import { starterSelectionValid } from "@/lib/foods/starter";
import { starterProteinAvailability } from "@/lib/foods/starter-availability";
import { starterFood } from "@/lib/foods/starter";
import { onboardingPlanPreview, type PlanPreviewMeal } from "@/lib/onboarding/plan-preview";
import { saveOnboardingPlan } from "@/lib/onboarding/save-plan";
import { todayIso } from "@/lib/settings/date";
import { mealCountFor } from "@/lib/plan";
import { accountHandle, onAccountGone, onAccountReady } from "@/lib/device/account";
import {
  loadOnboardingSettings, mirroredOnboardedAt, ONBOARDING_SYNC_WARNING,
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
  reward: "Sprout is showing the foods your plan is built from.",
};
/** What the dock shows on each beat. Live QA 2026-10-07 (defect 2): it used to be an empty
 *  "chips" row on opener/facts/safety — a 124 px empty glass box. Now opener and facts get the
 *  text composer (typing always works, read on the phone by `typed-answer.ts`), the safety beat
 *  hides the dock (its own card owns every answer, and a typed allergy is never read here), foods
 *  gets its escape or its Done, and reward its confirm. `null` hides the dock. A new beat (the
 *  planned goal follow-up) is one more row here. */
const BEAT_DOCK: Record<OnboardingBeat, OnboardingDockMode | null> = {
  opener: "mic", facts: "mic", safety: null, foods: "game", reward: "confirm",
};

/** The composer's hint for whichever question is on screen. */
const TYPE_HINT: Partial<Record<OnboardingFactKey, string>> = {
  birthYear: "Or type your age", sex: "Or type it: female, male", heightCm: "Or type it: 5 10",
  weightKg: "Or type it: 170", goal: "Or type it: lose fat",
};
const OPENER_HINT = "Or type it: lose fat, 34, 5 10, 170 lb";
const BLOCKED_NOTE = "That sounds like a health or allergy detail. Add it here, so every plan respects it.";
const UNREAD_NOTE = "Sprout didn’t catch that. Try a number, like 34 or 5 10, or tap an answer.";

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


/** The five required facts (birth year, sex, height, weight, goal). */
const REQUIRED_FACT_KEYS = ["goal", "sex", "birthYear", "heightCm", "weightKg"] as const;

/** Merges facts read from a typed answer at their own confidence bands. A guess never replaces an
 *  answer the person already confirmed; a confirmed reading replaces anything. */
function mergeTypedFacts(current: FactsLike, found: FastPathFacts): FactsLike {
  const next: FactsLike = { ...current, confidence: { ...current.confidence } };
  for (const key of Object.keys(found) as OnboardingFactKey[]) {
    if ((key as string) === "confidence" || found[key] === undefined) continue;
    const incoming = found.confidence[key] ?? 0;
    if (effectiveBand(current, key) === "high" && incoming < 0.85) continue;
    (next as Record<string, unknown>)[key] = found[key];
    next.confidence[key] = incoming;
  }
  return next;
}

type SavingState = { title: string; step: string };

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
  const [saving, setSavingState] = useState<SavingState | null>(null);
  const [typed, setTyped] = useState("");
  const [composerNote, setComposerNote] = useState<string | null>(null);
  /** Foods the falling game has already shown, held here so a remount of the game (a rules
   *  re-check flips the foods beat to its placeholder and back) never replays them. */
  const [shownFoodIds, setShownFoodIds] = useState<readonly string[]>([]);
  /** The person's own taps, in order — the reward card lists these first. */
  const [userPicks, setUserPicks] = useState<readonly string[]>([]);
  /** Model calls this session's typed answers made (the extract client's budget). */
  const [extractCalls, setExtractCalls] = useState(0);
  const [reading, setReading] = useState(false);
  /** Shown on the safety card when a typed answer was a health or allergy detail. */
  const [safetyNote, setSafetyNote] = useState<string | null>(null);
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
  /** Gates the draft-save effect below until the resume-draft read (or its failure) has actually
   *  settled — see that effect's own comment for why. */
  const [draftChecked, setDraftChecked] = useState(false);

  function advance(next: OnboardingBeat) {
    setBeat(next);
  }

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
      setShownFoodIds([]);
      setUserPicks([]);
      setTyped("");
      setComposerNote(null);
      profileWritten.current = false;
      leaving.current = false;
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
      setShownFoodIds([]);
      setUserPicks([]);
      setTyped("");
      setComposerNote(null);
      profileWritten.current = false;
      leaving.current = false;
    });
    return () => { live = false; unreadyFn(); ungoneFn(); };
  }, []);

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

  // Every account is in the US (owner, 2026-10-07): the editors show feet/inches and pounds, so the
  // saved display units say so too. Storage stays cm/kg.
  const settings = useMemo(() => (base
    ? { ...applyFactsToSettings(base, facts), heightUnit: "ft_in" as const, weightUnit: "lb" as const }
    : null), [base, facts]);
  const onboardingState = useMemo(
    () => (settings ? buildOnboardingStateFromFacts(settings, facts) : null), [settings, facts]);

  const foodAccess = useOnboardingFoodAccess(onboardingState);
  // GPT-6 Sol round-1 BLOCK: `useStarterStep` was only enabled for "legacy", so a pilot account's
  // `FoodsTopPickChips` (which reads `starter.choices`) always saw `null` — an empty picker and a
  // "Sprout, pick for me" that could never select anything. Pilot accounts need the same
  // safety-filtered starter list this shell now shows them.
  // The love round starts with nothing marked: only foods the person taps (or Sprout fills in on
  // request) are saved (live QA 2026-10-07: 29 unseen defaults were saved as Eats).
  const starter = useStarterStep(onboardingState,
    foodAccess.status === "legacy" || foodAccess.status === "pilot", { preselectDefaults: false });

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

  /** The foods the reward card names: the person's own taps first (in tap order), then the rest
   *  of the loved foods (Sprout's picks) in deck order. Live QA 2026-10-07 (defect 5): this used
   *  to take the first default per role, so after "pick for me" it always said chicken, rice, oil. */
  const lovedFoods = useMemo<RewardPlateFood[]>(() => {
    if (!starter.choices) return [];
    const loved = starter.choices.filter((item) => starter.marks[item.id] === "eats");
    const byId = new Map(loved.map((item) => [item.id, item]));
    const ordered = [
      ...userPicks.map((id) => byId.get(id)).filter((item): item is NonNullable<typeof item> => !!item),
      ...loved.filter((item) => !userPicks.includes(item.id)),
    ];
    // The same short names the food grid used ("Chicken", not "Chicken breast, roasted"), six at
    // most, so the card stays one glance tall.
    return ordered.slice(0, 6).map((item) => ({
      id: item.id, name: foodShortName(item.id, dbFood(item.id)?.name ?? item.id),
      role: item.role as RewardPlateFood["role"],
    }));
  }, [starter.choices, starter.marks, userPicks]);

  /** The meals Today will open on, built by Today's own `resolveDay` over the picked foods
   *  (`lib/onboarding/plan-preview.ts`), so the preview and Today agree. Empty while anything is
   *  missing. */
  const previewMeals = useMemo<PlanPreviewMeal[]>(() => {
    if (beat !== "reward" || !settings || !onboardingState || !starter.choices) return [];
    if (missingProfileFields(onboardingState).length > 0) return [];
    try {
      const completed = buildCompletedSettings(settings, onboardingState, new Date());
      const picked = starter.choices.filter((item) => starter.marks[item.id] === "eats")
        .map((item) => starterFood(item.id, "eats"));
      return onboardingPlanPreview(completed, picked, todayIso()).meals.slice(0, 3);
    } catch {
      return [];
    }
  }, [beat, settings, onboardingState, starter.choices, starter.marks]);

  /** A tap in the foods beat: the starter mark, plus the tap order the reward card reads. */
  function markFood(id: string, mark: StarterMark) {
    starter.mark(id, mark);
    setUserPicks((current) => mark === "eats"
      ? (current.includes(id) ? current : [...current, id])
      : current.filter((pick) => pick !== id));
  }

  /** "That's me": only shown once every required field is confirmed (live QA 2026-10-07: it
   *  used to show after one field and then do nothing on tap). The gate stays here as well. If a
   *  typed health detail already took the person through the safety card, go straight to foods. */
  function confirmFacts() {
    if (allRequiredFactsConfirmed(facts)) advance(safety.confirmed ? "foods" : "safety");
  }

  /** After the safety card: back to any fact still missing (the card can come early, when a typed
   *  answer was a health detail), else on to foods. */
  function afterSafety() {
    setSafetyNote(null);
    advance(allRequiredFactsConfirmed(facts) ? "foods" : "facts");
  }

  function pickGoal(key: Goal) {
    // A direct tap is a confirmed, high-confidence answer — never a ghost guess (BRIEF.md §2:
    // "no safe default exists for this field... a tap is the only way this resolves").
    setFacts((current) => ({ ...current, goal: key, confidence: { ...current.confidence, goal: 1 } }));
    advance("facts");
  }

  /** An answer from the open question — confirmed, high confidence, never a guess. */
  function answerFact(answer: FactAnswer) {
    setFacts((current) => ({
      ...current, [answer.key]: answer.value, confidence: { ...current.confidence, [answer.key]: 1 },
    }));
    setEditingField(null);
    setComposerNote(null);
  }

  /** The question the facts beat asks now: the one the person tapped to change, else the first
   *  required field not yet confirmed. `null` once every one is confirmed. */
  const askingField: OnboardingFactKey | null = beat === "facts"
    ? (editingField ?? firstUnconfirmedField(facts)) : null;

  /** The dock's text composer on opener and facts (`typed-answer.ts`): the asked question's own
   *  unit first, then the extract client. A health or allergy detail opens the safety card. */
  async function submitTyped(text: string) {
    if (reading) return;
    const from = beat;
    setReading(true);
    try {
      const answer = await readTypedAnswer(text, from === "facts" ? askingField : null, { callsUsed: extractCalls });
      setExtractCalls(answer.callsUsed);
      if (answer.status === "blocked") {
        setTyped("");
        setComposerNote(null);
        setSafetyNote(BLOCKED_NOTE);
        advance("safety");
        return;
      }
      if (answer.status === "unread") { setComposerNote(UNREAD_NOTE); return; }
      setFacts((current) => mergeTypedFacts(current, answer.facts));
      setTyped("");
      setComposerNote(null);
      setEditingField(null);
      if (from === "opener") advance("facts");
    } catch {
      setComposerNote(UNREAD_NOTE);
    } finally {
      setReading(false);
    }
  }

  function confirmNoAllergy() {
    setSafety({ confirmed: true, answer: "none" });
    onAllergyAnswer?.("none");
    afterSafety();
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
    afterSafety();
  }

  /** Fills only the groups still short (a legacy plan needs one protein per planned meal), never
   *  touching a tap, then moves on. */
  function pickForMe() {
    const need = foodAccess.status === "legacy" ? { protein: Math.max(2, plannedCount) } : {};
    for (const id of pickForMeIds(starter.choices ?? [], starter.marks, need)) starter.mark(id, "eats");
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
    setSavingState({ title: "Saving…", step: "Taking you to Today." });
    try {
      const accountSettings = base ?? await loadOnboardingSettings();
      await persistSkippedOnboarding(accountSettings);
      const drained = await flushOutboxNow(accountHandle());
      const mirrored = drained ? await mirroredOnboardedAt() : null;
      if (mirrored === null) throw new Error(ONBOARDING_SYNC_WARNING);
      await clearOnboardingDraft();
      router.replace("/");
    } catch {
      setLeaveError(ONBOARDING_SYNC_WARNING);
      leaving.current = false;
      setSavingState(null);
    }
  }, [router, base]);

  /** "Use this plan": one call to `saveOnboardingPlan` (lib/onboarding/save-plan.ts — profile,
   *  target revision and constraints in parallel, one fresh rules read for the food write
   *  (ONB2-RULE-REREAD), batched food writes, then the drain-and-mirror gate), behind the
   *  full-screen saving state. The profile write is guarded here so a retry after a later failure
   *  never mints a second target revision (GPT-6 Sol round-1/2 BLOCK); a constraints-only failure
   *  retries the constraints alone. */
  const savePlanAndFinish = useCallback(async () => {
    if (leaving.current) return;
    if (!settings || !onboardingState) { setLeaveError(ONBOARDING_SYNC_WARNING); return; }
    leaving.current = true;
    const title = "Building your plan…";
    setSavingState({ title, step: "Saving your profile, targets and foods." });
    setLeaveError(null);
    const writesFoods = foodAccess.status === "legacy" || foodAccess.status === "pilot";
    const result = await saveOnboardingPlan({
      settings, onboardingState,
      starter: writesFoods ? { status: foodAccess.status as "legacy" | "pilot", marks: starter.marks, plannedCount } : null,
    }, {
      persistPlan: async (planSettings, state) => {
        if (profileWritten.current) return { settings: planSettings, constraintsSaved: constraintsSaved.current };
        const written = await persistCompletedOnboarding(planSettings, state);
        profileWritten.current = true;
        constraintsSaved.current = written.constraintsSaved;
        return written;
      },
      retryConstraints: async (flags) => {
        const ok = await retryOnboardingConstraints(flags);
        if (ok) constraintsSaved.current = true;
        return ok;
      },
    });
    if (!result.ok) {
      setLeaveError(result.error);
      leaving.current = false;
      setSavingState(null);
      return;
    }
    setSavingState({ title, step: "Opening Today." });
    await clearOnboardingDraft();
    router.replace("/");
  }, [router, settings, onboardingState, foodAccess.status, starter.marks, plannedCount]);

  const handleSkip = onSkip ?? (() => void leaveOnboarding());
  const handleComplete = onComplete
    ?? (() => { if (planReady) void savePlanAndFinish(); else void leaveOnboarding(); });

  /** The foods beat is done once the selection is one the plan can use. */
  const foodsReady = starterSelectionReady
    && (foodAccess.status === "pilot" || proteinAvailability?.ready === true);
  const lovedCount = selectedStarterIds.length;
  const dockMode: OnboardingDockMode | null = beat === "foods" && foodsReady ? "confirm" : BEAT_DOCK[beat];

  function handleDockConfirm() {
    if (beat === "reward") handleComplete();
    else if (beat === "foods" && foodsReady) advance("reward");
  }

  const foodsContent = (() => {
    if (foodAccess.status === "pilot") {
      return <FoodsTopPickChips choices={starter.choices ?? []} marks={starter.marks} onMark={markFood} />;
    }
    if (foodAccess.status === "legacy") {
      if (starter.choices) {
        return <FallingFoodPile choices={starter.choices} marks={starter.marks} onMark={markFood}
          shownIds={shownFoodIds}
          onShown={(id) => setShownFoodIds((current) => current.includes(id) ? current : [...current, id])} />;
      }
      return <Placeholder label={starter.error ?? "Checking your food rules…"} />;
    }
    return <Placeholder label={foodAccess.status === "review"
      ? "Review your food rules in Foods › Avoids before choosing suggestions."
      : "Checking your food rules…"} />;
  })();

  const streamContent = (() => {
    if (beat === "opener") return <GoalPillRow value={facts.goal} onSelect={pickGoal} />;
    if (beat === "facts") return slots.factsSentence ?? <div className="flex w-full flex-col gap-5">
      <PlaybackSentence facts={facts} activeField={askingField}
        onEdit={(key) => { setEditingField(key); setComposerNote(null); }} />
      {askingField
        ? <FactQuestion key={askingField} field={askingField} facts={facts} onAnswer={answerFact} />
        : <Button variant="primary" size="lg" block onClick={confirmFacts}>That&rsquo;s me</Button>}
    </div>;
    if (beat === "safety") return slots.allergyCard ?? <div className="flex w-full flex-col gap-3">
      {safetyNote && <p role="status" className="m-0 text-body text-graphite">{safetyNote}</p>}
      <AllergyConditionGate answer={safety.answer}
        onConfirmNone={confirmNoAllergy} onAddRule={addAllergyRule}
        onRulesConfirmed={() => void allergyRulesConfirmed()} />
    </div>;
    if (beat === "foods") return slots.foodGame ?? foodsContent;
    return slots.plateReward ?? <RewardPlateCard targets={targets} lovedFoods={lovedFoods} meals={previewMeals}
      showNumbers={showNumbers} onToggleNumbers={() => setShowNumbers((value) => !value)} />;
  })();

  /** VISUAL-SPEC.md §2: within the "facts" beat, `pointing` while a question is open, `thinking`
   *  once everything is confirmed. Every other beat keeps its static §2 pose. */
  const guidePose: OnboardingPose = beat === "facts"
    ? (askingField ? "pointing" : "thinking")
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
    {leaveError && <p role="alert" className="relative z-[1] px-4 text-center text-caption text-alert">{leaveError}</p>}
    {composerNote && dockMode === "mic" && <p role="status" className={`${styles.composerNote} m-0 text-caption text-graphite`}>
      {composerNote}
    </p>}
    <div className={styles.skipLink}>
      <Button variant="ghost" size="sm" className="min-h-11" onClick={handleSkip}>Skip for now</Button>
    </div>
    {dockMode && <div className={styles.dockRow}>
      <OnboardingDock mode={dockMode} reduce={reduce}
        value={typed} onChange={(value) => { setTyped(value); if (composerNote) setComposerNote(null); }}
        onSubmit={(text) => void submitTyped(text)} listening={reading}
        placeholder={beat === "opener" ? OPENER_HINT
          : askingField ? (TYPE_HINT[askingField] ?? "Or type it") : "Type to change anything"}
        /* Sol review round 2: "Use this plan" only once a real plan can be saved; otherwise the
         * honest "Not now" (distinct from the standing "Skip for now" link). */
        confirmLabel={beat === "reward" ? ((onComplete || planReady) ? "Use this plan" : "Not now")
          : `Done · ${lovedCount} loved`}
        confirmStatus={saving ? "pending" : undefined}
        onConfirm={handleDockConfirm}
        escapeLabel="Sprout, pick for me" onEscape={beat === "foods" ? pickForMe : () => advance("reward")} />
    </div>}
    <AnimatePresence>
      {saving && <SavingStage key="saving" title={saving.title} step={saving.step} />}
    </AnimatePresence>
  </div>;
}
