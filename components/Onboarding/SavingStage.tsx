"use client";

/**
 * Onboarding v2 — the full-screen "Building your plan…" state (live QA 2026-10-07, defect 6:
 * "Use this plan" took more than 8 s with only three 5 px dots on the button). It covers the whole
 * shell from the tap until the route changes, so a second tap is impossible and the wait reads as
 * work, not a freeze. Sprout thinks; one line says what is being saved now. The skip path uses the
 * same stage with its own words.
 */
import { motion, useReducedMotionConfig } from "motion/react";
import { INSTANT, SPRINGS } from "@/lib/design/motion";
import SproutGuide from "@/components/Onboarding/SproutGuide";
import styles from "./ConversationalOnboarding.module.css";

export default function SavingStage({ title, step }: { title: string; step: string }) {
  const reduce = useReducedMotionConfig() ?? false;
  return <motion.div role="status" aria-live="polite" aria-busy="true" data-testid="onboarding-saving"
    className={`${styles.saving} matte`}
    initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }}
    transition={reduce ? INSTANT : SPRINGS.smooth}>
    <SproutGuide pose="thinking" line="Sprout is working on it." size={140} />
    <p className="m-0 text-center font-serif text-heading text-charcoal">{title}</p>
    <p className="m-0 text-center text-body text-graphite">{step}</p>
    <span className="mt-2 flex gap-1.5" aria-hidden="true">
      {[0, 1, 2].map((index) => <motion.span key={index}
        className="size-2 rounded-full bg-[rgb(var(--ink-rgb)/0.7)]"
        animate={reduce ? undefined : { opacity: [0.25, 1, 0.25] }}
        transition={{ duration: 1.2, repeat: Infinity, delay: index * 0.2, ease: "easeInOut" }} />)}
    </span>
  </motion.div>;
}
