"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  AnimatePresence, animate, motion, useMotionValue, useReducedMotionConfig, useTransform, type MotionValue,
} from "motion/react";
import PhosphorOrb from "@/components/PhosphorOrb";
import OrbitMark, { MARK_COLOR } from "@/components/HealthOrbitMarks";
import HealthOrbitDetail from "@/components/HealthOrbitDetail";
import { ORBIT_KEYS, orbitNodes, type OrbitBody, type OrbitKey, type OrbitNode, type OrbitWater } from "@/lib/today/health-orbit";
import {
  HEADER_SIZE, HEADER_TOP, NODE_MARK_LIFT, nodeOffset, orbitGeometry, spiralPath,
} from "@/lib/today/orbit-geometry";
import type { Macros } from "@/lib/types";
import styles from "@/components/HealthOrbit.module.css";

/**
 * Today's health constellation (Health Overview Orbit, 2026-09-30). Closed, it is one living
 * overview orb with no word or frame. Opening charges the orb and launches seven entities, which
 * then orbit slowly clockwise while each stays upright. Closing spirals them back into the orb.
 * Choosing one pauses the orbit, fades the ring and the orb, and flies that entity to the top of
 * the same fixed stage as the back control, with its detail beneath. The orb is not a number:
 * every figure lives on an entity.
 */
const EASE = [0.2, 0.8, 0.2, 1] as const;
/** One full turn of the open constellation, in seconds. */
const TURN_SECONDS = 120;
/** How long the orb gathers before it lets the entities go. */
const CHARGE = 0.18;
const LAUNCH = { type: "spring", stiffness: 260, damping: 13 } as const;
const SPIRAL_SECONDS = 0.8;
const DOCKED_SPIRAL_SECONDS = 0.45;
const NODE_MARK = 44;
const HEADER_MARK = 80;
/** Docked in the Day card the orb is still springing in at the ring's centre, so entities wait for it. */
const DOCKED_CHARGE = 0.26;
const INSTANT = { duration: 0 } as const;

/** The open card's fold: opening at once, closing after the spiral is mostly inside the orb. Only the
 *  standalone card folds; docked, the stage keeps its height and the Day card springs around it. */
export function orbitStageTransition(open: boolean, reduce: boolean) {
  return reduce ? INSTANT : { duration: 0.5, ease: EASE, delay: open ? 0 : SPIRAL_SECONDS * 0.6 };
}

type Entry = "launch" | "return";
/** How the entities leave: spiral into the orb on close, or make way for the chosen one. */
type Exit = { mode: "close" | "select"; chosen: OrbitKey | null; spiral: number };
type Selection = { key: OrbitKey; from: { x: number; y: number } };

