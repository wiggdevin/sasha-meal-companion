"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig, type Variants } from "motion/react";
import { FADES, INSTANT, SPRINGS, type SpringName } from "@/lib/design/motion";

/** Every expanding row and revealed body opens on one spring (DESIGN.md §Motion: containers); a row
 *  inside a surface that morphs on another spring (the meal card: gentle) rides that one instead. */
const DEFAULT_SPRING: SpringName = "smooth";
/** Closing, the body has begun to fade before the height starts to fold. */
const FOLD_DELAY = 0.06;
/** Opening, the body waits for the height to get going, then fades and lifts into place. */
const REVEAL_DELAY = 0.08;
const LIFT_PX = 6;

function panelVariants(reduce: boolean, spring: SpringName): Variants {
  return {
    open: { height: "auto", transition: reduce ? INSTANT : SPRINGS[spring] },
    closed: { height: 0, transition: reduce ? INSTANT : { ...SPRINGS[spring], delay: FOLD_DELAY } },
  };
}

function bodyVariants(reduce: boolean): Variants {
  return {
    open: { opacity: 1, y: 0, transition: reduce ? INSTANT : { ...FADES.base, delay: REVEAL_DELAY } },
    closed: { opacity: 0, y: LIFT_PX, transition: reduce ? INSTANT : FADES.quick },
  };
}

/** The inline styles a find-in-page reveal sets, on the panel and on its body. */
function setRevealStyles(el: HTMLElement, on: boolean) {
  const body = el.firstElementChild as HTMLElement | null;
  if (on) {
    el.style.height = "auto";
    if (body) { body.style.opacity = "1"; body.style.transform = "none"; }
    return;
  }
  el.style.removeProperty("height");
  body?.style.removeProperty("opacity");
  body?.style.removeProperty("transform");
}

/** Find-in-page: a closed body is `hidden="until-found"` where the browser supports it, so a match
 *  inside it opens it. React renders `hidden` as a boolean, so the value is set here. The reveal's
 *  inline styles are cleared as soon as the open state changes, so only the spring owns the panel
 *  and the next close folds it (Motion also rewrites them on its next frame; this does not rely on
 *  that). */
function useUntilFound(ref: React.RefObject<HTMLDivElement | null>, open: boolean, hidden: boolean,
  onFound: () => void) {
  const found = useRef(onFound);
  const revealed = useRef(false);
  useLayoutEffect(() => { found.current = onFound; });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !revealed.current) return;
    revealed.current = false;
    setRevealStyles(el, false);
  }, [ref, open]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && hidden && "onbeforematch" in el) el.setAttribute("hidden", "until-found");
  }, [ref, hidden]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The browser has already revealed the body to scroll to the match: arrive at once, no spring.
    const reveal = () => {
      revealed.current = true;
      setRevealStyles(el, true);
      found.current();
    };
    el.addEventListener("beforematch", reveal);
    return () => el.removeEventListener("beforematch", reveal);
  }, [ref]);
}

