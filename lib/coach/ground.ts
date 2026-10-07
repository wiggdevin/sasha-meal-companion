/**
 * Grounding: a model's names and grams become real `food_refs` rows, real per-100 g macros and a
 * real policy verdict, before the client ever sees them. Each kind grounds itself (its spec in
 * lib/coach/actions/<kind>.ts, sharing lib/coach/actions/ground-kit.ts); this file runs the batch.
 *
 * A missing food ref drops its whole action. A BLOCKED food stays and is marked — logging marks,
 * it never refuses (ruling 2026-09-14).
 *
 * Pure. No I/O, no Supabase import: the reads arrive as injected ports.
 */

import {
  actionSpecFor, type CoachAction, type CoachActionInput,
} from "@/lib/coach/actions";
import type { GroundActionPorts, GroundKit, GroundOutcome } from "@/lib/coach/actions/spec";
import type { ConstraintProfile } from "@/lib/policy/constraints";

export type { GroundActionPorts } from "@/lib/coach/actions/spec";

export type GroundActionsResult = {
  actions: CoachAction[];
  clarifications: string[];
};

/**
 * A missing food ref drops its whole action. Blocked foods stay and are MARKED, never refused
 * (ruling 2026-09-14). A `set_slot_meal` item with no grams takes the catalog's household
 * portion; only a food with no portion either becomes one question.
 */
export async function groundActions(
  userId: string,
  inputs: CoachActionInput[],
  profile: ConstraintProfile,
  ports: GroundActionPorts,
): Promise<GroundActionsResult> {
  // Each input is grounded on its own, so they run TOGETHER: three list marks were three searches
  // one after another. The results are then applied in input order, and action ids are handed out
  // in that order too, so the reply reads exactly as it did when this loop was sequential.
  // One read of the entry list, shared by every delete_entry and move_entry in the batch.
  let entries: Promise<Map<string, string>> | null = null;
  const kit: GroundKit = { userId, profile, ports,
    knownEntries: () => ports.knownEntries ? (entries ??= ports.knownEntries(userId)) : null };

  const groundOne = async (input: CoachActionInput): Promise<GroundOutcome<CoachAction>> => {
    const spec = actionSpecFor(input.kind);
    if (!spec) throw new Error(`coach action kind ${input.kind} is not registered`);
    return spec.ground(input, kit) as Promise<GroundOutcome<CoachAction>>;
  };

  // Every input settles before any is judged, so a failure is reported for the first failing
  // INPUT (as the sequential loop did), not the first to fail on the clock, and no search is still
  // running once this returns or throws.
  const settled = await Promise.allSettled(inputs.map(groundOne));
  const actions: CoachAction[] = [];
  const clarifications: string[] = [];
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
    const outcome = result.value;
    clarifications.push(...outcome.clarifications);
    if (outcome.action) actions.push(outcome.action(ports.newActionId()));
  }
  return { actions, clarifications };
}

/** The runTurn post-ground boundary: food is grounded once, then each kind may widen its action. */
export async function groundAndExpandActions(
  userId: string,
  inputs: CoachActionInput[],
  profile: ConstraintProfile,
  ports: GroundActionPorts,
): Promise<GroundActionsResult> {
  const grounded = await groundActions(userId, inputs, profile, ports);
  const actions: CoachAction[] = [];
  const clarifications = [...grounded.clarifications];
  for (const action of grounded.actions) {
    const expanded = actionSpecFor(action.kind)?.expand?.(action);
    if (!expanded) actions.push(action);
    else if ("clarification" in expanded) clarifications.push(expanded.clarification);
    else actions.push(expanded.action as CoachAction);
  }
  return { actions, clarifications };
}
