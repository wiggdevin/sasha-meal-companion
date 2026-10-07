"use client";
/**
 * The one ask-box surface. The dock's assistant ask field (components/dock/AssistantField.tsx) and
 * every meal-card panel's AI box (components/plan/PlanComposer.tsx) draw from these pieces, so the
 * charcoal composer skin, its olive rim and focus ring, the cream text, the light under the finger
 * and the springs a control pops in on stay one thing. Styles live in TabBar.module.css only.
 */
import { forwardRef, type FormEvent, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { INSTANT, PRESS, sheen, sheenOff } from "@/components/dock/dock-motion";
import styles from "@/components/TabBar.module.css";

/** The composer skin under an open field; fades in as the dock bubble opens. */
export function AskSkin({ open = true, reduce }: { open?: boolean; reduce?: boolean }) {
  return <motion.span aria-hidden="true" className={styles.composerSkin} initial={false}
    animate={{ opacity: open ? 1 : 0 }} transition={reduce ? INSTANT : { duration: 0.28 }} />;
}

/** A round control that pops in and out on the house press spring (clear, send). */
export function AskPop({ show, popKey, label, onClick, disabled, reduce, type = "button", composerAction,
  children }: {
  show: boolean; popKey: string; label: string; onClick?: () => void; disabled?: boolean;
  reduce?: boolean | null; type?: "button" | "submit"; composerAction?: boolean; children: ReactNode;
}) {
  return <AnimatePresence initial={false}>
    {show && <motion.button key={popKey} type={type} aria-label={label} onClick={onClick}
      data-composer-action={composerAction ? true : undefined} disabled={disabled}
      className={`${styles.tab} tap flex size-11 shrink-0 items-center justify-center rounded-full disabled:opacity-40`}
      initial={reduce ? false : { opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }}
      exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, scale: 0.6, transition: { duration: 0.1 } }}
      whileTap={reduce ? undefined : { scale: 0.92 }}
      transition={reduce ? INSTANT : PRESS}>
      {children}
    </motion.button>}
  </AnimatePresence>;
}

/** A plain round glyph control in the field (camera, attach), pressing on the same spring. */
export function AskIconButton({ label, onClick, disabled, children }: {
  label: string; onClick: () => void; disabled?: boolean; children: ReactNode;
}) {
  const reduce = useReducedMotion();
  return <motion.button type="button" aria-label={label} disabled={disabled} onClick={onClick}
    className={`${styles.tab} tap flex size-11 shrink-0 items-center justify-center rounded-full disabled:opacity-40`}
    whileTap={reduce ? undefined : { scale: 0.92 }} transition={reduce ? INSTANT : PRESS}>
    {children}
  </motion.button>;
}

/** The input's class: the dock's own text, placeholder and line height. 16 px, so iOS never zooms
 *  into the field and every ask tier reads at the same size (U12, 2026-10-04). */
export const ASK_INPUT_CLASS =
  `${styles.coachInput} min-w-0 flex-1 resize-none bg-transparent px-1 py-3 text-body font-normal outline-none disabled:opacity-40`;

/**
 * A standing (always open) ask field in the dock's material: the glass body, the composer skin and
 * the focus ring, as a form. `matte` maps the text roles to cream as they are inside the dock.
 */
export const AskField = forwardRef<HTMLFormElement, {
  label: string; onSubmit: (event: FormEvent<HTMLFormElement>) => void; children: ReactNode;
}>(function AskField({ label, onSubmit, children }, ref) {
  return <form ref={ref} aria-label={label} onSubmit={onSubmit} data-open="true" data-ask-field="true"
    onPointerMove={sheen} onPointerLeave={sheenOff}
    className={`${styles.glass} ${styles.assistant} matte relative flex h-16 min-w-0 items-center gap-0.5 overflow-hidden pl-2.5 pr-2.5`}
    style={{ borderRadius: 32 }}>
    <AskSkin />
    <div className="relative z-[1] flex min-w-0 flex-1 items-center gap-0.5">{children}</div>
  </form>;
});