/** A body that stays in the document while closed (hidden, still findable, form state kept). */
function MountedPanel({ id, open, onFound, className, spring, children }: {
  id: string; open: boolean; onFound: () => void; className: string; spring: SpringName; children: ReactNode;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const ref = useRef<HTMLDivElement | null>(null);
  // `folded`: closed and finished folding, so the body can leave layout and the accessibility tree.
  // `settled`: open and finished growing, so the body stops clipping (focus rings, shadows show).
  const [folded, setFolded] = useState(!open);
  const [settled, setSettled] = useState(open);
  const [was, setWas] = useState(open);
  if (was !== open) {
    setWas(open);
    setFolded(!open && reduce);
    setSettled(open && reduce);
  }
  const hidden = !open && folded;
  useUntilFound(ref, open, hidden, onFound);
  return <motion.div ref={ref} id={id} hidden={hidden} inert={!open}
    className={open && settled ? undefined : "overflow-clip"}
    initial={false} animate={open ? "open" : "closed"} variants={panelVariants(reduce, spring)}
    onAnimationComplete={(state) => {
      if (state === "closed" && !open) setFolded(true);
      if (state === "open" && open) setSettled(true);
    }}>
    <motion.div className={className} variants={bodyVariants(reduce)}>{children}</motion.div>
  </motion.div>;
}

/** A body that mounts on open and unmounts once it has folded (heavy or stateful content). */
function PresencePanel({ id, className, spring, children }: {
  id: string; className: string; spring: SpringName; children: ReactNode;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const present = useIsPresent();
  return <motion.div id={id} inert={!present} aria-hidden={present ? undefined : true}
    className="overflow-clip" initial="closed" animate="open" exit="closed" variants={panelVariants(reduce, spring)}>
    <motion.div className={className} variants={bodyVariants(reduce)}>{children}</motion.div>
  </motion.div>;
}

/**
 * The one animated body for anything that expands (docs/design/KIT.md §Expanding): the height
 * springs open and folds on `smooth`, the content fades and lifts in once the height is moving and
 * fades out first on close, and nothing below jumps. Only height moves, so a card's corners stay
 * crisp. Reduced motion: it simply arrives. Pair it with a button that carries `aria-expanded` and
 * `aria-controls={id}` — or use `Disclosure`, which does.
 *
 * `keepMounted` (default): the closed body stays in the document, hidden (`until-found`, so
 * find-in-page opens it via `onFound`), and keeps its form state. `keepMounted={false}`: the body
 * mounts on open and unmounts after folding.
 */
export function DisclosurePanel({ id, open, keepMounted = true, onFound, className = "", spring = DEFAULT_SPRING,
  children }: {
  id: string;
  open: boolean;
  keepMounted?: boolean;
  onFound?: () => void;
  className?: string;
  spring?: SpringName;
  children: ReactNode;
}) {
  if (keepMounted) {
    return <MountedPanel id={id} open={open} onFound={onFound ?? (() => {})} className={className} spring={spring}>
      {children}</MountedPanel>;
  }
  return <AnimatePresence initial={false}>
    {open && <PresencePanel key="panel" id={id} className={className} spring={spring}>{children}</PresencePanel>}
  </AnimatePresence>;
}

/** The disclosure chevron: points down closed, turns to point up open, on the panel's spring. */
export function DisclosureChevron({ open, size = 20, className = "", spring = DEFAULT_SPRING }: {
  open: boolean; size?: number; className?: string; spring?: SpringName;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  return <motion.svg className={`disclosure-chevron shrink-0 text-muted ${className}`.trim()} width={size} height={size}
    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true" focusable="false"
    initial={false} animate={{ rotate: open ? 180 : 0 }} transition={reduce ? INSTANT : SPRINGS[spring]}>
    <path d="M6 9l6 6 6-6" />
  </motion.svg>;
}

const SIZES = {
  md: { row: "min-h-12", title: "text-body-md", chevron: 20 },
  sm: { row: "min-h-11", title: "text-caption", chevron: 16 },
} as const;

/**
 * The one expanding row (docs/design/KIT.md §Expanding). `card`: an ivory card whose header is the
 * toggle and whose body opens inside the same card. `row`: the same behaviour as one line inside a
 * card or a sheet (`divider` draws the hairline above it). The header is a real button with
 * `aria-expanded` / `aria-controls`, so Enter and Space toggle it; the body is a `DisclosurePanel`.
 * Uncontrolled by default (`defaultOpen`); pass `open` and `onOpenChange` to control it.
 * The title wraps on a narrow phone; `truncate` cuts it to one line, for a known short label only.
 */
export default function Disclosure({ title, aside, count, variant = "card", size = "md", divider = false,
  heading, titleClassName, truncate = false, defaultOpen = false, open: openProp, onOpenChange, keepMounted = true, className = "", bodyClassName,
  spring = DEFAULT_SPRING, children }: {
  title: ReactNode;
  /** Quiet text before the chevron: a count, a duration, a share. */
  aside?: ReactNode;
  /** @deprecated use `aside`. */
  count?: ReactNode;
  variant?: "card" | "row";
  size?: keyof typeof SIZES;
  divider?: boolean;
  /** The header is a section heading (a page's Recipes card): the toggle sits inside an h2 or h3,
   *  so heading navigation still finds it. */
  heading?: 2 | 3;
  /** The title's type when a card's role sets it (a meal card's section: lib/design/meal-type.ts). */
  titleClassName?: string;
  /** Cut the title to one line instead of wrapping it. */
  truncate?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  keepMounted?: boolean;
  className?: string;
  bodyClassName?: string;
  /** The spring the body opens on; defaults to the container spring. */
  spring?: SpringName;
  children: ReactNode;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = openProp ?? own;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOwn(next);
    onOpenChange?.(next);
  };
  const id = useId().replace(/:/g, "");
  const panelId = `${id}-panel`;
  const s = SIZES[size];
  const note = aside ?? count;
  const toggle = (
    <button type="button" id={`${id}-toggle`} aria-expanded={open} aria-controls={panelId}
      onClick={() => setOpen(!open)}
      className={`disclosure-summary tap flex ${s.row} cursor-pointer items-center gap-3 py-2 ${variant === "card" ? "px-4" : "px-0"}`}>
      <span className={`min-w-0 flex-1 ${truncate ? "truncate" : "break-words"} ${titleClassName ?? `${s.title} font-medium text-charcoal`}`}>{title}</span>
      {note != null && note !== false && <span className="shrink-0 text-tiny text-muted tabular-nums">{note}</span>}
      <DisclosureChevron open={open} size={s.chevron} spring={spring} />
    </button>
  );
  const header = heading === 2 ? <h2 className="m-0 font-normal">{toggle}</h2>
    : heading === 3 ? <h3 className="m-0 font-normal">{toggle}</h3> : toggle;
  const body = <DisclosurePanel id={panelId} open={open} keepMounted={keepMounted} onFound={() => setOpen(true)} spring={spring}
    className={bodyClassName ?? (variant === "card" ? "px-4 pb-4" : "pb-2")}>{children}</DisclosurePanel>;
  if (variant === "row") {
    return <div className={`disclosure flex flex-col ${divider ? "border-t border-hairline" : ""} ${className}`.trim()}>
      {header}{body}</div>;
  }
  return (
    <div className={`shell w-full ${className}`.trim()}>
      <div className="surface disclosure block py-1">{header}{body}</div>
    </div>
  );
}
