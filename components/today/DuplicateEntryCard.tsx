"use client";

import { useId } from "react";
import { Copy } from "lucide-react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { accountHandle } from "@/lib/device/account";
import { fade, spring } from "@/lib/design/motion";
import { keepBoth, scheduleMerge, undoKeepBoth } from "@/lib/duplicates/actions";
import { useOpenDuplicateGroups } from "@/lib/duplicates/use-open-groups";
import type { DuplicateMember, OpenDuplicateGroup } from "@/lib/duplicates/read";
import type { LoggedFood } from "@/lib/types";
import ActionFeedbackToast, { useActionFeedback } from "@/components/ui/ActionFeedback";
import Button from "@/components/ui/Button";
import KcalText from "@/components/ui/KcalText";
import styles from "./DuplicateEntryCard.module.css";

/** "12:30 pm" from an entry's ISO time, in the phone's own zone. */
export function entryTime(at: string): string {
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) return "";
  const h = parsed.getHours();
  const m = parsed.getMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "pm" : "am"}`;
}

/** What the entry held, in the words its card uses. */
export function entryFoods(member: DuplicateMember): string {
  return member.itemNames.length > 0 ? member.itemNames.join(" & ") : member.name || "Logged food";
}

function kcalLine(member: DuplicateMember): string {
  return member.kcal === null ? "kcal pending" : `${member.kcal} kcal`;
}

function MemberRow({ member, kept }: { member: DuplicateMember; kept: boolean }) {
  return <li className={styles.entry}>
    <span className={`${styles.time} text-tiny tabular-nums`}>{entryTime(member.at)}</span>
    <span className={`${styles.foods} text-body-sm`}>{entryFoods(member)}</span>
    <span className={`${styles.kcal} text-tiny tabular-nums`}><KcalText text={kcalLine(member)} /></span>
    {kept && <span className="sr-only"> (kept if you merge)</span>}
  </li>;
}

function GroupCard({ open, feedback, onDecided }: {
  open: OpenDuplicateGroup;
  feedback: ReturnType<typeof useActionFeedback>;
  onDecided: () => void;
}) {
  const titleId = useId();
  const { group, members } = open;
  const survivor = members[0];
  const when = entryTime(survivor.at);
  const keepKey = `keep:${group.id}`;
  const mergeKey = `merge:${group.id}`;

  const onKeepBoth = () => {
    const h = accountHandle();
    void feedback.run(async () => {
      const outcome = await keepBoth(h, group.id);
      onDecided();
      if (outcome === "missing") throw new Error("duplicate group not on this phone");
    }, {
      kind: "change", key: keepKey, successMessage: "Kept both entries.",
      failureMessage: "That did not save. Try again.",
      undo: { action: () => void undoKeepBoth(h, group.id).then(onDecided) },
    });
  };
  const onMerge = () => {
    const h = accountHandle();
    let held: ReturnType<typeof scheduleMerge> | null = null;
    // Nothing is written until the Undo window closes, so Undo puts back exactly what was there.
    void feedback.run(async () => { held = scheduleMerge(h, open); onDecided(); }, {
      kind: "change", key: mergeKey, successMessage: "Merged into one entry.",
      failureMessage: "Could not merge them. Try again.",
      undo: { action: () => { held?.undo(); onDecided(); } },
    });
  };

  return <section aria-labelledby={titleId} className={`surface ${styles.card}`}
    data-testid="duplicate-entry-card">
    <p className={`${styles.eyebrow} text-overline`}>
      <Copy size={16} strokeWidth={1.8} aria-hidden="true" className={styles.icon} />
      Logged twice?
    </p>
    <h3 id={titleId} className={`${styles.title} text-title`}>These look like the same meal</h3>
    <p className={`${styles.lede} text-tiny`}>Both count until you choose.</p>
    <ul className={styles.entries} aria-label="The two entries">
      {members.map((member, index) => <MemberRow key={member.entryId} member={member} kept={index === 0} />)}
    </ul>
    <div className={styles.actions}>
      <Button variant="ghost" confirmLabel="Kept" {...feedback.controlPropsFor(keepKey)}
        aria-label={`Keep both entries from ${when}`} onClick={onKeepBoth}>Keep both</Button>
      <Button variant="primary" confirmLabel="Merged" {...feedback.controlPropsFor(mergeKey)}
        aria-label={`Merge into one entry, keeping the ${when} entry`} onClick={onMerge}>Merge</Button>
    </div>
  </section>;
}

/**
 * Today's "Logged twice?" card (architecture §3.7): one compact card per open duplicate group on
 * the viewed day, with Keep both and Merge. Renders nothing while no group is open; the Undo for
 * either outlives the card in the shared ActionFeedback toast.
 */
export default function DuplicateEntryCard({ date, extras }: { date: string; extras: readonly LoggedFood[] }) {
  const { groups, reload } = useOpenDuplicateGroups(date, extras);
  const feedback = useActionFeedback();
  const reduce = useReducedMotionConfig();
  const onDecided = () => void reload();
  if (groups.length === 0 && !feedback.notice) return null;
  return <>
    <AnimatePresence initial={false}>
      {groups.map((open) => <motion.div key={open.group.id} className={`shell ${styles.frame}`}
        layout="position"
        initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ height: spring("smooth", reduce), opacity: fade("base", reduce), layout: spring("smooth", reduce) }}>
        <GroupCard open={open} feedback={feedback} onDecided={onDecided} />
      </motion.div>)}
    </AnimatePresence>
    <ActionFeedbackToast notice={feedback.notice} onDismiss={feedback.dismiss} />
  </>;
}
