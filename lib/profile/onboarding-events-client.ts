"use client";

/**
 * The phone's side of `POST /api/onboarding/events` (Followups #18, W15's analytics hook). Typed
 * entirely on `lib/profile/onboarding-events.ts` (the wire contract); no answer content or free
 * text is ever accepted here either — the input type below is the same closed, kind-discriminated
 * shape the route enforces, so a caller cannot smuggle one in.
 *
 * A module-level, fire-and-forget queue: `queueOnboardingEvent` stamps a fresh `clientEventId` and
 * `at` once, per event, and buffers it; nothing is posted synchronously with the tap that queued
 * it. The queue drains on whichever comes first:
 *   - the caller's own screen transition (call `flushOnboardingEvents()` when the onboarding shell
 *     moves to a new step or question — the natural place to post what just finished);
 *   - `pagehide` or the page becoming hidden (`visibilitychange`), so a user who closes the tab or
 *     backgrounds the app mid-flow still reports what happened so far.
 *
 * Posted in batches of at most `ONBOARDING_EVENTS_MAX` (20), oldest first. This never blocks the
 * UI and never throws: a network failure, an offline phone, a 4xx/5xx or any other rejection drops
 * that batch (same rule as `lib/timing.ts` and `lib/foods/signals-client.ts` — telemetry that
 * queues forever, or that a caller must await and handle, is a second bug, not a measurement).
 * `queueOnboardingEvent` never awaits a request either, so it is safe to call from a render path.
 *
 * Every queued event is bound to the account that was current when it was queued (`currentAccount
 * OrNull()`, read once at queue time, never re-derived later): a flush drops -- never sends -- any
 * event whose bound account is not the account actually flushing, and the account-gone listener
 * clears the whole queue the moment the device unbinds or switches accounts. So onboarding events
 * queued as account A can never settle as account B's telemetry.
 */
import {
  accountFetch, accountHandle, currentAccountOrNull, onAccountGone, type AccountHandle,
} from "@/lib/device/account";
import {
  ONBOARDING_EVENTS_MAX, type OnboardingEvent, type OnboardingEventFlowVersion,
  type OnboardingEventPilotArm, type OnboardingEventQuestion, type OnboardingEventStep,
} from "@/lib/profile/onboarding-events";

const FLOW_VERSION: OnboardingEventFlowVersion = "onboarding_v2";

/** One logical event to queue, the same closed vocabulary `OnboardingEvent` carries, minus the
 *  fields this module stamps itself (`clientEventId`, `at`, `flowVersion`). */
export type OnboardingEventInput =
  | { kind: "pilot_arm_assigned"; pilotArm: OnboardingEventPilotArm }
  | { kind: "step_entered"; step: OnboardingEventStep }
  | { kind: "step_left"; step: OnboardingEventStep; durationMs: number }
  | { kind: "step_abandoned"; step: OnboardingEventStep; durationMs: number }
  | { kind: "question_entered"; question: OnboardingEventQuestion }
  | { kind: "question_left"; question: OnboardingEventQuestion; durationMs: number };

type QueuedEvent = { event: OnboardingEvent; userId: string };

let queue: QueuedEvent[] = [];
let listenersBound = false;
let goneUnbind: (() => void) | null = null;
/** Chains flushes so a forced one (the page hiding mid-post) awaits what is already in flight,
 *  rather than racing it — same shape as `lib/timing.ts`'s `flushTimings`. */
let inFlight: Promise<void> | null = null;

function stamp(input: OnboardingEventInput, now: Date): OnboardingEvent {
  return { ...input, clientEventId: crypto.randomUUID(), at: now.toISOString(),
    flowVersion: FLOW_VERSION } as OnboardingEvent;
}

function bindFlushListeners(): void {
  if (!goneUnbind) {
    // The account is leaving (closing, unbinding, or switching to another id): whatever is still
    // queued was bound to the account that is going away, so it is dropped rather than risk a
    // later flush sending it under whichever account binds next.
    goneUnbind = onAccountGone(() => { queue = []; });
  }
  if (listenersBound || typeof window === "undefined") return;
  listenersBound = true;
  const flush = () => { void flushOnboardingEvents(); };
  window.addEventListener("pagehide", flush);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }
}

/**
 * Queue one onboarding event, bound to whichever account is current right now. Mints its
 * `clientEventId` now (a retry after a dropped flush would otherwise double-count); never posts
 * synchronously and never throws. Dropped silently when no account is bound yet (e.g. before
 * sign-in finishes) — there is no account to attribute the event to.
 */
export function queueOnboardingEvent(input: OnboardingEventInput, now: Date = new Date()): void {
  try {
    const userId = currentAccountOrNull()?.userId;
    if (!userId) return;
    queue.push({ event: stamp(input, now), userId });
    bindFlushListeners();
  } catch {
    // Queuing an event must never break the screen it was measuring.
  }
}

/** What is waiting to be posted. Exported for tests and for the flush itself. */
export function queuedOnboardingEvents(): readonly OnboardingEvent[] {
  return queue.map((q) => q.event);
}

/** Test-only: drops whatever is queued without posting it. */
export function clearOnboardingEventQueue(): void {
  queue = [];
}

async function flushOnce(opts: { fetchImpl?: typeof fetch; account?: AccountHandle }): Promise<void> {
  if (queue.length === 0) return;
  let h: AccountHandle;
  try {
    h = opts.account ?? accountHandle();
  } catch {
    // No account bound yet (e.g. before sign-in finishes): nothing to send to, drop this pass.
    queue = [];
    return;
  }
  // Never send another account's queued events as this one: a switch between queueing and
  // flushing (or an explicit `opts.account` naming a different id) drops the stale entries here,
  // on top of the account-gone listener that already clears the queue on an ordinary switch.
  queue = queue.filter((q) => q.userId === h.userId);
  while (queue.length > 0) {
    const batch = queue.slice(0, ONBOARDING_EVENTS_MAX);
    queue = queue.slice(batch.length);
    try {
      await accountFetch(h, "/api/onboarding/events", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch.map((q) => q.event) }),
      }, { budget: "timings", fetchImpl: opts.fetchImpl });
    } catch {
      // Fire-and-forget: a dropped batch is lost telemetry, never a blocked or retried flow.
    }
  }
}

/**
 * Post whatever is queued, in batches of at most 20, oldest first. Safe to call from a screen
 * transition and from a `pagehide`/`visibilitychange` listener alike; concurrent calls chain
 * rather than race (one in-flight post at a time). Never throws.
 */
export function flushOnboardingEvents(
  opts: { fetchImpl?: typeof fetch; account?: AccountHandle } = {},
): Promise<void> {
  const run = (inFlight ?? Promise.resolve()).catch(() => {}).then(() => flushOnce(opts));
  const settled = run.catch(() => {}).finally(() => { if (inFlight === settled) inFlight = null; });
  inFlight = settled;
  return settled;
}
