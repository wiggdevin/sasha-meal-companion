"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "motion/react";
import Button from "@/components/ui/Button";
import SproutGuide, { type OnboardingPose } from "@/components/Onboarding/SproutGuide";
import OnboardingDock, { type OnboardingDockMode } from "@/components/Onboarding/dock/OnboardingDock";
import { useDockDictation } from "@/components/Onboarding/dock/useDockDictation";
import WeekBeat from "@/components/Onboarding/beats/WeekBeat";
import SafetyRound, { type SafetyRoundResult } from "@/components/Onboarding/beats/SafetyRound";
import PaceBeat from "@/components/Onboarding/beats/PaceBeat";
import YourDayBeat from "@/components/Onboarding/beats/YourDayBeat";
import MinorStop from "@/components/Onboarding/beats/MinorStop";
import {
  activityFor, eligibilityFor, emptyPlanAnswers, isMinor, paceBeatNeeded, planCardNotes,
  safetyAnswersFrom, takesInsulin, trainingWeekdaysFor, type PlanAnswers, type PlanNote,
} from "@/components/Onboarding/v2/plan-answers";
import type { PlanStateAnswers } from "@/components/Onboarding/v2/facts-bridge";
import FallingFoodPile from "@/components/Onboarding/FallingFoodPile";
import FoodsTopPickChips from "@/components/Onboarding/FoodsTopPickChips";
import {
  effectiveBand, emptyFacts, FactQuestion, firstUnconfirmedField, GoalPillRow, PlaybackSentence,
  type FactAnswer, type Goal, type OnboardingFactKey,
} from "@/components/Onboarding/facts";
import SavingStage from "@/components/Onboarding/SavingStage";
import { readTypedAnswer } from "@/components/Onboarding/typed-answer";
import type { Starter, StarterMark } from "@/lib/foods/starter";
import type { FastPathFacts } from "@/lib/coach/onboarding-fast-path";
import RewardPlateCard, { type RewardPlateFood, type RewardPlateTargets }
  from "@/components/Onboarding/reward/RewardPlateCard";
import { useOnboardingFoodAccess } from "@/components/Onboarding/useOnboardingFoodAccess";
import { useStarterStep } from "@/components/Onboarding/useStarterStep";
import {
  mergeEligibility, serverHeldEligibility, useStoredEligibility,
} from "@/components/Onboarding/v2/stored-eligibility";
import { usePreviewAccount } from "@/components/Onboarding/v2/preview-account";
import { useOnboardingTelemetry } from "@/components/Onboarding/v2/onboarding-telemetry";
import {
  applyFactsToSettings, buildOnboardingStateFromFacts, factsToPartialSettings, type FactsLike,
} from "@/components/Onboarding/v2/facts-bridge";
import {
  clearOnboardingDraft, loadOnboardingDraft, onboardingTargetRequestId, onboardingTargetRequestKey,
  saveOnboardingDraft,
} from "@/components/Onboarding/v2/draft-store";
import { dbFood } from "@/lib/food-db";
import { foodShortName } from "@/components/Onboarding/food-display-names";
import { starterSelectionValid } from "@/lib/foods/starter";
import { starterProteinAvailability } from "@/lib/foods/starter-availability";
import { starterFillShortRoles, starterFood } from "@/lib/foods/starter";
import { starterFillOrder } from "@/lib/foods/starter-variety";
import { onboardingPlanPreview, type PlanPreviewMeal } from "@/lib/onboarding/plan-preview";
import { RATE_NOT_ELIGIBLE_ERROR, saveOnboardingPlan } from "@/lib/onboarding/save-plan";
import { energyProfileFrom, isProfileComplete } from "@/lib/profile/energy";
import { paceChoices, LB_PER_KG, type PaceChoices } from "@/lib/profile/pace";
import { validateRate } from "@/lib/profile/rate-goal";
import type { TargetEligibility } from "@/lib/profile/rate-eligibility";
import { ONBOARDING_COUNTRY_CHIP } from "@/lib/profile/onboarding-state";
import { todayIso } from "@/lib/settings/date";
import { mealCountFor, resolveSlotTimes } from "@/lib/plan";
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
/** Why the plan cannot be used yet, and the one step that fixes it. */
type PlanNotice = { text: string; actionLabel: string; action: "foods" | "rules" | "facts" | "retry" };
const RULES_UNCHECKED_NOTICE: PlanNotice = {
  text: "Sprout couldn't check your food rules yet, so it can't pick foods for you.",
  actionLabel: "Check again", action: "retry",
};
const FOODS_SHORT_NOTICE: PlanNotice = {
  text: "Sprout couldn't fill every group from the foods your rules allow. Tap a few more you'd eat, or adjust your food rules.",
  actionLabel: "Adjust food rules", action: "rules",
};
const PLAN_FOODS_SHORT_NOTICE: PlanNotice = {
  text: "Your plan needs at least two foods you'd eat in each group before it can be saved.",
  actionLabel: "Choose more foods", action: "foods",
};
const PROFILE_SHORT_NOTICE: PlanNotice = {
  text: "A few answers are still missing, so Sprout can't build your plan yet.",
  actionLabel: "Finish your answers", action: "facts",
};

