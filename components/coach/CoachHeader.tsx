"use client";

import type { ReactNode } from "react";
import SashaMark from "@/components/coach/SashaMark";
import { scopeLabel, type ChatScope } from "@/components/dock/chat-scope";
import { ASSISTANT_NAME } from "@/lib/brand";
import styles from "./CoachHeader.module.css";

/**
 * The chat's header, on /coach and in the dock's chat overlay (U21, 2026-10-04): the living mark,
 * the assistant's name, and a line saying where the next answer is about ("On Today", "Whole app").
 * While a turn is in flight the mark speeds up; the transcript's own thinking line is the one place
 * that says so in words (Kimi K5, 2026-10-04: the header, the transcript and the dock all said
 * "Thinking…" at once).
 * `trailing` is the screen's own control: Conversations on /coach, Open full chat and close in the
 * overlay.
 */
export default function CoachHeader({ variant, scope, thinking, trailing }: {
  variant: "page" | "overlay";
  scope: ChatScope;
  thinking: boolean;
  trailing?: ReactNode;
}) {
  const page = variant === "page";
  const label = scopeLabel(scope);
  const Title = page ? "h1" : "h2";
  return <div className={`${styles.head} ${page ? "" : styles.compact}`.trim()} data-coach-header={variant}>
    <SashaMark thinking={thinking} size={page ? 32 : 28} />
    <div className={styles.titles}>
      <Title className={page ? "ground m-0 text-display-md font-light leading-none tracking-display-md"
        : "m-0 font-display text-title font-normal leading-none"}>{ASSISTANT_NAME}</Title>
      {/* Where the answers are about: plain metadata, not a control (Kimi audit 2026-10-04). While a
          turn runs only its dot quickens with the mark; the transcript's own line says it in words. */}
      <span className={`${styles.scope} text-tiny font-medium`} data-scope={scope.kind}>
        <span className={styles.scopeDot} data-thinking={thinking ? "true" : undefined} aria-hidden="true" />
        {label}
      </span>
    </div>
    {trailing}
  </div>;
}

/** The count beside Conversations. */
export function ConversationCount({ count }: { count: number }) {
  return <span className={`${styles.count} text-tiny`} aria-hidden="true">{count}</span>;
}
