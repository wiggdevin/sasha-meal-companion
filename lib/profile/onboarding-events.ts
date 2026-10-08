/**
 * Onboarding events (Followups #18, migration 20261226090200): the wire contract of
 * `POST /api/onboarding/events`, shared by the route and the phone. Feeds the W15 onboarding
 * question ablation (docs/specs/phase-18-open-world-foods.md §W15).
 *
 * The fixed vocabulary -- NO answer content, no free text, ever:
 *   - `pilot_arm_assigned`  which pilot arm the account is in (`pilotArm`); once per account
 *   - `step_entered`        a numbered screen of the flow (`step`) was shown
 *   - `step_left`           the screen was left normally, with how long it was on screen
 *   - `step_abandoned`      the flow was abandoned while this screen was showing
 *   - `question_entered`    one onboarding question (`question`) was shown within a step
 *   - `question_left`       the question was left (answered, skipped or abandoned alike -- this
 *                           log never carries which), with how long it was on screen
 *
 * `step`, `question` and `pilotArm` are each a closed list; the database (`onboarding_event_shape_
 * valid`, same lists) is the final word, and a mismatch between this file and the migration is a
 * build bug, not a client input to trust (tests/profile/onboarding-events.test.ts pins them equal).
 *
 * Pure. No I/O.
 */
import { z } from "zod";

export const ONBOARDING_EVENTS_MAX = 20;
/** Rows live this long (`onboarding_events_purge`). */
export const ONBOARDING_EVENTS_RETENTION_DAYS = 90;
/** Request body ceiling: 20 events of a handful of short enum fields, with room to spare. */
export const ONBOARDING_EVENTS_BODY_MAX_BYTES = 16 * 1024;

export const ONBOARDING_EVENT_FLOW_VERSIONS = ["onboarding_v2"] as const;
export type OnboardingEventFlowVersion = (typeof ONBOARDING_EVENT_FLOW_VERSIONS)[number];

export const ONBOARDING_EVENT_KINDS = [
  "pilot_arm_assigned", "step_entered", "step_left", "step_abandoned", "question_entered",
  "question_left",
] as const;
export type OnboardingEventKind = (typeof ONBOARDING_EVENT_KINDS)[number];

export const ONBOARDING_EVENT_STEPS = ["intro", "facts", "allergy", "foods", "reward", "done"] as const;
export type OnboardingEventStep = (typeof ONBOARDING_EVENT_STEPS)[number];

/** Mirrors ONBOARDING_FACT_KEYS (lib/coach/ui-blocks.ts) -- the question identifier only, never
 *  its answer. Duplicated here on purpose: this module must never import the coach's answer
 *  shapes (architecture.md's event log carries no answer-content import graph to audit). */
export const ONBOARDING_EVENT_QUESTIONS = [
  "goal", "sex", "birthYear", "heightCm", "weightKg", "activity", "dietFlags", "cookingEffort",
] as const;
export type OnboardingEventQuestion = (typeof ONBOARDING_EVENT_QUESTIONS)[number];

export const ONBOARDING_EVENT_PILOT_ARMS = ["control", "treatment"] as const;
export type OnboardingEventPilotArm = (typeof ONBOARDING_EVENT_PILOT_ARMS)[number];

const DURATION_MAX_MS = 24 * 60 * 60 * 1000;
const duration = z.number().int().min(0).max(DURATION_MAX_MS);

const base = {
  clientEventId: z.uuid(),
  at: z.iso.datetime({ offset: true }),
  flowVersion: z.enum(ONBOARDING_EVENT_FLOW_VERSIONS),
};

/** One shape per kind, matching `onboarding_event_shape_valid` exactly: a step/left/abandoned
 *  event never carries a question or pilot arm, and vice versa; only `*_left`/`*_abandoned`
 *  events carry a duration. */
export const OnboardingEvent = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("pilot_arm_assigned"), pilotArm: z.enum(ONBOARDING_EVENT_PILOT_ARMS) }).strict(),
  z.object({ ...base, kind: z.literal("step_entered"), step: z.enum(ONBOARDING_EVENT_STEPS) }).strict(),
  z.object({ ...base, kind: z.literal("step_left"), step: z.enum(ONBOARDING_EVENT_STEPS), durationMs: duration }).strict(),
  z.object({ ...base, kind: z.literal("step_abandoned"), step: z.enum(ONBOARDING_EVENT_STEPS), durationMs: duration }).strict(),
  z.object({ ...base, kind: z.literal("question_entered"), question: z.enum(ONBOARDING_EVENT_QUESTIONS) }).strict(),
  z.object({ ...base, kind: z.literal("question_left"), question: z.enum(ONBOARDING_EVENT_QUESTIONS), durationMs: duration }).strict(),
]);
export type OnboardingEvent = z.infer<typeof OnboardingEvent>;

export const OnboardingEventBatch = z.object({
  events: z.array(OnboardingEvent).min(1).max(ONBOARDING_EVENTS_MAX),
}).strict();

/** The event as the `record_onboarding_events` RPC's `p_events` array element. */
export function onboardingEventRow(event: OnboardingEvent): Record<string, unknown> {
  return {
    client_event_id: event.clientEventId, at: event.at, flow_version: event.flowVersion, kind: event.kind,
    step: "step" in event ? event.step : null,
    question: "question" in event ? event.question : null,
    pilot_arm: "pilotArm" in event ? event.pilotArm : null,
    duration_ms: "durationMs" in event ? event.durationMs : null,
  };
}
