"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AnimatePresence, animate, motion, useMotionTemplate, useMotionValue, useTransform, useVelocity,
} from "motion/react";
import { Activity, House, Settings, Utensils, type LucideIcon } from "lucide-react";
import {
  BUBBLE, FADE, INSTANT, LEAD_EDGE, MORPH, PAD, PRESS, TAB_GAP, TAB_MOVE, TRAIL_EDGE,
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

export function tabSlots(width: number, count: number, gap: number = TAB_GAP): Slot[] {
  const unit = (width - PAD * 2 - gap * (count - 1)) / count;
  return Array.from({ length: count }, (_, i) => ({ x: PAD + i * (unit + gap), w: unit }));
}

/** The last capsule tab visited: the folded capsule shows it while the assistant has the dock. */
let lastTabIndex = 0;
export function rememberTab(index: number) { if (index >= 0) lastTabIndex = index; }

/** Icon over a 12 px label on every tab at every width; the current tab is heavier. */
function TabFace({ tab, active }: { tab: Tab; active: boolean }) {
  const Icon = tab.icon;
  return <>
    <Icon size={20} strokeWidth={active ? 2 : 1.5} aria-hidden="true" className="shrink-0" />
    <span className={`max-w-full truncate text-tiny leading-4 ${active ? "font-semibold" : "font-medium"}`}>
      {tab.label}
    </span>
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
export default function TabCapsule({ activeIndex, folded, width, compact, reduce, onUnfold }: {
  activeIndex: number; folded: boolean; width: number; compact: boolean; reduce: boolean;
  onUnfold: () => void;
}) {
  const measured = width > 0;
  const slots = measured ? tabSlots(width, TABS.length, compact ? TAB_GAP / 2 : TAB_GAP) : null;
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
    const common = `flex h-[52px] min-w-11 flex-col items-center justify-center gap-0.5 rounded-full ${compact ? "px-0" : "px-1"}`;
    const position = slot
      ? { initial: false as const, animate: { x: slot.x, width: slot.w }, transition: reduce || !live ? INSTANT : TAB_MOVE }
      : {};
    const style = slot
      ? { position: "absolute" as const, left: 0, top: PAD }
      : { flexGrow: 1, flexBasis: 0 };
    if (face === "ink") return <motion.span key={measured ? `${tab.href}:placed` : tab.href} aria-hidden="true" className={common}
      style={style} {...position}>
      <TabFace tab={tab} active={active} />
    </motion.span>;
    return <motion.div key={measured ? `${tab.href}:placed` : tab.href} className="flex h-[52px] min-w-11" style={style} {...position}>
      <Link href={tab.href} aria-current={active ? "page" : undefined}
        onClick={() => { lastTabIndex = index; }}
        className={`${styles.tab} ${common} tap w-full min-w-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
        <motion.span className="flex max-w-full flex-col items-center justify-center gap-0.5" whileTap={reduce ? undefined : { scale: 0.86 }}
          transition={PRESS}>
          <TabFace tab={tab} active={active} />
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