export type OnboardingBeat =
  | "opener" | "facts" | "minor" | "week" | "safety" | "pace" | "day" | "foods" | "reward";

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
  opener: "wave", facts: "thinking", minor: "content", week: "pointing", safety: "content",
  pace: "pointing", day: "pointing", foods: "content", reward: "joyful",
};
/** VISUAL-SPEC.md §2's three large-Sprout sizes (96/120/140/168) — "Opener/greeting" and "Reward
 *  plate reveal" are the two rows that get a size other than the 96px baseline. */
const BEAT_SIZE: Record<OnboardingBeat, number> = {
  opener: 168, facts: 96, minor: 120, week: 96, safety: 96, pace: 96, day: 96, foods: 96, reward: 140,
};
const BEAT_LINE: Record<OnboardingBeat, string> = {
  opener: "Sprout is listening for your goal.",
  facts: "Sprout is checking what it heard.",
  minor: "Sprout is saying hello. Plans start at 18.",
  week: "Sprout is learning how your week moves.",
  safety: "Sprout is checking what your plan must respect.",
  pace: "Sprout is setting a pace your plan can keep.",
  day: "Sprout is lining up your meal times.",
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
  opener: "mic", facts: "mic", minor: null, week: null, safety: null, pace: null, day: null,
  foods: "game", reward: "confirm",
};

/** The beats after the body facts, in order (QUESTION-SET-v2.md §6). */
const PLAN_ORDER = ["week", "safety", "pace", "day", "foods", "reward"] as const;
type PlanBeat = (typeof PLAN_ORDER)[number];

