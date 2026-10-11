"use client";

import { accountHandle } from "@/lib/device/account";
import { useEffect, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import {
  ActivityStep, BodyStep, GoalStep, PlanStep, PreferencesStep,
} from "./OnboardingSteps";
import {
  createOnboardingState, missingProfileFields, onboardingReducer, previewCompletedSettings,
  type OnboardingAction, type OnboardingState,
} from "@/lib/profile/onboarding-state";
import { AdultOnlyError, paceAllowed } from "@/lib/profile/rate-eligibility";
import { TargetSaveRefusedError } from "@/lib/targets/client";
import { todayIso } from "@/lib/settings/date";
import SafetyRound from "@/components/Onboarding/beats/SafetyRound";
import MinorStop from "@/components/Onboarding/beats/MinorStop";
import { useStoredEligibility } from "@/components/Onboarding/v2/stored-eligibility";
import { safetyAnswersFrom, type SafetyRound as SafetyRoundAnswer } from "@/components/Onboarding/v2/plan-answers";
import { legacyEligibility, legacyMinor, needsBirthDate } from "@/components/Onboarding/legacy-eligibility";
import {
  CONSTRAINT_SAVE_WARNING, loadOnboardingSettings, ONBOARDING_SYNC_WARNING,
  mirroredOnboardedAt, persistCompletedOnboarding, persistSkippedOnboarding,
  retryOnboardingConstraints,
} from "@/lib/profile/onboarding-client";
import {
  classifyDietaryPreferences, createPreferenceClassifier,
  type PreferenceClassifier, type PrefsResponse,
} from "@/lib/profile/prefs-client";
import type { DietaryTextOffer } from "@/components/ui/DietaryTextHint";
import { flushOutboxNow } from "@/lib/sync/client";
import {
  parseCookingEffort, type CookingEffort,
} from "@/lib/sync/user-settings";
import type { Settings } from "@/lib/types";
import DeviceStep, { type DeviceCapability } from "./DeviceStep";
import { useCapabilities } from "@/components/CapabilitiesProvider";
import FoodsStep from "./FoodsStep";
import CuisineStep, { CUISINE_STEP_TITLE, useCuisineStep } from "./CuisineStep";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import { useStarterStep } from "./useStarterStep";
import { useOnboardingFoodAccess } from "./useOnboardingFoodAccess";
import { starterSelectionValid } from "@/lib/foods/starter";
import { starterProteinAvailability } from "@/lib/foods/starter-availability";
import { mealCountFor } from "@/lib/plan";
import { persistStarterSelection } from "@/lib/foods/starter-client";
import CloseButton from "@/components/ui/CloseButton";
import { SPRINGS } from "@/lib/design/motion";
import { lockBodyScroll } from "@/lib/dom/scroll-lock";
import { keyBelongsTo, nextTrapFocus } from "@/lib/dom/sheet-a11y";
import Notice from "@/components/ui/Notice";
import Button from "@/components/ui/Button";

const STEPS = ["Body", "Activity", "Goal", "Dietary preferences", "Foods", "Your plan"] as const;
const BODY_FIELDS = new Set(["sex", "birth year", "height", "weight"]);
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** The longest the flow waits for its exit spring before it hands control back anyway. */
const LEAVE_FALLBACK_MS = 700;

/** Every body field is answered, and in the year the birth year turns 18 the full date of birth
 *  too (audit 2026-10-10 A092). */
export function isBodyStepComplete(state: OnboardingState, today: string = todayIso()): boolean {
  return !missingProfileFields(state).some((field) => BODY_FIELDS.has(field))
    && !needsBirthDate(state, today);
}

export function isNextDisabled(
  step: number,
  saving: boolean,
  classifying: boolean,
  bodyComplete: boolean,
): boolean {
  return saving || (step === 0 && !bodyComplete) || (step === 3 && classifying);
}

export function OnboardingNotice({ message }: { message: string | null }) {
  return message ? <Notice tone="error" title={message} /> : null;
}

/** The safety round's conditions did not save, so nothing else did either. */
export const SAFETY_SAVE_WARNING = "Couldn’t save your health answers. Try again.";

/** A reason the plan cannot finish yet: the shared alert says it, and the account stays put. */
class Blocked extends Error {}

/** The derivation's own under-18 refusal, or the server's `422 adult_only` for the stored year. */
function isAdultOnly(error: unknown): boolean {
  return error instanceof AdultOnlyError
    || (error instanceof TargetSaveRefusedError && error.code === "adult_only");
}

type CookingPrefsResponse = PrefsResponse & {
  cookingEffortSuggestion?: unknown;
};

type Props = {
  initial?: number;
  returnTo?: string;
  initialSettings?: Settings;
  /** Present when the flow opens over another screen (Settings, the Today invite); it then leaves
   *  by calling this rather than navigating. */
  onFinished?: () => void;
  /** The top close (and Escape) of an opened-over flow. Defaults to `onFinished`. */
  onClose?: () => void;
  deviceCapability?: DeviceCapability;
  offerDevice?: boolean;
};

export default function OnboardingFlow({
  initial = 0,
  returnTo = "/",
  initialSettings,
  onFinished,
  onClose,
  deviceCapability,
  offerDevice = true,
}: Props) {
  // Opened over a screen (Settings "Finish profile", the Today invite) the flow is a full-screen
  // sheet: it rises, it can be closed at any step without writing anything, and it leaves the way
  // it came. As the first-run route it is the page itself, and its close is "Skip for now".
  const embedded = onFinished !== undefined;
  const reduceMotion = useReducedMotion();
  const present = useIsPresent();
  const rootRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const leaveTo = useRef<(() => void) | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const { device } = useCapabilities();
  const activeDeviceCapability = deviceCapability ?? device;
  const [base, setBase] = useState<Settings | null>(initialSettings ?? null);
  const [state, dispatch] = useReducer(
    (current: OnboardingState | null, action: OnboardingAction) =>
      action.type === "replace" ? action.state : current ? onboardingReducer(current, action) : current,
    initialSettings ? createOnboardingState(initialSettings, initial) : null,
  );
  const [classifying, setClassifying] = useState(false);
  const feedback = useActionFeedback();
  const saving = feedback.phase === "pending";
  const [completed, setCompleted] = useState(false);
  const [constraintsSaved, setConstraintsSaved] = useState(false);
  const [foodsSaved, setFoodsSaved] = useState(false);
  const [showDevice, setShowDevice] = useState(false);
  // The skip's own half of the same rule as `completed`, kept separate because Skip IS the retry when
  // the drain did not land: the flag must not disable the button that retries it.
  const [skipPersisted, setSkipPersisted] = useState(false);
  const [cookingEffortSuggestion, setCookingEffortSuggestion] =
    useState<CookingEffort | null>(null);
  // Phase 18 W5b hand-off: the local safety check's offer for the newest classified text, so the
  // field can point at the account's own rule editor instead of sending a rule, allergy, condition
  // or symptom anywhere. Its own sequence number (not the classifier's) keeps only the newest
  // answer, and `dietaryHintText` lets the text-change effect below hide a hint the moment the field
  // no longer matches the text it was computed for.
  const [dietaryHintOffer, setDietaryHintOffer] = useState<DietaryTextOffer | null>(null);
  const dietaryHintSequence = useRef(0);
  const dietaryHintText = useRef<string | null>(null);
  // The two refs are read only inside the classifier's async callback, never while rendering; the
  // compiler's check began to see this initializer once the preview stopped throwing in render.
  // eslint-disable-next-line react-hooks/refs
  const [classifier] = useState<PreferenceClassifier>(() => {
    let pendingCookingEffort: CookingEffort | null = null;
    return createPreferenceClassifier(
      (flags) => {
        dispatch({ type: "merge_flags", flags });
        setCookingEffortSuggestion(pendingCookingEffort);
      },
      setClassifying,
      async (text) => {
        const sequence = ++dietaryHintSequence.current;
        const result = await classifyDietaryPreferences(text) as CookingPrefsResponse | null;
        if (sequence === dietaryHintSequence.current) {
          dietaryHintText.current = text;
          setDietaryHintOffer(result?.route === "local" ? result.offer ?? null : null);
        }
        pendingCookingEffort = result?.jev
          ? parseCookingEffort(result.cookingEffortSuggestion)
          : null;
        return result;
      },
    );
  });
  // The text changed since the hint was computed (a fresh keystroke after a stale answer, or the
  // field cleared): hide it rather than show a hint for text nobody can see any more.
  useEffect(() => {
    if (dietaryHintText.current !== null && state?.prefsText !== dietaryHintText.current) {
      dietaryHintText.current = null;
      setDietaryHintOffer(null);
    }
  }, [state?.prefsText]);
  // The safety round's taps (asked before the goal, A087) and the account's stored holds (A088):
  // the pace, the preview and the save are built under both, and held at 0 until both are known.
  const [safetyRound, setSafetyRound] = useState<SafetyRoundAnswer | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const stored = useStoredEligibility(true);
  // The server refused a plan for this birth year (`422 adult_only`): the friendly stop (A093).
  const [serverMinor, setServerMinor] = useState(false);
  // Previews read stored holds: entering the plan reads them again, so a hold saved anywhere since
  // the last read (a profile on Dietary preferences, another device) shapes the plan shown.
  const refreshStored = stored.refresh;
  const lastStep = useRef<number | null>(state?.step ?? null);
  useEffect(() => {
    const now = state?.step ?? null;
    const entered = now === 5 && lastStep.current !== null && lastStep.current !== 5;
    lastStep.current = now;
    if (entered) void refreshStored();
  }, [state?.step, refreshStored]);
  const foodAccess = useOnboardingFoodAccess(state);
  const optionalFoods = foodAccess.status === "pilot";
  const starter = useStarterStep(state, foodAccess.status === "legacy");
  const cuisine = useCuisineStep(state?.step ?? 0);

  useEffect(() => {
    if (initialSettings) return;
    let live = true;
    void loadOnboardingSettings().then((settings) => {
      if (!live) return;
      setBase(settings);
      dispatch({ type: "replace", state: createOnboardingState(settings, initial) });
    });
    return () => { live = false; };
  }, [initial, initialSettings]);

  const loaded = base !== null && state !== null;
  // Focus moves into the opened-over flow and, once it has left, back to the control that opened
  // it; the screen behind it does not scroll meanwhile.
  useEffect(() => {
    const root = rootRef.current;
    if (!embedded || !loaded || !root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
    const unlock = lockBodyScroll(document.body);
    return () => {
      unlock();
      const active = document.activeElement;
      if (!active || active === document.body || root.contains(active)) opener?.focus?.({ preventScroll: true });
    };
  }, [embedded, loaded]);
  useEffect(() => () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }, []);

  if (!base || !state) return null;
  const currentBase = base;
  const currentState = state;

  /** Plays the exit spring, then hands control back exactly once. */
  function leave(then: () => void): void {
    if (leaveTo.current) return;
    leaveTo.current = then;
    if (reduceMotion) { settleLeave(); return; }
    setLeaving(true);
    leaveTimer.current = setTimeout(settleLeave, LEAVE_FALLBACK_MS);
  }

  function settleLeave(): void {
    const then = leaveTo.current;
    if (!then) return;
    leaveTo.current = () => undefined;
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    then();
  }

  /** The minor stop's "Look around": opened over a screen it leaves with nothing written; as the
   *  first-run route it is the skip (no plan, the account can still browse). */
  function lookAround(): void {
    if (embedded) leave(onClose ?? onFinished ?? (() => undefined));
    else void skip();
  }

  function finish(): void {
    if (onFinished) leave(onFinished);
    else router.replace(returnTo);
  }

  function classify(stateNow: OnboardingState): Promise<void> {
    return classifier.run(stateNow.prefsText);
  }

  /** The rule-hand-off hint's action: this step already carries the account's own rule editor
   *  (More dietary profiles, below), so this jumps to it instead of leaving onboarding. */
  function jumpToRuleEditor(): void {
    const input = document.getElementById("dietary-profile-search");
    input?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    (input as HTMLInputElement | null)?.focus({ preventScroll: true });
  }

  /**
   * May this account leave? The gate opens on the SERVER's `user_settings.onboarded_at`, so both
   * halves of that answer have to hold: the drain (the queued write has been sent) and the mirror
   * (the row this device holds really carries the stamp — a `drop` settlement empties the outbox
   * without writing it). A `false` here keeps the account on this screen with a retry it can act on.
   */
  async function settingsAccepted(): Promise<boolean> {
    if (!await flushOutboxNow(accountHandle())) return false;
    return (await mirroredOnboardedAt()) !== null;
  }

  async function next(): Promise<void> {
    if (currentState.step === 3 && !cuisine.at) await classify(currentState);
    if (!cuisine.forward()) dispatch({ type: "step", value: currentState.step + 1 });
  }

  /** One onboarding write through the shared feedback: a blocker or failure keeps the account here. */
  async function save(): Promise<void> {
    const outcome = await feedback.run(savePlan, { kind: "commit", key: "save",
      failureMessage: (cause) => cause instanceof Blocked ? cause.message : "Couldn’t save your plan. Try again." });
    if (!outcome.ok) return;
    if (offerDevice && activeDeviceCapability?.enabled) setShowDevice(true);
    else finish();
  }

  async function savePlan(): Promise<void> {
    if (!completed && !planReady) {
      throw new Blocked(optionalFoods ? "Couldn’t verify your food rules. Retry on Foods."
        : "This plan needs more selected foods. Go back to Foods or choose fewer meals.");
    }
    let foodsSatisfied = foodsSaved;
    if (!completed) {
      const access = await foodAccess.revalidate();
      if (access === "review" || access === "unavailable" || access === "checking") {
        throw new Blocked("Couldn’t verify your food rules. Go back to Foods and retry.");
      }
      if (access === "legacy" && !(starterSelectionReady && proteinAvailability?.ready)) {
        throw new Blocked("Go back to Foods and choose foods for your plan.");
      }
      let result: Awaited<ReturnType<typeof persistCompletedOnboarding>>;
      try {
        // The round's conditions are written before the target, and the stored holds ride along,
        // so the revision the server derives is the plan this screen showed (A087, A088).
        result = await persistCompletedOnboarding(cuisine.withCuisines(currentBase), currentState,
          undefined, undefined, safetyAnswersFrom(safetyRound), undefined, planEligibility);
      } catch (error) {
        if (!isAdultOnly(error)) throw error;
        setServerMinor(true);
        throw new Blocked(new AdultOnlyError().message);
      }
      // The round's condition write failed before anything else was written (no profile, target or
      // weigh-in): stay not-completed so "Use this plan" runs the whole save again.
      if (result.profileWritten === false) throw new Blocked(SAFETY_SAVE_WARNING);
      // Marked done BEFORE the drain: persist is the half that must never run twice — it mints the
      // target revision and the weigh-in — so a retry after a failed drain only drains.
      setCompleted(true);
      setConstraintsSaved(result.constraintsSaved);
      if (access === "pilot") {
        foodsSatisfied = true;
        setFoodsSaved(true);
      }
      if (!result.constraintsSaved) throw new Blocked(CONSTRAINT_SAVE_WARNING);
    }
    if (!constraintsSaved && completed) {
      if (!await retryOnboardingConstraints(currentState.flags)) throw new Blocked(CONSTRAINT_SAVE_WARNING);
      setConstraintsSaved(true);
    }
    if (!foodsSatisfied) {
      // ONB2-RULE-REREAD (Sol r6 BLOCK on onb2-l4-r2): re-read the account's rules right now,
      // immediately before the write — never trust `starter.choices` from an earlier render. A
      // rule saved mid-flow (e.g. through the rule editor a dietary-text jump opens) writes
      // constraints directly and would not otherwise retrigger `useStarterStep`'s own effect, so
      // the stale list could still let an already-excluded food write through as "eats".
      const freshChoices = await starter.reread();
      if (!freshChoices) throw new Blocked("Couldn’t verify your food rules. Go back to Foods and retry.");
      await persistStarterSelection(starter.marks, freshChoices);
      setFoodsSaved(true);
    }
    // Everything above only QUEUED the stamp; leaving on a queued write is what sends a finished
    // account back to step 1 on its next load.
    if (!await settingsAccepted()) throw new Blocked(ONBOARDING_SYNC_WARNING);
  }

  async function skip(): Promise<void> {
    const outcome = await feedback.run(async () => {
      if (!skipPersisted) {
        await persistSkippedOnboarding(currentBase);
        setSkipPersisted(true);
      }
      if (!await settingsAccepted()) throw new Blocked(ONBOARDING_SYNC_WARNING);
    }, { kind: "commit", key: "skip",
      failureMessage: (cause) => cause instanceof Blocked ? cause.message : "Couldn’t finish setup. Try again." });
    if (outcome.ok) finish();
  }

  /**
   * The top close and Escape, at any step. Opened over a screen it leaves with nothing written:
   * every answer in the flow is a draft until "Use this plan", so closing is a cancel, and what the
   * account already saved stays as it was. As the first-run route it is "Skip for now" (AGENTS.md:
   * nobody is forced through setup), or the retry of a plan that saved but has not synced yet.
   */
  function requestClose(): void {
    if (deviceShown) { finish(); return; }
    if (embedded) { leave(onClose ?? onFinished ?? (() => undefined)); return; }
    if (saving) return;
    void (completed ? save() : skip());
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!keyBelongsTo(event.target, event.currentTarget)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
    } else if (event.key === "Tab" && embedded) {
      const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => keyBelongsTo(element, event.currentTarget));
      const next = nextTrapFocus(focusable, document.activeElement as HTMLElement | null, event.shiftKey);
      if (next) { event.preventDefault(); next.focus(); }
    }
  }

  const step = currentState.step;
  const today = todayIso();
  const pace = legacyEligibility(safetyRound, stored);
  const planEligibility = pace.eligibility;
  // Under 18 by the form's answers, a stored minor profile, or the server's refusal: no plan, and
  // never a crash (A093). The body step stays editable for a typo.
  const minorStop = step > 0 && (serverMinor || legacyMinor(currentState, today, planEligibility));
  const incomplete = missingProfileFields(currentState, planEligibility).length > 0;
  const preview = incomplete || minorStop ? null
    : previewCompletedSettings(currentBase, currentState, new Date(), planEligibility);
  const plannedCount = preview ? mealCountFor(preview) : 0;
  const showSafety = step === 2 && !minorStop && (safetyRound === null || safetyOpen);
  const paceMatters = currentState.goal === "lose_fat" || currentState.goal === "gain_muscle";
  const paceNote = !paceMatters || pace.check === "answered" ? null
    : pace.check === "unanswered"
      ? <Notice tone="attention" title="Answer the health questions to set a pace. Until then this plan keeps your calories about where you burn."
          action={{ label: "Answer them", onClick: () => { setSafetyOpen(true); dispatch({ type: "step", value: 2 }); } }} />
      : stored.status === "failed"
        ? <Notice tone="attention" title="Couldn’t check your saved health answers, so this plan keeps your calories about where you burn."
            action={{ label: "Retry", onClick: () => { void stored.refresh(); } }} />
        : <p role="status" className="m-0 text-caption text-graphite">Checking your saved health answers…</p>;
  const selectedStarterIds = Object.entries(starter.marks)
    .filter(([, mark]) => mark === "eats").map(([id]) => id);
  const starterSelectionReady = !!starter.choices
    && starterSelectionValid(selectedStarterIds, starter.choices);
  const proteinAvailability = starter.choices
    ? starterProteinAvailability(starter.marks, starter.choices, plannedCount) : null;
  const planReady = optionalFoods || (foodAccess.status === "legacy"
    && starterSelectionReady && proteinAvailability?.ready === true);
  const deviceShown = showDevice && activeDeviceCapability?.enabled === true;
  const hidden = { y: "100%" };
  return (
    <motion.div ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}
      role={embedded ? "dialog" : undefined} aria-modal={embedded ? true : undefined}
      aria-label={embedded ? "Profile setup" : undefined}
      className="fixed inset-0 z-50 outline-none"
      inert={leaving || !present} aria-hidden={leaving || !present ? true : undefined}
      initial={embedded && !reduceMotion ? hidden : false}
      animate={leaving ? hidden : { y: 0 }}
      exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } }
        : { ...hidden, transition: { ...SPRINGS.smooth, visualDuration: 0.32 } }}
      transition={leaving ? { ...SPRINGS.smooth, visualDuration: 0.32 } : SPRINGS.smooth}
      onAnimationComplete={() => { if (leaving) settleLeave(); }}>
    {deviceShown && activeDeviceCapability
      ? <DeviceStep capability={activeDeviceCapability} returnTo={returnTo} onFinish={finish} />
      : <main className="fixed inset-0 z-50 overflow-y-auto bg-paper px-4 text-charcoal"
      style={{ paddingTop: "calc(var(--safe-top) + 16px)",
        paddingBottom: "calc(var(--safe-bottom) + 16px)" }}>
      {/* The card fills the screen: the shell is a column and its face grows into it, so the E1 drop
          never outlines empty space under a short step (2026-10-04). */}
      <div className="shell mx-auto flex min-h-full w-full max-w-md flex-col">
        <div className="surface flex flex-1 flex-col gap-5 p-4"
          style={{ background: "var(--color-surface)" }}>
          <header className="flex flex-col gap-3">
            <div className="-mr-1 -mt-1 flex items-center justify-between gap-3">
              <p className="m-0 uppercase text-overline text-text-faint">
                Step {cuisine.position} of {cuisine.total(STEPS.length)}
              </p>
              <CloseButton onClick={requestClose} disabled={!embedded && saving} />
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-charcoal/10" aria-hidden="true">
              <div className="h-full rounded-full bg-primary"
                style={{ width: `${(cuisine.position / cuisine.total(STEPS.length)) * 100}%` }} />
            </div>
            <h1 className="m-0 text-display-md font-light leading-none tracking-display-md">
              {cuisine.at ? CUISINE_STEP_TITLE : STEPS[step]}
            </h1>
          </header>

          <div className="min-h-0 flex-1">
            {step === 0 && <BodyStep state={currentState} dispatch={dispatch} />}
            {step === 1 && !minorStop && <ActivityStep state={currentState} dispatch={dispatch} />}
            {minorStop && <MinorStop busy={saving} onBrowse={lookAround}
              onChangeAge={() => { setServerMinor(false); dispatch({ type: "step", value: 0 }); }} />}
            {showSafety && <SafetyRound initial={safetyRound} onDone={({ rulesEdited, ...round }) => {
              setSafetyRound(round);
              setSafetyOpen(false);
              // A rule or profile added in the round's editor can be a stored hold: read again.
              if (rulesEdited) void stored.refresh();
            }} />}
            {step === 2 && !minorStop && !showSafety && <div className="flex flex-col gap-3">
              <GoalStep state={currentState} dispatch={dispatch} paceHeld={!paceAllowed(pace.known)} />
              <Button variant="ghost" size="sm" className="self-start" onClick={() => setSafetyOpen(true)}>
                Change your health answers
              </Button>
            </div>}
            {cuisine.at && !minorStop && <CuisineStep base={currentBase} chosen={cuisine.chosen} onChange={cuisine.setChosen} />}
            {step === 3 && !cuisine.at && !minorStop && <PreferencesStep state={currentState} dispatch={dispatch}
              classifying={classifying} cookingEffort={currentState.cookingEffort}
              cookingEffortSuggestion={cookingEffortSuggestion}
              onCookingEffortChange={(value) =>
                dispatch({ type: "set_cooking_effort", value })}
              onBlur={() => { void classify(currentState); }}
              dietaryHintOffer={dietaryHintOffer} onAddRule={jumpToRuleEditor}
              onRulesChanged={() => { void stored.refresh(); }} />}
            {step === 4 && !minorStop && (optionalFoods
              ? <p className="m-0 text-caption text-graphite">
                  You can discover recipes right away. Save ingredients you love in Favorites whenever you like.
                </p>
              : foodAccess.status === "legacy" && starter.choices
                ? <FoodsStep choices={starter.choices} marks={starter.marks} onMark={starter.mark} />
                : (foodAccess.status === "unavailable" || foodAccess.status === "review" || starter.error)
                  ? <Notice tone="attention" title={foodAccess.status === "review"
                      ? "Review your food rules in Foods › Avoids before continuing."
                      : foodAccess.status === "unavailable"
                        ? "Couldn’t verify recipe access or food rules. Retry when you’re online."
                        : starter.error}
                      action={{ label: "Retry",
                        onClick: foodAccess.status === "legacy" ? starter.retry : foodAccess.retry }} />
                  : <p role="status" className="m-0 text-caption text-graphite">Checking your food rules…</p>)}
            {step === 5 && !minorStop && <PlanStep state={currentState} base={currentBase} dispatch={dispatch}
              eligibility={planEligibility} paceNote={paceNote}
              proteinAvailability={optionalFoods ? undefined : proteinAvailability}
              starterSelectionReady={optionalFoods ? undefined : starterSelectionReady}
              optionalFoods={optionalFoods} />}
          </div>

          <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
          {/* Back is the quieter neighbour, Next / Use this plan the flow's one primary; md, so the
              two sit level (DESIGN.md §Buttons). Each write lights only its own control (keyed). */}
          {!minorStop && <footer className="flex flex-col gap-2">
            <div className="flex gap-2">
              {step > 0 && (
                <Button variant="tertiary" className="flex-1" disabled={saving || completed}
                  onClick={() => { if (!cuisine.back()) dispatch({ type: "step", value: step - 1 }); }}>
                  Back
                </Button>
              )}
              {step < 5 ? (
                <Button variant="primary" className="flex-1"
                  disabled={isNextDisabled(step, saving, classifying, isBodyStepComplete(currentState, today))
                    || showSafety
                    || (step === 4 && !optionalFoods && !(foodAccess.status === "legacy" && starterSelectionReady))}
                  onClick={() => { void next(); }}>
                  Next
                </Button>
              ) : (
                <Button variant="primary" confirmLabel="Saved" {...feedback.controlPropsFor("save")}
                  className={`flex-1 ${feedback.controlPropsFor("save").className}`} disabled={saving || incomplete || (!completed && (!planReady || !preview))} onClick={() => { void save(); }}>
                  {completed ? "Continue" : "Use this plan"}
                </Button>
              )}
            </div>
            <Button variant="ghost" block {...feedback.controlPropsFor("skip")} disabled={saving || completed}
              onClick={() => { void skip(); }}>
              Skip for now
            </Button>
          </footer>}
        </div>
      </div>
    </main>}
    </motion.div>
  );
}
