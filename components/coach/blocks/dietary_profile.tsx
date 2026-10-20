"use client";

/**
 * Phase 13 slice 4 (§4, §9 R5): the chat confirm card for a stated dietary need. Renders nothing
 * on its own tap — no write happens until "Yes, add this" or an item's own "Confirm" is
 * tapped, and "Not now" writes nothing at all. Self-contained: it reads the account directly
 * (accountHandle()), the same as components/Onboarding/DietaryProfilePicker.tsx's container, so
 * CoachBlockContext (components/coach/blocks/context.ts) needs no new field for it.
 */
import { useState } from "react";
import { Pill } from "@/components/Sheet";
import { accountHandle } from "@/lib/device/account";
import {
  confirmFoodPreference, confirmProfileInstance, type FacetConfirmation,
} from "@/lib/profile/instances-client";
import { FOOD_PREFERENCE_PROFILE_ID } from "@/lib/policy/profiles/food-preference-rule";
import {
  isMedicalItem, itemLabel, needsOwnConfirmation,
} from "@/lib/policy/profiles/catalog-summary";
import type { DietaryProfileProposalBlockV1 } from "@/lib/coach/ui-blocks";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";

const CAPTION = "text-tiny font-normal text-muted";

type Status = "pending" | "confirmed" | "dismissed";

export default function DietaryProfileProposalBlock({
  block,
}: {
  block: DietaryProfileProposalBlockV1;
}) {
  const [status, setStatus] = useState<Status>("pending");
  const [blanketDone, setBlanketDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmedFacets, setConfirmedFacets] = useState<ReadonlySet<string>>(new Set());
  const feedback = useActionFeedback();

  // Map §4 item-level confirmation: medical items and an item-level profile's hard rules each
  // get their own row and tap; only the rest ride the blanket "Yes, add this".
  const own = block.items.filter((item) => needsOwnConfirmation(block, item));
  const blanket = block.items.filter((item) => !needsOwnConfirmation(block, item));
  const remainingOwn = own.filter((item) => !confirmedFacets.has(item.facet));

  // Phase 13 slice 7: a like/dislike card has one soft `food_named:` item and its own write.
  async function write(confirmations: FacetConfirmation[]): Promise<void> {
    const item = block.items[0];
    if (block.profileId === FOOD_PREFERENCE_PROFILE_ID
        && (item.strength === "prefer" || item.strength === "avoid")) {
      await confirmFoodPreference(accountHandle(), item.facet.replace(/^food_named:/, ""),
        item.strength);
      return;
    }
    await confirmProfileInstance(accountHandle(), block.profileId, confirmations);
  }

  async function confirm(confirmations: FacetConfirmation[], blanket: boolean): Promise<void> {
    if (confirmations.length === 0) return;
    setBusy(true);
    const result = await feedback.run(() => write(confirmations), {
      kind: "commit", failureMessage: "That did not save. Try again.",
    });
    if (result.ok) {
      setConfirmedFacets((current) =>
        new Set([...current, ...confirmations.map((c) => c.facet)]));
      if (blanket) setBlanketDone(true);
    }
    setBusy(false);
  }

  if (status === "dismissed") {
    return <p className={`meal-card ml-4 m-0 px-4 py-3 ${CAPTION}`}>Not added.</p>;
  }

  const showBlanket = !blanketDone && blanket.length > 0;
  const untouched = !blanketDone && confirmedFacets.size === 0;
  const done = (blanketDone || blanket.length === 0) && remainingOwn.length === 0;
  const pendingStyle = done ? undefined : {
    outline: "1px solid var(--color-feedback-pending)",
    boxShadow: "0 0 18px color-mix(in srgb, var(--color-feedback-pending) 24%, transparent)",
  };

  return (
    <><div className={`meal-card ml-4 ${feedback.controlProps.className}`} data-block-id={block.id}
      data-feedback-state={feedback.controlProps["data-feedback-state"]} style={pendingStyle}>
      <div className="meal-card-in flex-col gap-2 p-3">
        <h3 className="m-0 text-caption font-semibold text-on-charcoal">{block.label}</h3>
        {block.do.length > 0 && <p className={`m-0 ${CAPTION}`}>{`Do: ${block.do.join(" ")}`}</p>}
        {block.dont.length > 0
          && <p className={`m-0 ${CAPTION}`}>{`Don’t: ${block.dont.join(" ")}`}</p>}
        {(showBlanket || untouched) && <div className="flex gap-2">
          {showBlanket && <Pill active={false} disabled={busy} onClick={() => void confirm(blanket
            .map((item) => ({ facet: item.facet, confirmed: true })), true)}>
            Yes, add this
          </Pill>}
          {untouched && <Pill active={false} disabled={busy} onClick={() => setStatus("dismissed")}>
            Not now
          </Pill>}
        </div>}
        {remainingOwn.length > 0 && <div className="flex flex-col gap-2">
          <p className={`m-0 ${CAPTION}`}>
            {own.some(isMedicalItem)
              ? "Your clinician’s advice comes first."
              : "Each rule applies only once you confirm it."}
          </p>
          {remainingOwn.map((item) => (
            <div key={item.facet} className="flex items-center justify-between gap-3">
              <span className={CAPTION}>{itemLabel(item)}</span>
              <button type="button" disabled={busy} aria-label={`Confirm ${itemLabel(item)}`}
                onClick={() => void confirm([{ facet: item.facet, confirmed: true }], false)}
                className="tap min-h-11 text-tiny font-normal text-charcoal underline disabled:opacity-40">
                Confirm
              </button>
            </div>
          ))}
        </div>}
        {done && <p className={`m-0 ${CAPTION}`}>Added to your profile.</p>}
      </div>
    </div><ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} /></>
  );
}
