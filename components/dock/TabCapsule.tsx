"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AnimatePresence, animate, motion, useMotionTemplate, useMotionValue, useTransform, useVelocity,
} from "motion/react";
import { Activity, House, Settings, Utensils, type LucideIcon } from "lucide-react";
import {
  ACTIVE_WEIGHT, BUBBLE, FADE, INSTANT, LEAD_EDGE, MORPH, PAD, PRESS, TAB_GAP, TAB_MOVE, TRAIL_EDGE,
  lensVar, sheen, sheenOff,
} from "@/components/dock/dock-motion";
import styles from "@/components/TabBar.module.css";

type Tab = { href: string; label: string; icon: LucideIcon };

/** The capsule's four destinations. The assistant lives in its own bubble beside it on every screen. */
export const TABS: Tab[] = [
  { href: "/", label: "Today", icon: House },
  { href: "/body", label: "Body", icon: Activity },
  { href: "/foods", label: "Foods", icon: Utensils },
  { href: "/settings", label: "Settings", icon: Settings },
];

type Slot = { x: number; w: number };

export function tabSlots(width: number, count: number, active: number, glyphOnly: boolean): Slot[] {
  const weights = Array.from({ length: count }, (_, i) => (i === active && !glyphOnly ? ACTIVE_WEIGHT : 1));
  const unit = (width - PAD * 2 - TAB_GAP * (count - 1)) / weights.reduce((sum, w) => sum + w, 0);
  let x = PAD;
  return weights.map((weight) => {
    const slot = { x, w: weight * unit };
    x += slot.w + TAB_GAP;
    return slot;
  });
}

/** The last capsule tab visited: the folded capsule shows it while the assistant has the dock. */
let lastTabIndex = 0;
export function rememberTab(index: number) { if (index >= 0) lastTabIndex = index; }

function TabFace({ tab, active, glyphOnly, reduce }: {
  tab: Tab; active: boolean; glyphOnly: boolean; reduce: boolean;
}) {
  const Icon = tab.icon;
  return <>
    <Icon size={22} strokeWidth={active ? 1.8 : 1.5} aria-hidden="true" className="shrink-0" />
    <AnimatePresence initial={false}>
      {active && !glyphOnly && <motion.span key="label"
        className="overflow-hidden whitespace-nowrap text-caption font-medium"
        initial={reduce ? false : { width: 0, opacity: 0, filter: "blur(4px)" }}
        animate={{ width: "auto", opacity: 1, filter: "blur(0px)" }}
        exit={reduce ? { opacity: 0, transition: INSTANT } : { width: 0, opacity: 0, filter: "blur(4px)" }}
        transition={reduce ? INSTANT : { ...TAB_MOVE, opacity: { duration: 0.2, delay: 0.05 } }}>
        <span className="pl-2">{tab.label}</span>
      </motion.span>}
    </AnimatePresence>
  </>;
}

/** The white selection lens: two edges on two springs, so it stretches in flight and lands soft. */
function useLens(slots: Slot[] | null, active: number, reduce: boolean) {
  const left = useMotionValue(0);
  const right = useMotionValue(0);
  const shown = useMotionValue(0);
  const placed = useRef(false);
  const target = slots && active >= 0 ? slots[active] : null;
  const targetX = target?.x ?? null;
  const targetR = target ? target.x + target.w : null;

  useLayoutEffect(() => {
    if (targetX === null || targetR === null) {
      if (reduce) shown.jump(0); else animate(shown, 0, FADE);
      placed.current = false;
      return;
    }
    if (!placed.current || reduce) {
      left.jump(targetX); right.jump(targetR);
      if (reduce) shown.jump(1); else animate(shown, 1, { duration: 0.22 });
      placed.current = true;
      return;
    }
    const rightward = targetX > left.get();
    const l = animate(left, targetX, rightward ? TRAIL_EDGE : LEAD_EDGE);
    const r = animate(right, targetR, rightward ? LEAD_EDGE : TRAIL_EDGE);
    return () => { l.stop(); r.stop(); };
  }, [targetX, targetR, reduce, left, right, shown]);

  const width = useTransform(() => right.get() - left.get());
  const speed = useVelocity(left);
  // Fast travel flattens the lens a touch, like a drop of liquid being pulled.
  const scaleY = useTransform(speed, [-2600, 0, 2600], [0.86, 1, 0.86]);
  const scale = useTransform(shown, [0, 1], [0.7, 1]);
  return { left, right, width, scaleY, shown, scale };
}

