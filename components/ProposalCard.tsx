"use client";

/**
 * The proposal card on Today, while a pending proposal exists (spec "Client changes").
 * Olive alert shell copied from Main.dc.html:79–85. Both buttons are 44 px; offline they disable
 * with "Needs a connection", because an approval is never queued (§3.7, targets are never merged).
 */
import { useEffect, useRef, useState } from "react";
import { MacroLine } from "@/components/nutrition/MacroText";
import { decideProposalOnline } from "@/lib/estimator-client";
import type { ProposalSummary, ProposedTargets } from "@/lib/api-types";
import { proposalActivitySentence } from "@/lib/proposal";
import ActionFeedbackToast, { COMMIT_FEEDBACK_MS, useActionFeedback } from "@/components/ui/ActionFeedback";

const SHELL_CLASS = "rounded-[32px]";
const SHELL: React.CSSProperties = {
  padding: 1,
  background: "var(--color-feedback-pending)",
  boxShadow: "0 0 18px color-mix(in srgb, var(--color-feedback-pending) 24%, transparent), 0 12px 12px -6px rgba(0,0,0,0.05)",
};
const INNER_CLASS = "rounded-3xl";
const INNER: React.CSSProperties = {
  background: "var(--grad-panel)",
  boxShadow: "inset 0 1px 2px rgba(0,0,0,0.05)",
  padding: "20px 22px",
};

const GENERIC_DECIDE_ERROR = "Couldn't save. Try again.";
const STALE_PROPOSAL_ERROR = "This proposal changed — reload to see the latest.";

/** decideProposalOnline throws `decide failed: ${res.status}` on any non-2xx (lib/estimator-client.ts);
 *  a 409 means write_target_proposal already superseded this proposal server-side. */
export function decideErrorMessage(err: unknown): string {
  if (err instanceof Error && /\b409\b/.test(err.message)) return STALE_PROPOSAL_ERROR;
  return GENERIC_DECIDE_ERROR;
}

export function deltaSentence(proposed: ProposedTargets): string {
  const kcal = proposed.kcalTrain.toLocaleString("en-US");
  if (proposed.deltaKcalTrain === 0) return `Your training days stay at ${kcal} kcal, protein unchanged.`;
  const verb = proposed.deltaKcalTrain > 0 ? "could go to" : "could come down to";
  return `Your training days ${verb} ${kcal} kcal, protein unchanged.`;
}

const decisionKey = (decision: "approve" | "reject") => `proposal:${decision}`;

export default function ProposalCard({ proposal, offline, asOf, onDecided, feedback: shared }: {
  proposal: ProposalSummary; offline: boolean; asOf?: string;
  onDecided: (decision: "approve" | "reject") => void;
  /** The page's own feedback (Today's): its one toast reports the decision, so this card's notice
   *  never stacks on another in the same spot (UI audit 2026-10-18). Absent, the card keeps its own. */
  feedback?: ReturnType<typeof useActionFeedback>;
}) {
  const [busy, setBusy] = useState(false);
  const [activeDecision, setActiveDecision] = useState<"approve" | "reject" | null>(null);
  const own = useActionFeedback();
  const feedback = shared ?? own;
  const decisionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disabled = offline || busy;
  const activitySentence = proposalActivitySentence(proposal.activityContext);
  useEffect(() => () => { if (decisionTimer.current) clearTimeout(decisionTimer.current); }, []);

  async function decide(decision: "approve" | "reject") {
    setBusy(true); setActiveDecision(decision);
    const result = await feedback.run(() => decideProposalOnline(proposal.id, decision), {
      kind: "commit", failureMessage: decideErrorMessage, key: decisionKey(decision),
    });
    if (!result.ok) { setBusy(false); return; }
    decisionTimer.current = setTimeout(() => {
      setBusy(false); onDecided(decision);
    }, COMMIT_FEEDBACK_MS);
  }

  const decisionFeedback = (decision: "approve" | "reject") => {
    const phase = feedback.phaseFor(decisionKey(decision));
    return activeDecision === decision ? {
      "data-feedback-state": phase === "pending" || phase === "success" ? phase : undefined,
      "aria-busy": phase === "pending" ? true : undefined,
    } : {};
  };

  return (
    <><div className={SHELL_CLASS} style={SHELL}>
      <div style={INNER} className={`${INNER_CLASS} flex flex-col gap-3`}>
        <p className="m-0 text-caption font-normal text-charcoal">
          {deltaSentence(proposal.proposed)}
        </p>
        <p className="m-0 text-tiny font-normal leading-body-sm text-graphite">
          Rest days <MacroLine label="word" values={{ kcal: proposal.proposed.kcalRest,
            protein: proposal.proposed.proteinG, carbs: proposal.proposed.carbG,
            fat: proposal.proposed.fatG }} />. Nothing changes until you tap.
          {asOf ? ` Saved on ${asOf}.` : ""}
        </p>
        {activitySentence && (
          <p className="m-0 text-tiny font-normal leading-body-sm text-graphite">
            {activitySentence}
          </p>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button type="button" disabled={disabled} onClick={() => decide("approve")}
            {...decisionFeedback("approve")}
            className={`tap h-11 rounded-xl bg-on-olive px-5 text-caption font-normal text-olive-shell-bottom disabled:opacity-40 ${
              activeDecision === "approve" ? feedback.controlPropsFor(decisionKey("approve")).className : ""}`}>
            Use these
          </button>
          <button type="button" disabled={disabled} onClick={() => decide("reject")}
            {...decisionFeedback("reject")}
            className={`tap h-11 rounded-xl bg-charcoal/20 px-5 text-caption font-normal text-charcoal disabled:opacity-40 ${
              activeDecision === "reject" ? feedback.controlPropsFor(decisionKey("reject")).className : ""}`}>
            Keep mine
          </button>
        </div>

        {offline && (
          <p className="m-0 text-tiny font-normal text-graphite">
            Needs a connection
          </p>
        )}
      </div>
    </div>{!shared && <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />}</>
  );
}