/** The stage's width, measured, so the ring's radius fits a 320 px phone and grows on a wider one. */
function useStageWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function NodeButton({ node, index, radius, entry, upright, onSelect, nodeRef, charge }: {
  node: OrbitNode; index: number; radius: number; entry: Entry; upright: MotionValue<number>;
  onSelect: (key: OrbitKey) => void; nodeRef: (el: HTMLButtonElement | null) => void;
  /** How long the orb gathers before the entities leave it. */
  charge: number;
}) {
  const reduce = useReducedMotionConfig();
  const { x, y } = nodeOffset(index, radius);
  const variants = {
    launch: { x: 0, y: 0, opacity: 0, scale: 0.2 },
    return: { x, y, opacity: 0, scale: 0.6 },
    rest: {
      x, y, opacity: 1, scale: 1,
      transition: reduce ? INSTANT : entry === "launch"
        ? { ...LAUNCH, delay: charge + index * 0.05, opacity: { duration: 0.15, delay: charge + index * 0.05 } }
        : { duration: 0.35, ease: EASE, delay: 0.12 + index * 0.02 },
    },
    exit: ({ mode, chosen, spiral }: Exit) => {
      if (reduce || chosen === node.key) return { opacity: 0, transition: INSTANT };
      if (mode === "select") return { opacity: 0, scale: 0.6, transition: { duration: 0.25, ease: EASE } };
      const path = spiralPath(index, radius);
      const times = path.x.map((_, i) => Math.sqrt(i / (path.x.length - 1)));
      const delay = index * 0.02;
      return {
        ...path, scale: 0.15, opacity: [1, 1, 0],
        transition: {
          x: { duration: spiral, ease: "linear", times, delay },
          y: { duration: spiral, ease: "linear", times, delay },
          scale: { duration: spiral, ease: "easeIn", delay },
          opacity: { duration: spiral, times: [0, 0.7, 1], delay },
        },
      };
    },
  };
  // The figures follow their entity: they arrive once it is in flight and leave before it moves, so
  // an entity in flight never drags words across the card.
  const words = {
    launch: { opacity: 0 }, return: { opacity: 0 },
    rest: { opacity: 1, transition: reduce ? INSTANT
      : { duration: 0.25, delay: charge + index * 0.05 + 0.12 } },
    exit: { opacity: 0, transition: reduce ? INSTANT : { duration: 0.1 } },
  };
  return (
    <motion.button ref={nodeRef} type="button" aria-label={node.spoken}
      data-state={node.state} data-over={node.over || undefined}
      className={`tap ${styles.node}`} style={{ ...({ "--mark": MARK_COLOR[node.key] } as CSSProperties), rotate: upright }}
      variants={variants} initial={reduce ? "rest" : entry} animate="rest" exit="exit"
      onClick={() => onSelect(node.key)}>
      <span className={styles.nodeMark} aria-hidden="true">
        <OrbitMark kind={node.key} level={node.progress ?? 0} size={NODE_MARK} />
      </span>
      <motion.span className={styles.nodeAmount} aria-hidden="true" variants={words}>{node.amount}</motion.span>
      <motion.span className={styles.nodeLabel} aria-hidden="true" data-bound={node.bound || undefined}
        variants={words}>{node.label}</motion.span>
    </motion.button>
  );
}

type Props = {
  targets: Macros;
  consumed: Macros;
  water?: OrbitWater;
  onAddCup?: () => void;
  onSetCups?: (cups: number) => void;
  body?: OrbitBody;
  /** The day holds a partly measured recipe serving (#21): eaten figures are "at least". */
  partial?: boolean;
  /** Docked: the orb lives on the Day card (components/today/DayCard.tsx) and drives `open`; this is
   *  only the constellation's stage, drawn inside that card's Overview face with no frame of its own. */
  docked?: { id: string; open: boolean; onOpenChange: (open: boolean) => void;
    /** Told when a chosen metric's detail replaces the ring, so the docked orb can step aside. */
    onDetailChange?: (detail: boolean) => void };
};