/** Noon UTC on a local YYYY-MM-DD, the derivation's own date convention. */
function noonUtc(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`);
}

/** The pace screen's numbers for these answers (lib/profile/pace.ts); null until the body facts
 *  and a goal are known. */
function paceFor(settings: Settings | null, answers: PlanAnswers, eligibility: TargetEligibility,
  today: string): PaceChoices | null {
  if (!settings) return null;
  const withActivity: Settings = { ...settings, activityLevel: activityFor(answers.week) };
  if (!isProfileComplete(withActivity)) return null;
  try {
    const { goalRateBpWeek: _rate, ...profile } = energyProfileFrom(withActivity);
    void _rate;
    return paceChoices({ profile, today: noonUtc(today),
      trainingDays: trainingWeekdaysFor(answers.week).length, eligibility });
  } catch {
    return null;
  }
}

/** The pace the plan stores for these answers: the tapped preset, the direction guard's
 *  gentlest preset, or none (recomp, maintain, a held account). */
function storedPace(pace: PaceChoices | null, answers: PlanAnswers): number | null {
  if (!pace || pace.kind === "none" || pace.kind === "held") return null;
  if (answers.paceBp === null) return null;
  return validateRate(pace.goal, answers.paceBp) ? answers.paceBp : null;
}

/** The composer's hint for whichever question is on screen. */
const TYPE_HINT: Partial<Record<OnboardingFactKey, string>> = {
  birthYear: "Or type your age", sex: "Or type it: female, male", heightCm: "Or type it: 5 10",
  weightKg: "Or type it: 170", goal: "Or type it: lose fat",
};
const OPENER_HINT = "Or type it: lose fat, 34, 5 10, 170 lb";
const BLOCKED_NOTE = "That sounds like a health or allergy detail. Tap what applies here, so every plan respects it.";
const RULES_UNVERIFIED = "Couldn’t verify your food rules. Try again.";
const HEALTH_ANSWERS_UNCHECKED = "Couldn’t check your saved health answers. Check your connection, then try again.";
const UNREAD_NOTE = "Sprout didn’t catch that. Try a number, like 34 or 5 10, or tap an answer.";

/** Clear extension points for a caller that wants to render something other than this lane's own
 *  default (tests, mainly): each slot replaces this beat's default content, with no change to the
 *  beats around it. */
export type ConversationalOnboardingSlots = {
  /** L3: the playback-sentence card (goal/sex/birth-year/height/weight, one "That's me" tap). */
  factsSentence?: ReactNode;
  /** The safety round ("No, none of these" as the largest control). Defaults to `SafetyRound`
   *  (question set v2 §1c), wired to this shell's routing and ONB2-RULE-REREAD. */
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
  /** The question-set beats' answers after the body facts (week, safety, pace, your day). */
  const [plan, setPlan] = useState<PlanAnswers>(emptyPlanAnswers());
  /** Set while a beat was opened from the plan card's Change link: its Next returns there. */
  const [returnToReward, setReturnToReward] = useState(false);
  /** The server held the pace (`409 rate_not_eligible`): the plan card says so. */
  const [serverHeld, setServerHeld] = useState(false);
  const [checkingRules, setCheckingRules] = useState(false);
  const [showNumbers, setShowNumbers] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  /** GPT-6 Sol BLOCK (onb2-p0): why the plan cannot be used yet, with the one step that fixes it.
   *  Shown instead of moving on; never a silent skip. Cleared on every beat change. */
  const [planNotice, setPlanNotice] = useState<PlanNotice | null>(null);
  const [saving, setSavingState] = useState<SavingState | null>(null);
  const [typed, setTyped] = useState("");
  const [composerNote, setComposerNote] = useState<string | null>(null);
  /** Foods the falling game has already shown, held here so a remount of the game (a rules
   *  re-check flips the foods beat to its placeholder and back) never replays them. */
  const [shownFoodIds, setShownFoodIds] = useState<readonly string[]>([]);
  /** The person's own taps, in order — the reward card lists these first. */
  const [userPicks, setUserPicks] = useState<readonly string[]>([]);
  /** Foods the person tapped off in this flow: "Sprout, pick for me" never picks them again. */
  const [tappedOff, setTappedOff] = useState<ReadonlySet<string>>(() => new Set());
  /** Model calls this session's typed answers made (the extract client's budget). */
  const [extractCalls, setExtractCalls] = useState(0);
  /** ONB2-RULE-REREAD: true while the Foods "Done" tap's fresh rules read is in flight, so a
   *  second tap during that window cannot race it. */
  const [confirmingFoods, setConfirmingFoods] = useState(false);
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
  /** The request the profile write above saved: a changed answer after a failed later step is a
   *  new request, written again (with its own target request id). */
  const profileWrittenKey = useRef<string | null>(null);
  const constraintsSaved = useRef(false);
  /** Gates the draft-save effect below until the resume-draft read (or its failure) has actually
   *  settled — see that effect's own comment for why. */
  const [draftChecked, setDraftChecked] = useState(false);
  /** Voice on every beat that takes free text (the dock's composer, `BEAT_DOCK` "mic"): the words
   *  fill the box for review, and only Send reads them — through `submitTyped`, the typed answer's
   *  own local safety gate and extract budget. */
  const dictation = useDockDictation({
    readBox: () => typed,
    writeBox: (text) => { setTyped(text); setComposerNote(null); },
    active: BEAT_DOCK[beat] === "mic",
    session: beat,
  });

  function advance(next: OnboardingBeat) {
    setPlanNotice(null);
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
      setPlan(emptyPlanAnswers());
      setReturnToReward(false);
      setServerHeld(false);
      setEditingField(null);
      setDraftChecked(false);
      setShownFoodIds([]);
      setUserPicks([]);
      setTappedOff(new Set());
      setTyped("");
      setComposerNote(null);
      profileWritten.current = false;
      profileWrittenKey.current = null;
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
          // The model-call budget already spent this session carries over too, so a reload mid-
          // setup cannot hand the account a second budget on top of the one it already used.
          if (typeof draft.callsUsed === "number" && draft.callsUsed > 0) {
            setExtractCalls(draft.callsUsed);
          }
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
      setPlan(emptyPlanAnswers());
      setReturnToReward(false);
      setServerHeld(false);
      setEditingField(null);
      setDraftChecked(false);
      setShownFoodIds([]);
      setUserPicks([]);
      setTappedOff(new Set());
      setTyped("");
      setComposerNote(null);
      setExtractCalls(0);
      profileWritten.current = false;
      profileWrittenKey.current = null;
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
    void saveOnboardingDraft({
      beat, settings: factsToPartialSettings(confirmedFactsOnly(facts)),
      ...(extractCalls > 0 ? { callsUsed: extractCalls } : {}),
    });
  }, [base, draftChecked, beat, facts, extractCalls]);

  // Every account is in the US (owner, 2026-10-07): the editors show feet/inches and pounds, so the
  // saved display units say so too. Storage stays cm/kg.
  const settings = useMemo(() => (base
    ? { ...applyFactsToSettings(base, facts), heightUnit: "ft_in" as const, weightUnit: "lb" as const }
    : null), [base, facts]);
  const today = todayIso();
  // The round's taps AND the account's stored answers (final Sol review BLOCK): the server reads
  // both, so a stored hold the round did not repeat still holds the pace here.
  // A `409 rate_not_eligible` answer re-reads them, and holds the plan whatever that read says:
  // the pace screen, the preview and the save then all drop the pace, never only a note.
  const storedState = useStoredEligibility(!!base, serverHeld ? 1 : 0);
  const storedEligibility = storedState.eligibility;
  const notedEligibility = useMemo(() => mergeEligibility(eligibilityFor(plan), storedEligibility),
    [plan, storedEligibility]);
  const baseEligibility = useMemo(() => serverHeldEligibility(notedEligibility, serverHeld),
    [notedEligibility, serverHeld]);
  const minor = isMinor(facts.birthYear, today) || baseEligibility.minor;
  const pace = useMemo(() => paceFor(settings, plan, baseEligibility, today),
    [settings, plan, baseEligibility, today]);
  /** Everything the beats answered, as the write path's state (facts-bridge.ts). Activity is the
   *  person's chip or the inferred one; the pace is the confirmed tap only (V1, V3). */
  const planState = useMemo<PlanStateAnswers>(() => ({
    goalRateBpWeek: storedPace(pace, plan),
    activityLevel: activityFor(plan.week),
    trainingWeekdays: trainingWeekdaysFor(plan.week),
    mealsPerDay: plan.day?.mealsPerDay ?? null,
    firstMealTime: plan.day?.firstMealTime ?? null,
    ...(plan.day ? { countryCode: plan.day.inUs ? ONBOARDING_COUNTRY_CHIP : null } : {}),
  }), [pace, plan]);
  const onboardingState = useMemo(
    () => (settings ? buildOnboardingStateFromFacts(settings, facts, planState) : null),
    [settings, facts, planState]);
  const safetyAnswers = useMemo(() => safetyAnswersFrom(plan.safety), [plan.safety]);

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
  const incompleteForPlan = !onboardingState || missingProfileFields(onboardingState, baseEligibility).length > 0;
  // GPT-6 Sol round-2 WARN: an unexpected `buildCompletedSettings` error used to fall back to
  // `plannedCount = 0`, which makes `starterProteinAvailability(..., 0).ready` trivially true
  // (`selected >= 0`) — an error state silently looked exactly like "nothing to plan for, so
  // anything passes" instead of "not ready". `plannedCountFailed` keeps that distinction and
  // `planReady` below treats a failed derivation as NOT ready, fail-closed.
  const [plannedCountFailed, plannedCount] = (() => {
    if (incompleteForPlan || !settings || !onboardingState) return [false, 0] as const;
    try {
      return [false, mealCountFor(buildCompletedSettings(settings, onboardingState, new Date(), baseEligibility))] as const;
    } catch {
      return [true, 0] as const;
    }
  })();
  const proteinAvailability = starter.choices
    ? starterProteinAvailability(starter.marks, starter.choices, plannedCount) : null;
  // The account as it stands (its other Eats and saved days), so a returning account's preview
  // is Today's plan too (final Sol review BLOCK). Until it is read the reward card stays in its
  // preparing state and "Use this plan" waits: no starter-only preview is ever shown.
  const previewAccount = usePreviewAccount(beat === "reward");
  const planReady = previewAccount !== null && settings !== null && onboardingState !== null
    && missingProfileFields(onboardingState, baseEligibility).length === 0 && !plannedCountFailed
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
    if (!settings || !onboardingState || (beat === "reward" && previewAccount === null)) return null;
    if (missingProfileFields(onboardingState, baseEligibility).length > 0) return null;
    try {
      const completed = buildCompletedSettings(settings, onboardingState, new Date(), baseEligibility);
      const profile = completed.activeTargetProfile;
      return profile ? { training: profile.training, rest: profile.rest } : null;
    } catch {
      return null;
    }
  }, [settings, onboardingState, baseEligibility, beat, previewAccount]);

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
    if (beat !== "reward" || !previewAccount || !settings || !onboardingState || !starter.choices) return [];
    if (missingProfileFields(onboardingState, baseEligibility).length > 0) return [];
    try {
      const completed = buildCompletedSettings(settings, onboardingState, new Date(), baseEligibility);
      const picked = starter.choices.filter((item) => starter.marks[item.id] === "eats")
        .map((item) => starterFood(item.id, "eats"));
      return onboardingPlanPreview(completed, picked, todayIso(), previewAccount)
        .meals.slice(0, 3);
    } catch {
      return [];
    }
  }, [beat, settings, onboardingState, baseEligibility, starter.choices, starter.marks, previewAccount]);

  /** "Your day" defaults and the plan card's named defaults: the meal count "Pick for me" gives
   *  for this plan's calories, and the first time the plan actually uses. */
  const dayDefaults = useMemo(() => {
    const fallback = { derivedCount: 3, mealCount: 3, firstMealTime: "08:00" };
    if (!settings || !onboardingState) return fallback;
    if (missingProfileFields(onboardingState, baseEligibility).length > 0) return fallback;
    try {
      const now = new Date();
      const auto = buildCompletedSettings(settings,
        { ...onboardingState, mealsPerDay: null, firstMealTime: null }, now, baseEligibility);
      const chosen = buildCompletedSettings(settings, onboardingState, now, baseEligibility);
      const first = resolveSlotTimes("rest", chosen)[0]?.time ?? "08:00";
      return { derivedCount: mealCountFor(auto), mealCount: mealCountFor(chosen), firstMealTime: first };
    } catch {
      return fallback;
    }
  }, [settings, onboardingState, baseEligibility]);

  const planNotes = useMemo<PlanNote[]>(() => {
    const notes = planCardNotes({ goal: facts.goal, answers: plan, pace, eligibility: notedEligibility,
      mealCount: dayDefaults.mealCount, firstMealTime: dayDefaults.firstMealTime });
    // The server held the pace: its reason (the account's saved answers) replaces the generic one.
    return serverHeld
      ? [...notes.filter((note) => note.id !== "held"),
        { id: "held", text: "Your saved health answers keep calories about where you burn." }]
      : notes;
  }, [facts.goal, plan, pace, notedEligibility, dayDefaults, serverHeld]);

  /** A tap in the foods beat: the starter mark, plus the tap order the reward card reads. */
  function markFood(id: string, mark: StarterMark) {
    starter.mark(id, mark);
    setTappedOff((current) => {
      const next = new Set(current);
      if (mark === "eats") next.delete(id); else next.add(id);
      return next;
    });
    setUserPicks((current) => mark === "eats"
      ? (current.includes(id) ? current : [...current, id])
      : current.filter((pick) => pick !== id));
  }

  /** Whether a later beat is already settled for these answers, so the walk forward skips it.
   *  The pace counts as settled only when the route needs none or a valid preset is confirmed. */
  function settled(next: PlanBeat, answers: PlanAnswers, stored: TargetEligibility | null): boolean {
    if (next === "week") return answers.week !== null;
    if (next === "safety") return answers.safety !== null;
    if (next === "pace") {
      // The same eligibility the plan is built under: these answers' taps, the account's stored
      // holds and a server refusal (final Sol review BLOCK).
      const eligibility = serverHeldEligibility(
        mergeEligibility(eligibilityFor(answers), stored), serverHeld);
      const nextPace = paceFor(settings, answers, eligibility, today);
      return !paceBeatNeeded(nextPace) || storedPace(nextPace, answers) !== null;
    }
    if (next === "day") return answers.day !== null;
    if (next === "foods") return returnToReward && foodsReady;
    return false;
  }

  /** QUESTION-SET-v2.md §6: the next beat after `from` that still needs an answer. Under 18
   *  stops at the friendly stop; the body facts come back first if any is still missing (the
   *  safety card can open early from a typed health detail). */
  function forward(from: "facts" | PlanBeat, answers: PlanAnswers, stored: TargetEligibility | null) {
    setSafetyNote(null);
    if (!allRequiredFactsConfirmed(facts)) { advance("facts"); return; }
    if (minor || stored?.minor) { advance("minor"); return; }
    const start = from === "facts" ? 0 : PLAN_ORDER.indexOf(from) + 1;
    const next = PLAN_ORDER.slice(start).find((candidate) => !settled(candidate, answers, stored)) ?? "reward";
    if (next === "reward") setReturnToReward(false);
    advance(next);
  }

  /**
   * `forward`, once the account's stored holds are read (final Sol review BLOCK): a walk that
   * could reach the pace waits for that read, and a failed read stays on this step with a retry
   * line, so an unread account is never routed as one with no stored hold.
   */
  async function walk(from: "facts" | PlanBeat, answers: PlanAnswers = plan) {
    // The pace is reachable only once the week and the safety round are answered.
    const paceReachable = answers.week !== null && answers.safety !== null;
    if (storedState.status === "ready" || !paceReachable) {
      forward(from, answers, storedState.eligibility);
      return;
    }
    setCheckingRules(true);
    let stored: TargetEligibility | null;
    try {
      stored = await storedState.refresh();
    } finally {
      setCheckingRules(false);
    }
    if (!stored) { setLeaveError(HEALTH_ANSWERS_UNCHECKED); return; }
    setLeaveError(null);
    forward(from, answers, stored);
  }

  /** "That's me": only shown once every required field is confirmed. */
  function confirmFacts() {
    if (allRequiredFactsConfirmed(facts)) void walk("facts");
  }

  /** A beat's Next: store its answer, then walk on (or back to the plan card after a Change). */
  function answerPlan(from: PlanBeat, patch: Partial<PlanAnswers>) {
    const next = { ...plan, ...patch };
    setPlan(next);
    void walk(from, next);
  }

  /** The plan card's Change link: reopen that beat; a week or safety change re-asks the pace,
   *  whose numbers depend on both. */
  function changeFromPlan(target: NonNullable<PlanNote["change"]>) {
    setReturnToReward(true);
    if (target === "week" || target === "safety") setPlan((current) => ({ ...current, paceBp: null }));
    advance(target);
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
  // Followups #18: step and question timing only, never an answer (onboarding-telemetry.ts).
  const telemetry = useOnboardingTelemetry(beat, askingField);

  /** The dock's text composer on opener and facts (`typed-answer.ts`): the asked question's own
   *  unit first, then the extract client. A health or allergy detail opens the safety card. */
  async function submitTyped(text: string) {
    // A spoken answer reaches here only through the same Send, once the mic has let go of the box.
    if (reading || dictation.locked) return;
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

  /** The safety round's Continue (or "No, none of these"). When the rule editor was opened,
   *  ONB2-RULE-REREAD: re-read the account's rules before any food UI, failing closed. A changed
   *  safety answer re-asks the pace, since a hold removes it. */
  async function safetyDone(result: SafetyRoundResult) {
    if (checkingRules) return;
    const { rulesEdited, ...round } = result;
    for (const pick of round.picks.length > 0 ? round.picks : ["none"]) onAllergyAnswer?.(pick);
    if (rulesEdited) {
      setCheckingRules(true);
      try {
        const freshChoices = await starter.reread();
        if (!freshChoices) { setLeaveError(RULES_UNVERIFIED); return; }
      } finally {
        setCheckingRules(false);
      }
    }
    setLeaveError(null);
    answerPlan("safety", { safety: round, paceBp: plan.safety === null ? plan.paceBp : null });
  }

  /** Fills only the groups still short (a legacy plan needs one protein per planned meal), never
   *  touching a tap, then moves on — but only when the filled selection is one the plan can use.
   *  GPT-6 Sol BLOCK (onb2-p0): with too few foods the rules allow (or that the person left on),
   *  it used to move on anyway, and "Use this plan" then took the skip path. Now it stays on Foods
   *  and says what to do. */
  function pickForMe() {
    if ((foodAccess.status !== "pilot" && foodAccess.status !== "legacy") || !starter.choices) {
      setPlanNotice(RULES_UNCHECKED_NOTICE);
      return;
    }
    const choices = starter.choices;
    const need = foodAccess.status === "legacy" ? { protein: Math.max(2, plannedCount) } : {};
    const added = starterFillShortRoles(choices, starter.marks, need, tappedOff, starterFillOrder);
    for (const id of added) starter.mark(id, "eats");
    const filled: Record<string, StarterMark> = { ...starter.marks };
    for (const id of added) filled[id] = "eats";
    if (selectionUsable(filled, choices)) { advance("reward"); return; }
    setPlanNotice(FOODS_SHORT_NOTICE);
  }

  /** The selection rule "Use this plan" saves under: two foods per group, and for a legacy plan
   *  enough distinct proteins for its meals. */
  function selectionUsable(marks: Readonly<Record<string, StarterMark>>, choices: readonly Starter[]): boolean {
    const ids = Object.entries(marks).filter(([, mark]) => mark === "eats").map(([id]) => id);
    return choices.length > 0 && starterSelectionValid(ids, choices)
      && (foodAccess.status === "pilot"
        || (foodAccess.status === "legacy" && starterProteinAvailability(marks, choices, plannedCount).ready));
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
      await telemetry.finish();
      router.replace("/");
    } catch {
      setLeaveError(ONBOARDING_SYNC_WARNING);
      leaving.current = false;
      setSavingState(null);
    }
  }, [router, base, telemetry]);

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
    // Never save on an unread account (final Sol review BLOCK): the stored holds decide the pace.
    let stored = storedState.eligibility;
    if (storedState.status !== "ready") {
      stored = await storedState.refresh();
      if (!stored) { leaving.current = false; setLeaveError(HEALTH_ANSWERS_UNCHECKED); return; }
    }
    const title = "Building your plan…";
    setSavingState({ title, step: "Saving your profile, targets and foods." });
    setLeaveError(null);
    const writesFoods = foodAccess.status === "legacy" || foodAccess.status === "pilot";
    // GPT-6 Sol BLOCK (onb2-p0): ONE target request id per save, kept in the resume draft, so a
    // retry after a lost target answer (the revision committed, the answer never arrived) is the
    // same request and the server writes one revision. A changed answer is a new request.
    const requestKey = onboardingTargetRequestKey(onboardingState, safetyAnswers);
    const targetRequestId = await onboardingTargetRequestId(requestKey);
    const result = await saveOnboardingPlan({
      settings, onboardingState, safety: safetyAnswers, targetRequestId,
      storedEligibility: serverHeldEligibility(mergeEligibility(stored), serverHeld),
      starter: writesFoods ? { status: foodAccess.status as "legacy" | "pilot", marks: starter.marks, plannedCount } : null,
    }, {
      persistPlan: async (planSettings, state, now, deps, safety, requestId, held) => {
        if (profileWritten.current && profileWrittenKey.current === requestKey) {
          return { settings: planSettings, constraintsSaved: constraintsSaved.current };
        }
        const written = await persistCompletedOnboarding(planSettings, state, now, deps, safety, requestId, held);
        // Final Sol review r3 BLOCK: a failed safety-condition write wrote nothing, so Try again
        // must run the whole save again, not skip to a constraints retry it cannot satisfy.
        if (written.profileWritten === false) return written;
        profileWritten.current = true;
        profileWrittenKey.current = requestKey;
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
      leaving.current = false;
      setSavingState(null);
      // `422 adult_only`: no plan is built; the friendly stop, not an error line.
      if (result.code === "adult_only") { setLeaveError(null); advance("minor"); return; }
      // `409 rate_not_eligible`: the account's stored answers hold the pace; the plan card says so
      // and the next tap saves at maintenance (the server holds it whatever the phone sends).
      if (result.code === "rate_not_eligible") { setServerHeld(true); setLeaveError(RATE_NOT_ELIGIBLE_ERROR); return; }
      setLeaveError(result.error);
      return;
    }
    setSavingState({ title, step: "Opening Today." });
    await clearOnboardingDraft();
    await telemetry.finish();
    router.replace("/");
  }, [router, settings, onboardingState, safetyAnswers, foodAccess.status, starter.marks, plannedCount,
    storedState, serverHeld, telemetry]);

  const handleSkip = onSkip ?? (() => void leaveOnboarding());
  /** "Use this plan". GPT-6 Sol BLOCK (onb2-p0): it never takes the skip path. A plan that is not
   *  ready yet says why and stays; only "Skip for now" skips. */
  const handleComplete = onComplete ?? (() => {
    if (planReady) { setPlanNotice(null); void savePlanAndFinish(); return; }
    setPlanNotice(incompleteForPlan || plannedCountFailed ? PROFILE_SHORT_NOTICE : PLAN_FOODS_SHORT_NOTICE);
  });

  /** The foods beat is done once the selection is one the plan can use. */
  const foodsReady = starterSelectionReady
    && (foodAccess.status === "pilot" || proteinAvailability?.ready === true);
  const lovedCount = selectedStarterIds.length;
  // "Use this plan" appears once the reward card shows Today's plan (the account read answered).
  const dockMode: OnboardingDockMode | null = beat === "reward" && previewAccount === null ? null
    : beat === "foods" && foodsReady ? "confirm" : BEAT_DOCK[beat];
  const composerLine = composerNote ?? dictation.line;

  /** Foods "Done": ONB2-RULE-REREAD (Sol r6 BLOCK on onb2-l4-r2). `starter.choices` here can be
   *  minutes stale — a rule saved mid-flow through the inline rule editor never retriggers the
   *  hook's own effect — so this re-reads the account's rules right now, the same discipline
   *  `allergyRulesConfirmed` above already applies to the safety→foods hop, before ever trusting
   *  the selection enough to show the reward beat (and, from there, to write it). A dropped or
   *  failed reread fails closed: stay on Foods with a clear error rather than advance on a stale
   *  list. */
  async function confirmFoodsAndAdvance() {
    if (confirmingFoods) return;
    setConfirmingFoods(true);
    try {
      const freshChoices = await starter.reread();
      if (!freshChoices) {
        setLeaveError("Couldn’t verify your food rules. Try again.");
        return;
      }
      const freshSelected = Object.entries(starter.marks)
        .filter(([, mark]) => mark === "eats").map(([id]) => id);
      const stillReady = starterSelectionValid(freshSelected, freshChoices)
        && (foodAccess.status === "pilot"
          || starterProteinAvailability(starter.marks, freshChoices, plannedCount).ready);
      if (!stillReady) {
        setLeaveError("A rule just changed what's safe to eat — choose again below.");
        return;
      }
      advance("reward");
    } finally {
      setConfirmingFoods(false);
    }
  }

  function handleDockConfirm() {
    if (beat === "reward") handleComplete();
    else if (beat === "foods" && foodsReady) void confirmFoodsAndAdvance();
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
    if (beat === "minor") return <MinorStop busy={!!saving} onBrowse={() => void leaveOnboarding()}
      onChangeAge={() => { setEditingField("birthYear"); advance("facts"); }} />;
    if (beat === "week") return <WeekBeat initial={plan.week}
      onDone={(week) => answerPlan("week", { week, ...(returnToReward ? { paceBp: null } : {}) })} />;
    if (beat === "safety") return slots.allergyCard ?? <SafetyRound initial={plan.safety} note={safetyNote}
      busy={checkingRules} onDone={(result) => void safetyDone(result)} />;
    if (beat === "pace") {
      // A resumed draft can open here before the stored holds are read: wait, and on a failed
      // read offer the walk again (it re-reads and skips the pace for a held account).
      if (storedState.status !== "ready") {
        return storedState.status === "failed"
          ? <Button variant="primary" size="lg" block onClick={() => void walk("safety")}>Try again</Button>
          : <Placeholder label="Checking your saved health answers…" />;
      }
      // Read now, and this account needs no pace (a stored hold): one tap moves on.
      if (pace && !paceBeatNeeded(pace)) {
        return <div className="flex w-full flex-col gap-3">
          <p className="m-0 text-body text-charcoal">Your saved health answers keep calories about where you burn.</p>
          <Button variant="primary" size="lg" block onClick={() => void walk("pace")}>Next</Button>
        </div>;
      }
      if (!pace || (pace.kind !== "choices" && pace.kind !== "minimum") || !facts.goal
        || facts.weightKg === undefined || facts.heightCm === undefined) {
        return <Placeholder label="Working out your pace…" />;
      }
      return <PaceBeat pace={pace} goal={facts.goal} currentLb={facts.weightKg * LB_PER_KG}
        heightCm={facts.heightCm} today={today} requestedLb={facts.requestedPaceLbPerWeek}
        insulin={takesInsulin(plan.safety)} initialBp={plan.paceBp} initialGoalLb={plan.goalWeightLb}
        onDone={({ bp, goalWeightLb }) => answerPlan("pace", { paceBp: bp, goalWeightLb })} />;
    }
    if (beat === "day") return <YourDayBeat derivedCount={dayDefaults.derivedCount} initial={plan.day}
      onDone={(day) => answerPlan("day", { day })} />;
    if (beat === "foods") return slots.foodGame ?? foodsContent;
    return slots.plateReward ?? <RewardPlateCard targets={targets} lovedFoods={lovedFoods} meals={previewMeals}
      notes={planNotes} onChangeNote={changeFromPlan}
      showNumbers={showNumbers} onToggleNumbers={() => setShowNumbers((value) => !value)} />;
  })();

  /** VISUAL-SPEC.md §2: within the "facts" beat, `pointing` while a question is open, `thinking`
   *  once everything is confirmed. Every other beat keeps its static §2 pose. */
  const guidePose: OnboardingPose = dockMode === "mic" && dictation.hearing ? "listening"
    : dockMode === "mic" && (reading || dictation.mode === "busy") ? "thinking"
    : beat === "facts" ? (askingField ? "pointing" : "thinking")
    : BEAT_POSE[beat];
  const guideLine = guidePose === "listening" ? "Sprout is listening to you." : BEAT_LINE[beat];

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
          <SproutGuide pose={guidePose} line={guideLine} size={BEAT_SIZE[beat]} />
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
    {planNotice && <div role="status" data-testid="plan-notice"
      className="relative z-[1] flex flex-col items-center gap-2 px-4 text-center">
      <p className="m-0 text-caption text-graphite">{planNotice.text}</p>
      <Button variant="secondary" size="sm" className="min-h-11"
        onClick={() => {
          if (planNotice.action === "retry") { setPlanNotice(null); foodAccess.retry(); starter.retry(); return; }
          advance(planNotice.action === "foods" ? "foods" : planNotice.action === "rules" ? "safety" : "facts");
        }}>
        {planNotice.actionLabel}
      </Button>
    </div>}
    {composerLine && dockMode === "mic" && <p role="status" data-testid="composer-line"
      className={`${styles.composerNote} m-0 text-caption text-graphite`}>
      {composerLine}
    </p>}
    {/* The under-18 stop carries its own "Look around" exit; a second one would say the same. */}
    {beat !== "minor" && <div className={styles.skipLink}>
      <Button variant="ghost" size="sm" className="min-h-11" onClick={handleSkip}>Skip for now</Button>
    </div>}
    {dockMode && <div className={styles.dockRow}>
      <OnboardingDock mode={dockMode} reduce={reduce}
        value={typed} onChange={(value) => { setTyped(value); if (composerNote) setComposerNote(null); }}
        onSubmit={(text) => void submitTyped(text)} listening={reading || dictation.locked}
        onMicTap={dictation.available ? dictation.toggle : undefined} micLabel="Say it"
        micActive={dictation.mode === "stop"} micBusy={dictation.mode === "busy"}
        micSeconds={dictation.secondsLeft} micDisabled={reading}
        placeholder={beat === "opener" ? OPENER_HINT
          : askingField ? (TYPE_HINT[askingField] ?? "Or type it") : "Type to change anything"}
        /* Sol review round 2: "Use this plan" only once a real plan can be saved; otherwise the
         * honest "Not now" (distinct from the standing "Skip for now" link). */
        confirmLabel={beat === "reward" ? (leaveError && !saving ? "Try again" : "Use this plan")
          : `Done · ${lovedCount} loved`}
        confirmStatus={saving || confirmingFoods ? "pending" : undefined}
        onConfirm={handleDockConfirm}
        escapeLabel="Sprout, pick for me" onEscape={beat === "foods" ? pickForMe : () => advance("reward")} />
    </div>}
    <AnimatePresence>
      {saving && <SavingStage key="saving" title={saving.title} step={saving.step} />}
    </AnimatePresence>
  </div>;
}