/** The four-tab capsule: a white lens on two springs, black ink wherever the lens covers a glyph. */
export default function TabCapsule({ activeIndex, folded, width, glyphOnly, reduce, onUnfold }: {
  activeIndex: number; folded: boolean; width: number; glyphOnly: boolean; reduce: boolean;
  onUnfold: () => void;
}) {
  const measured = width > 0;
  const slots = measured ? tabSlots(width, TABS.length, activeIndex, glyphOnly) : null;
  // The first measured layout lands in place; only later changes travel.
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!measured || live) return;
    const frame = requestAnimationFrame(() => setLive(true));
    return () => cancelAnimationFrame(frame);
  }, [measured, live]);
  const lens = useLens(slots, activeIndex, reduce);
  const layerWidth = useMotionValue(width);
  useLayoutEffect(() => { layerWidth.set(width); }, [width, layerWidth]);
  const rightInset = useTransform(() => layerWidth.get() - lens.right.get());
  const reveal = useMotionTemplate`inset(0px ${rightInset}px 0px ${lens.left}px round 26px)`;
  // Under reduced motion the lens jumps, and a jumped value does not always reach the template
  // (2026-10-01: the ink stayed on the previous tab), so the ink is clipped straight to the slot.
  const activeSlot = slots && activeIndex >= 0 ? slots[activeIndex] : null;
  const still = activeSlot ? `inset(0px ${width - activeSlot.x - activeSlot.w}px 0px ${activeSlot.x}px round 26px)` : "inset(0px 100%)";
  const FoldedIcon = TABS[activeIndex >= 0 ? activeIndex : lastTabIndex].icon;

  const tabs = (face: "base" | "ink") => TABS.map((tab, index) => {
    const active = index === activeIndex;
    const slot = slots?.[index];
    const common = "flex h-[52px] min-w-11 items-center justify-center rounded-full";
    const position = slot
      ? { initial: false as const, animate: { x: slot.x, width: slot.w }, transition: reduce || !live ? INSTANT : TAB_MOVE }
      : {};
    const style = slot
      ? { position: "absolute" as const, left: 0, top: PAD }
      : { flexGrow: active && !glyphOnly ? ACTIVE_WEIGHT : 1, flexBasis: 0 };
    if (face === "ink") return <motion.span key={measured ? `${tab.href}:placed` : tab.href} aria-hidden="true" className={common}
      style={style} {...position}>
      <TabFace tab={tab} active={active} glyphOnly={glyphOnly} reduce={reduce} />
    </motion.span>;
    return <motion.div key={measured ? `${tab.href}:placed` : tab.href} className="flex h-[52px] min-w-11" style={style} {...position}>
      <Link href={tab.href} aria-current={active ? "page" : undefined}
        aria-label={active && !glyphOnly ? undefined : tab.label}
        onClick={() => { lastTabIndex = index; }}
        className={`${styles.tab} ${common} tap w-full min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
        <motion.span className="flex items-center justify-center" whileTap={reduce ? undefined : { scale: 0.86 }}
          transition={PRESS}>
          <TabFace tab={tab} active={active} glyphOnly={glyphOnly} reduce={reduce} />
        </motion.span>
      </Link>
    </motion.div>;
  });

  return <motion.div data-dock-capsule="true" className={`${styles.glass} relative h-16 shrink-0 overflow-hidden`}
    style={{ ...lensVar(folded ? "round" : "pill"),
      ...(measured ? { width: folded ? BUBBLE : width } : folded ? { width: BUBBLE } : { flex: "1 1 0", minWidth: 0 }) }}
    initial={false} animate={measured ? { width: folded ? BUBBLE : width } : undefined}
    transition={reduce ? INSTANT : MORPH}
    whileTap={reduce || folded ? undefined : { scale: 0.985 }}
    onPointerMove={sheen} onPointerLeave={sheenOff}>
    <motion.div inert={folded} className={`absolute inset-y-0 left-0 ${measured ? "" : "right-0 flex items-center gap-1 p-1.5"}`}
      style={measured ? { width } : undefined}
      initial={false}
      animate={folded ? { opacity: 0, scale: 0.9, filter: "blur(8px)" } : { opacity: 1, scale: 1, filter: "blur(0px)" }}
      transition={reduce ? INSTANT : folded ? FADE : { ...FADE, delay: 0.08 }}>
      {measured && <motion.span aria-hidden="true" data-dock-lens="true" className={styles.lens}
        style={{ x: lens.left, width: lens.width, scaleY: lens.scaleY, opacity: lens.shown, scale: lens.scale, top: PAD }} />}
      {tabs("base")}
      {measured && <motion.div aria-hidden="true" className={styles.ink} style={{ clipPath: reduce ? still : reveal }}>
        {tabs("ink")}
      </motion.div>}
    </motion.div>
    <AnimatePresence initial={false}>
      {folded && <motion.button key="unfold" type="button" onClick={onUnfold}
        aria-label="Show all tabs" title="Show all tabs"
        className={`${styles.tab} tap absolute inset-0 flex items-center justify-center rounded-full`}
        initial={reduce ? false : { opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }}
        exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, scale: 0.6, transition: { duration: 0.12 } }}
        transition={reduce ? INSTANT : { ...PRESS, delay: 0.1 }}
        whileTap={reduce ? undefined : { scale: 0.86 }}>
        <FoldedIcon size={22} strokeWidth={1.6} aria-hidden="true" />
      </motion.button>}
    </AnimatePresence>
  </motion.div>;
}