export default function HealthOrbit({ targets, consumed, water, onAddCup, onSetCups, body, partial = false, docked }: Props) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = docked ? docked.open : ownOpen;
  const setOpen = (next: boolean) => (docked ? docked.onOpenChange(next) : setOwnOpen(next));
  const [selection, setSelection] = useState<Selection | null>(null);
  const [entry, setEntry] = useState<Entry>("launch");
  const [stageRef, width] = useStageWidth();
  const reduce = useReducedMotionConfig() ?? false;
  const spin = useMotionValue(0);
  const upright = useTransform(spin, (turn) => -turn);
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const nodeRefs = useRef(new Map<OrbitKey, HTMLButtonElement>());
  const returnTo = useRef<OrbitKey | null>(null);
  const ringId = useId();
  const detailId = useId();
  const nodes = orbitNodes({ targets, consumed, water, body, partial });
  const chosen = nodes.find((node) => node.key === selection?.key) ?? null;
  const baseGeo = orbitGeometry(width);
  // Docked, the stage keeps its open height: the Day card's face springs its own height around it.
  const geo = docked ? { ...baseGeo, closedHeight: baseGeo.height, closedCenter: baseGeo.center } : baseGeo;
  const mode = !open ? "closed" : chosen ? "detail" : "overview";
  // Docked, the card folds soon after closing, so the entities gather in roughly half the time.
  const exit: Exit = { mode: open ? "select" : "close", chosen: selection?.key ?? null,
    spiral: docked ? DOCKED_SPIRAL_SECONDS : SPIRAL_SECONDS };

  // The constellation turns only while the overview is showing, and never under reduced motion.
  const turning = mode === "overview" && !reduce;

  // A docked orb opens and closes from outside: closing drops any chosen metric so the next opening
  // starts at the overview, and each opening launches afresh from a still ring.
  const [dockedWasOpen, setDockedWasOpen] = useState(docked?.open ?? false);
  if (docked && docked.open !== dockedWasOpen) {
    setDockedWasOpen(docked.open);
    if (!docked.open) { setSelection(null); setEntry("launch"); }
  }
  const dockedOpen = docked?.open ?? false;
  const onDetailChange = docked?.onDetailChange;
  const detailShown = mode === "detail";
  useEffect(() => { onDetailChange?.(detailShown); }, [detailShown, onDetailChange]);
  useEffect(() => { if (dockedOpen) spin.set(0); }, [dockedOpen, spin]);
  useEffect(() => {
    if (!turning) return;
    const controls = animate(spin, spin.get() + 360, { duration: TURN_SECONDS, ease: "linear", repeat: Infinity });
    return () => controls.stop();
  }, [turning, spin]);

  // Focus follows the view: to the large entity on select, back to its node on return. Neither move
  // scrolls the page: both elements are inside the stage already on screen.
  useEffect(() => {
    if (selection) { backRef.current?.focus({ preventScroll: true }); return; }
    const key = returnTo.current;
    returnTo.current = null;
    if (key) nodeRefs.current.get(key)?.focus({ preventScroll: true });
  }, [selection]);

  const select = (key: OrbitKey) => {
    const point = nodeOffset(ORBIT_KEYS.indexOf(key), geo.radius, spin.get());
    setSelection({ key, from: { x: point.x, y: geo.center + point.y - NODE_MARK_LIFT - (HEADER_TOP + HEADER_SIZE / 2) } });
  };
  const back = () => {
    returnTo.current = selection?.key ?? null;
    setEntry("return");
    setSelection(null);
  };
  const onOrb = () => {
    if (open) { setOpen(false); return; }
    spin.set(0);
    setEntry("launch");
    setOpen(true);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    if (selection) back();
    else { setOpen(false); orbRef.current?.focus({ preventScroll: true }); }
  };

  const orbMotion = reduce ? { animate: { opacity: mode === "detail" ? 0 : 1, scale: 1 }, transition: INSTANT }
    : mode === "detail" ? { animate: { opacity: 0, scale: 0.5 }, transition: { duration: 0.3, ease: EASE } }
      : mode === "overview" && entry === "launch"
        ? { animate: { opacity: 1, scale: [null, 0.82, 1.08, 1] }, transition: { duration: 0.6, times: [0, 0.3, 0.6, 1], ease: EASE } }
        : mode === "overview" ? { animate: { opacity: 1, scale: 1 }, transition: { duration: 0.35, ease: EASE } }
          : { animate: { opacity: 1, scale: [null, 1, 1.12, 1] },
            transition: { duration: SPIRAL_SECONDS + 0.25, times: [0, 0.7, 0.85, 1], ease: EASE } };
  // Closing, the card waits until the spiral is mostly inside the orb before it folds.
  const stageMotion = orbitStageTransition(open, reduce);
  const from = selection?.from ?? { x: 0, y: 0 };
  // The card's light: a pool of the orb's colours under the ring, and the orbit track the entities
  // ride, drawn in from 12 o'clock as they launch.
  const overview = mode === "overview";
  const pool = Math.round(geo.radius * 2.4);
  const track = 2 * geo.radius + 4;
  const lightMotion = reduce ? INSTANT : { duration: 0.6, ease: EASE };
  const startScale = NODE_MARK / HEADER_MARK;

  return (
    <section id={docked?.id} className={docked ? undefined : "shell"} aria-label="Health overview" onKeyDown={onKeyDown}
      aria-hidden={docked && !open ? true : undefined} inert={docked ? !open : undefined}>
      <div className={docked ? styles.docked : `surface ${styles.card}`}>
        <motion.div ref={stageRef} className={styles.stage} data-orbit-stage="" data-mode={mode}
          initial={false} animate={{ height: open ? geo.height : geo.closedHeight }} transition={docked ? INSTANT : stageMotion}>
          <motion.div className={styles.hub} initial={false} animate={{ y: open ? geo.center : geo.closedCenter }}
            transition={docked ? INSTANT : stageMotion}>
            <motion.span aria-hidden="true" className={styles.pool}
              style={{ width: pool, height: pool, left: -pool / 2, top: -pool / 2 }}
              initial={false} animate={{ opacity: overview ? 1 : 0, scale: overview ? 1 : 0.7 }} transition={lightMotion} />
            {/* The Day card's orb comes in here (components/today/DayCard.tsx): one ripple as it arrives.
                Closing before it has spread fades it out rather than cutting it off. */}
            <AnimatePresence>
              {docked && open && !reduce && <motion.span key="ripple" aria-hidden="true" className={styles.ripple}
                initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 2.2, opacity: [0, 0.6, 0] }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                transition={{ duration: 1.1, delay: 0.3, ease: EASE, opacity: { duration: 1.1, delay: 0.3, times: [0, 0.18, 1] } }} />}
            </AnimatePresence>
            {!docked && <motion.div className={styles.orbWrap} initial={false} {...orbMotion}
              aria-hidden={mode === "detail" || undefined} inert={mode === "detail"}>
              <button ref={orbRef} type="button" aria-label={open ? "Close health overview" : "Open health overview"}
                aria-expanded={open} aria-controls={ringId} className={styles.orb} data-open={open} onClick={onOrb}>
                <PhosphorOrb active={open} />
              </button>
            </motion.div>}
            <motion.div id={ringId} role={mode === "overview" ? "group" : undefined}
              aria-label={mode === "overview" ? "Today's health metrics" : undefined}
              className={styles.ring} style={{ rotate: spin }}>
              <svg aria-hidden="true" className={styles.track} width={track} height={track}
                viewBox={`0 0 ${track} ${track}`} style={{ left: -track / 2, top: -track / 2 }}>
                <g transform={`rotate(-90 ${track / 2} ${track / 2})`}>
                  {/* One soft continuous track (2026-10-01 rulings: the dotted ring read as a plain stroke). */}
                  <motion.circle className={styles.trackLine} cx={track / 2} cy={track / 2} r={geo.radius}
                    initial={false} animate={{ pathLength: overview ? 1 : 0, opacity: overview ? 1 : 0 }}
                    transition={reduce ? INSTANT : { duration: 0.9, ease: EASE, delay: overview ? 0.15 : 0 }} />
                </g>
              </svg>
              <AnimatePresence custom={exit}>
                {mode === "overview" && nodes.map((node, index) => (
                  <NodeButton key={node.key} node={node} index={index} radius={geo.radius} entry={entry}
                    upright={upright} onSelect={select} charge={docked ? DOCKED_CHARGE : CHARGE}
                    nodeRef={(el) => { if (el) nodeRefs.current.set(node.key, el); else nodeRefs.current.delete(node.key); }} />
                ))}
              </AnimatePresence>
            </motion.div>
          </motion.div>
          <AnimatePresence>
            {chosen && (
              <motion.div key="detail" className={styles.detailStage}>
                <motion.button ref={backRef} type="button" className={styles.entity}
                  aria-label={`${chosen.name}: back to health overview`} aria-controls={detailId}
                  style={{ "--mark": MARK_COLOR[chosen.key] } as CSSProperties}
                  initial={reduce ? false : { ...from, scale: startScale }} animate={{ x: 0, y: 0, scale: 1, opacity: 1 }}
                  exit={reduce ? { opacity: 0, transition: INSTANT }
                    : { ...from, scale: startScale, opacity: 0, transition: { duration: 0.35, ease: EASE } }}
                  transition={reduce ? INSTANT : { type: "spring", stiffness: 220, damping: 24 }}
                  onClick={back}>
                  <OrbitMark kind={chosen.key} level={chosen.progress ?? 0} size={HEADER_MARK} />
                </motion.button>
                <motion.div className={styles.detailBody}
                  initial={reduce ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0, transition: INSTANT } : { opacity: 0, y: 12, transition: { duration: 0.2 } }}
                  transition={reduce ? INSTANT : { duration: 0.35, ease: EASE, delay: 0.12 }}>
                  <HealthOrbitDetail id={detailId} node={chosen} targets={targets} consumed={consumed} water={water}
                    onAddCup={onAddCup} onSetCups={onSetCups} body={body} partial={partial} />
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
        <p className="sr-only" aria-live="polite">{chosen ? `${chosen.name} selected` : ""}</p>
      </div>
    </section>
  );
}
