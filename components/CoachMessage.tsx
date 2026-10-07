"use client";

/**
 * One transcript bubble. Plain text only — never HTML, never a markdown link. A URL in the text
 * renders as inert characters (spec "Client changes"), so a planted link cannot be tapped.
 *
 * Their bubble is the ink gradient from DESIGN.md > Buttons > Primary; his is the glass card
 * surface. Body is 14 px/300, the DESIGN.md body-md token.
 */

import { motion, useReducedMotion } from "motion/react";
import AiLabel, { aiLabelCopy } from "@/components/ui/AiLabel";
import type { Provenance } from "@/lib/types";

// A bubble rises 8 px into place as it arrives — DESIGN.md §Motion, card entrance, shortened.
const RISE_EASE = [0.2, 0.8, 0.2, 1] as const;

export default function CoachMessage({
  role, content, pending, provenance,
}: {
  role: "user" | "assistant"; content: string; pending?: boolean;
  /** Who wrote an assistant reply (PR #373); an AI reply carries the AI label at its foot. */
  provenance?: Provenance;
}) {
  const mine = role === "user";
  /* A message that has not landed yet is the pale olive outline of the bubble it becomes, ink on
     paper, so it reads as "on its way" without dropping the words below 4.5:1 (the old 60 % fade
     did; Kimi audit 2026-10-04). */
  const pendingMine = mine && pending === true;
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className={`flex ${mine ? "justify-end" : "justify-start"}`}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.35, ease: RISE_EASE }}
    >
      <div
        className={`rounded-2xl! ${mine ? "" : "shell"}`}
        data-pending={pending ? "true" : undefined}
        style={{ maxWidth: "82%" }}
      >
        <p
          className={`m-0 whitespace-pre-wrap break-words px-4 py-3 text-caption font-normal leading-label-md rounded-[length:var(--bubble-radius)] ${
            mine && !pendingMine ? "text-on-primary" : "text-charcoal"
          }`}
          style={{
            // 20px / 19px is not one of the five radius steps (tests/design/scale.test.ts) — a
            // custom property keeps the exact bubble shape without a literal `borderRadius` key
            // (tests/design/inline-style.test.ts).
            "--bubble-radius": mine ? "20px" : "19px",
            background: pendingMine ? "rgb(var(--primary-rgb) / 0.12)" : mine
              ? "var(--grad-ink)"
              : "var(--grad-bubble)",
            boxShadow: pendingMine ? "inset 0 0 0 1px rgb(var(--primary-rgb) / 0.4)"
              : mine ? "inset 0 1px 1px rgba(255,255,255,0.12)" : undefined,
            backdropFilter: mine ? undefined : "blur(24px) saturate(150%)",
          } as React.CSSProperties}
        >
          {content}
          {/* In flow at the bubble's foot: it rides the bubble's own rise, with no motion of its own. */}
          {!mine && aiLabelCopy(provenance) && <span className="flex pt-2"><AiLabel provenance={provenance} /></span>}
        </p>
      </div>
    </motion.div>
  );
}
