"use client";

/**
 * Onboarding v2 beats: a follow-up that opens below its chip. The box grows on the smooth spring
 * (`AutoHeight`) and the content fades in once it has room, so nothing appears in a cut; under
 * reduced motion it simply arrives. Hidden content is unmounted, never left tabbable.
 */
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import AutoHeight from "@/components/ui/AutoHeight";
import { fade } from "@/lib/design/motion";

export default function Reveal({ id, open, children }: { id?: string; open: boolean; children: ReactNode }) {
  const reduce = useReducedMotionConfig() ?? false;
  return <AutoHeight>
    <AnimatePresence initial={false}>
      {open && <motion.div key="reveal" id={id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: fade("quick", reduce) }} transition={fade("base", reduce)}>
        {children}
      </motion.div>}
    </AnimatePresence>
  </AutoHeight>;
}
