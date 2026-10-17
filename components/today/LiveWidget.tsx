"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AnimatePresence, motion, useAnimationControls, useReducedMotionConfig, type PanInfo } from "motion/react";
import Button from "@/components/ui/Button";
import WidgetEditTray from "@/components/today/WidgetEditTray";
import SproutStage, { SproutBand, SproutMini, type Glance } from "@/components/today/island/Sprout";
import CareLayer from "@/components/today/care/CareLayer";
import FuelView from "@/components/today/island/FuelView";
import WellWater from "@/components/today/island/WellWater";
import IslandGoo from "@/components/today/island/IslandGoo";
import PondScene from "@/components/today/scene/PondScene";
import { MACRO_BANDS } from "@/components/today/scene/scene-geometry";
import { VIEW_NAME, VIEW_OF, panelForView, wellViews } from "@/components/today/island/views";
import { BubbleFace, CompactPanel, FullPanel, dayMood, panelSpoken, type PanelData }
  from "@/components/today/LiveWidgetPanels";
import { currentAccountOrNull } from "@/lib/device/account";
import { FADES, INSTANT, SPRINGS } from "@/lib/design/motion";
import { selectionHaptic } from "@/lib/haptics";
import { useRebalanceWidgetSync } from "@/lib/today/rebalance-widget";
import { DEFAULT_PREFS, PANEL_NAME, effectiveWidgetPrefs, loadWidgetPrefs, saveWidgetPrefs, type WidgetPanel,
  type WidgetPrefs }
  from "@/lib/today/widget-prefs";
import type { PetWhen } from "@/lib/today/pet-mood";
import { named } from "@/components/today/island/mascots";
import { useMascot, wellPet } from "@/components/today/island/well-pet";
import styles from "@/components/today/island/Island.module.css";
import well from "@/components/today/island/Well.module.css";

/** Collapsed height, the bubbles' diameter, the gap the goo bridges, the island's padding. */
const BAR = 56;
const BUBBLE = 48;
const GAP = 8;
const PAD = 12;
/** At most this many other panels wait beside the island as bubbles; one on a narrow phone. */
const maxBubbles = (width: number) => (width < 340 ? 1 : 2);
const SWIPE_PX = 48;
const SWIPE_VELOCITY = 400;
const LONG_PRESS_MS = 550;
/** Until the phone's clock is read, Sprout is simply there: no mood is guessed. */

/** The island's width and height first, then its height — the reference's "wide, then tall". */
const grow = (reduce: boolean) => reduce ? INSTANT
  : { width: SPRINGS.bouncy, height: { ...SPRINGS.bouncy, delay: 0.05 }, x: SPRINGS.bouncy, y: SPRINGS.bouncy,
    scale: SPRINGS.bouncy, borderRadius: SPRINGS.snappy };

type Shape = { x: number; y: number; w: number; h: number; r: number; scale: number; shown: boolean };

/**
 * The Day card's live widget (owner, 2026-10-05, second pass: "more alive, like it's living,
 * breathing"; the owner's reference clip broken into beats by Gemini 3.1 Pro and sorted by Jev into
 * expand, collapse, split, content swap, state tint, reactive squish and idle life; Apple's Liquid
 * Glass and Live Activity guidance). One black island at the calendar's foot:
 * - Collapsed, it carries a living orb (the day's calories as liquid) and the current panel's
 *   headline; the user's other panels wait beside it as bubbles, joined to it by a liquid neck.
 * - Tap the island: the shape grows wide, then tall, and the panel's readings rise into it after the
 *   shape has room; the bubbles melt into it. Tap a bubble: it melts into the island and the current
 *   panel pops out as a bubble. Swipe or Left/Right swaps the panel inside the same shape.
 * - The island glows with the day: sage under target, amber near it, rose over. Adding a cup squishes
 *   the island and the bubbles wobble after it.
 * - Long-press, or Edit, lifts it and opens the arrange tray. Open/closed, the panels and their order
 *   are remembered per account on this device.
 * The shapes live in one layer under an SVG goo filter (so they merge like liquid); text and controls
 * live in a layer above it, on the same springs, so they stay sharp. A glass lid lies on top.
 */
/** The design gallery's fixed state: its own clock and open/closed, never the account's stored prefs. */
export type WidgetPreview = { hour: number; expanded?: boolean; index?: number; panels?: WidgetPanel[] };

export default function LiveWidget({ data, preview, when = "today", paused = false }: {
  data: PanelData; preview?: WidgetPreview;
  /** Behind another Day card face: anything that runs a frame loop rests. */
  paused?: boolean;
  /** The viewed day against today: Sprout judges today by the hour, a past day whole, a future day not at all. */
  when?: PetWhen;
}) {
  const reduce = useReducedMotionConfig() ?? false;
  const id = useId().replace(/:/g, "");
  const [account] = useState(() => currentAccountOrNull());
  const [prefs, setPrefs] = useState<WidgetPrefs>(() => preview
    ? { ...DEFAULT_PREFS, panels: preview.panels ?? DEFAULT_PREFS.panels, expanded: preview.expanded ?? false,
      index: preview.index ?? 0 } : DEFAULT_PREFS);
  const [editing, setEditing] = useState(false);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [width, setWidth] = useState(0);
  // The first measured layout snaps into place; only later changes spring (no grow-from-nothing on load).
  const [measured, setMeasured] = useState(false);
  const [bodyHeight, setBodyHeight] = useState(0);
  const wrap = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const dragged = useRef(false);
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const squish = useAnimationControls();
  const [hour, setHour] = useState<number | null>(preview?.hour ?? null);
  const [glance, setGlance] = useState<Glance>(null);
  const [bounce, setBounce] = useState(0);
  const [cheer, setCheer] = useState(false);
  const lastKcal = useRef({ kcal: data.consumed.kcal, when });
  // True while the well changes height: the goo merges and the lid's refraction band rests (Safari
  // re-samples a backdrop filter every frame). Set by the height animation itself, never by a timer.
  const [settling, setSettling] = useState(false);
  // Shapes in flight: the goo merges them only while they move, so a resting row of drops stays crisp.
  const moving = useRef(0);
  const [morphing, setMorphing] = useState(false);
  const shapeStart = () => { moving.current += 1; setMorphing(true); };
  const shapeDone = () => { moving.current = Math.max(0, moving.current - 1); if (!moving.current) setMorphing(false); };

  const fixedHour = preview?.hour;
  useEffect(() => {
    if (fixedHour !== undefined) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPrefs(loadWidgetPrefs(account));
  }, [account, fixedHour]);
  useEffect(() => {
    // The pet's mood reads the hour; refreshed every few minutes while Today is open.
    const tick = () => {
      const now = new Date();
      setHour(fixedHour ?? now.getHours() + now.getMinutes() / 60);
    };
    tick();
    const timer = setInterval(tick, 5 * 60_000);
    return () => clearInterval(timer);
  }, [fixedHour]);
  useEffect(() => {
    // Any rise in today's record (a meal here, one synced from another device, a larger portion) is
    // cheered with neutral copy; arriving at Today from a lighter day is not a rise.
    const before = lastKcal.current;
    lastKcal.current = { kcal: data.consumed.kcal, when };
    if (when !== "today" || before.when !== "today" || data.consumed.kcal <= before.kcal) return;
    setCheer(true);
    setBounce((count) => count + 1);
    const timer = setTimeout(() => setCheer(false), 2600);
    return () => clearTimeout(timer);
  }, [data.consumed.kcal, when]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (width > 0 && !measured) setMeasured(true);
  }, [width, measured]);
  useLayoutEffect(() => {
    const measure = () => {
      setWidth(wrap.current?.clientWidth ?? 0);
      setBodyHeight(body.current?.offsetHeight ?? 0);
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    if (wrap.current) observer.observe(wrap.current);
    if (body.current) observer.observe(body.current);
    return () => observer.disconnect();
  }, []);

  // One effective preference per render (Sol R2 re-plan): the rebalance gate's live answer decides
  // whether "rebalance" is in the list, for the carousel, bubbles, pager, navigation and the Edit tray
  // alike; every write goes through the same projection with the same live answer, so a saved tab
  // never outlives a denied, timed-out or not-yet-answered gate. A design-gallery preview never
  // saves, and never lets the sync hook pull the account's stored order over its fixed state.
  const show = data.rebalance?.show === true;
  const effective = effectiveWidgetPrefs(prefs, show);
  const update = (next: WidgetPrefs) => {
    const shown = effectiveWidgetPrefs(next, show);
    setPrefs(shown);
    if (fixedHour === undefined) saveWidgetPrefs(account, shown, show);
  };
  // A design-gallery preview (PR #470 review R3, NIT) passes no account at all: it never persists,
  // and a real read here could seed this tab's per-account session cache (lib/today/widget-prefs.ts)
  // with the preview's own sample state before any real widget for that account gets to.
  useRebalanceWidgetSync(fixedHour === undefined ? account : null, fixedHour === undefined ? update : () => {},
    data.rebalance, prefs);
  const { panels, expanded, index } = effective;
  const panel = panels[index];
  /** A rings view puts Sprout in the middle of the rings instead of the band above the island. */
  const ringsView = VIEW_OF[panel] === "pond";
  const position = `${index + 1} of ${panels.length}`;
  // Open, the well shows views, not panels: the calorie and macro panels are one showcase.
  const views = wellViews(panels);
  const view = VIEW_OF[panel];
  const viewAt = views.indexOf(view);
  const waiting = panels.filter((name) => name !== panel).slice(0, maxBubbles(width));
  const bubbles = expanded ? [] : waiting;
  const mood = dayMood(data);
  // The chosen companion's mood and lines; it cheers for a moment when the day's log grows.
  const mascot = useMascot();
  const pet = wellPet(data, hour, when, cheer, mascot);

  // Geometry: one island and its bubbles, shared by the goo layer and the content layer.
  const W = Math.max(width, 0);
  const islandW = expanded ? W : Math.max(W - bubbles.length * (BUBBLE + GAP), BAR * 2);
  const islandH = expanded ? Math.max(bodyHeight, BAR) : BAR;
  const island: Shape = { x: 0, y: 0, w: islandW, h: islandH, r: expanded ? 28 : BAR / 2, scale: 1, shown: true };
  const shapeOf = (name: WidgetPanel): Shape => {
    const slot = bubbles.indexOf(name);
    if (slot < 0) {
      // Melted into the island, near its orb: the goo pulls it in as it shrinks.
      return { x: PAD, y: (BAR - BUBBLE) / 2, w: BUBBLE, h: BUBBLE, r: BUBBLE / 2, scale: 0.3, shown: false };
    }
    return { x: islandW + GAP + slot * (BUBBLE + GAP), y: (BAR - BUBBLE) / 2, w: BUBBLE, h: BUBBLE,
      r: BUBBLE / 2, scale: 1, shown: true };
  };
  const box = (shape: Shape) => ({ x: shape.x, y: shape.y, width: shape.w, height: shape.h,
    borderRadius: shape.r, scale: shape.scale });

  function go(by: 1 | -1) {
    const next = expanded ? panelForView(panels, views[viewAt + by] ?? view) : index + by;
    if (next < 0 || next >= panels.length || (expanded && !views[viewAt + by])) return;
    setDirection(by);
    update({ ...effective, index: next });
    selectionHaptic();
  }
  function choose(name: WidgetPanel) {
    const at = panels.indexOf(name);
    setDirection(at > index ? 1 : -1);
    update({ ...effective, index: at });
    selectionHaptic();
  }
  function toggle() {
    if (dragged.current) { dragged.current = false; return; }
    setSettling(true);
    update({ ...effective, expanded: !expanded });
  }
  function onDragEnd(_: unknown, info: PanInfo) {
    if (Math.abs(info.offset.x) > 6) dragged.current = true;
    if (info.offset.x < -SWIPE_PX || info.velocity.x < -SWIPE_VELOCITY) go(1);
    else if (info.offset.x > SWIPE_PX || info.velocity.x > SWIPE_VELOCITY) go(-1);
    setTimeout(() => { dragged.current = false; }, 0);
  }
  function onToggleKey(event: KeyboardEvent) {
    if (event.key === "Escape" && expanded) { event.preventDefault(); toggle(); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); go(1); }
    if (event.key === "ArrowLeft") { event.preventDefault(); go(-1); }
  }
  function startPress(event: PointerEvent) {
    const button = (event.target as HTMLElement).closest("button");
    if (editing || (button && !button.hasAttribute("data-widget-toggle"))) return;
    const timer = setTimeout(() => { press.current = null; dragged.current = true; setEditing(true); selectionHaptic(); },
      LONG_PRESS_MS);
    press.current = { timer, x: event.clientX, y: event.clientY };
  }
  function movePress(event: PointerEvent) {
    const held = press.current;
    if (held && Math.hypot(event.clientX - held.x, event.clientY - held.y) > 8) endPress();
  }
  function endPress() {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  }
  function closeTray() {
    setEditing(false);
    dragged.current = false;
    requestAnimationFrame(() => toggleRef.current?.focus({ preventScroll: true }));
  }
  useEffect(() => () => { if (press.current) clearTimeout(press.current.timer); }, []);

  // Adding a cup squishes the island; the bubbles wobble a beat after it (reactive squish).
  const onAddCup = data.onAddCup ? () => {
    data.onAddCup?.();
    setBounce((count) => count + 1);
    if (!reduce) void squish.start((i: number) => ({ scaleX: [1, 1.04, 0.98, 1], scaleY: [1, 0.94, 1.02, 1],
      transition: { duration: 0.55, delay: i * 0.07, ease: "easeOut" } }));
  } : undefined;
  const panelData = { ...data, onAddCup };
  const rise = reduce ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : { initial: { opacity: 0, x: 24 * direction, filter: "blur(6px)", scale: 0.97 },
      animate: { opacity: 1, x: 0, filter: "blur(0px)", scale: 1, transitionEnd: { filter: "none" } },
      exit: { opacity: 0, x: -24 * direction, filter: "blur(6px)", scale: 0.97 } };
  const transition = measured ? grow(reduce) : INSTANT;
  const bubbleSpoken = (name: WidgetPanel) => {
    const spoken = panelSpoken(name, data);
    return spoken.startsWith(PANEL_NAME[name]) ? spoken : `${PANEL_NAME[name]}: ${spoken}`;
  };

  return <div className={styles.outer}>
    <section className={well.well} data-expanded={expanded || undefined} data-editing={editing || undefined}
      data-mood={mood} aria-roledescription="carousel" aria-label="Day widget"
      onPointerDown={(event) => setGlance({ x: event.clientX, key: event.timeStamp })}>
      <span aria-hidden="true" className={well.caustics}>
        <span className={well.caustic} />
        <span className={well.caustic} />
        <span className={well.fizz} />
        <span className={well.fizz} />
        <span className={well.fizz} />
      </span>
      <div ref={wrap} className={`${well.inner} ${styles.wrap}`}>
      <AnimatePresence initial={false}>
        {expanded && !ringsView && <SproutBand key="sprout" className={`matte ${well.band}`}
          onLeave={() => toggleRef.current?.focus({ preventScroll: true })}>
          <SproutStage state={pet} glance={glance} bounce={bounce} when={when} mascot={mascot} />
        </SproutBand>}
      </AnimatePresence>
      <motion.div className={styles.stage} initial={false} animate={{ height: islandH }}
        onAnimationStart={() => setSettling(true)} onAnimationComplete={() => setSettling(false)}
        transition={reduce || !measured ? INSTANT : { ...SPRINGS.bouncy, delay: expanded ? 0.05 : 0 }}>
        {/* The liquid: shapes only, merged by the goo filter. */}
        <IslandGoo id={`${id}-goo`} />
        {/* Goo only mid-morph. At rest it bridged the gaps with smudged necks and cost frames. */}
        <div className={styles.goo} aria-hidden="true"
          style={{ filter: reduce || !(settling || morphing) ? undefined : `url(#${id}-goo)` }}>
          <motion.div className={styles.shape} custom={0} initial={false} animate={box(island)} transition={transition}
            onAnimationStart={shapeStart} onAnimationComplete={shapeDone} />
          {panels.map((name, at) => {
            const shape = shapeOf(name);
            return <motion.div key={name} className={styles.shape} data-panel={name} custom={at + 1} initial={false}
              animate={{ ...box(shape), opacity: shape.shown ? 1 : 0 }} transition={transition}
              onAnimationStart={shapeStart} onAnimationComplete={shapeDone} />;
          })}
        </div>

        {/* Text and controls, sharp, on the same springs. */}
        <motion.div className={`matte ${styles.island}`} custom={0} initial={false}
          animate={{ ...box(island) }} transition={transition}
          drag={editing ? false : "x"} dragConstraints={{ left: 0, right: 0 }} dragElastic={0.18} dragSnapToOrigin
          onDragEnd={onDragEnd} onPointerDown={startPress} onPointerMove={movePress} onPointerUp={endPress}
          onPointerCancel={endPress} whileTap={reduce || editing ? undefined : { scale: 0.985 }}
          onClick={(event) => {
            // Open, a tap on the glass itself (not a control) folds the well back into the pill.
            if (expanded && !editing && !(event.target as HTMLElement).closest("button, a, input")) toggle();
          }}>
          <motion.span className={styles.squish} custom={0} animate={squish}>
            <span aria-hidden="true" className={styles.glow} />
            <div ref={body} className={styles.body}>
              <button ref={toggleRef} type="button" data-widget-toggle="" className={`tap ${styles.toggle}`}
                data-open={expanded || undefined}
                aria-expanded={expanded} aria-controls={`${id}-panel`} onClick={toggle} onKeyDown={onToggleKey}>
                <span className="sr-only">{expanded ? `${named(VIEW_NAME[view], mascot)}, ${viewAt + 1} of ${views.length}. Fold the widget`
                  : `${PANEL_NAME[panel]}, ${position}. ${panelSpoken(panel, data)}`}</span>
                <AnimatePresence initial={false}>
                  {!expanded && <motion.span key="mini" className="flex shrink-0"
                    initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.4, width: 0 }}
                    animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, width: 36 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.4, width: 0 }}
                    transition={reduce ? FADES.quick : SPRINGS.bouncy}>
                    <SproutMini state={pet} mascot={mascot} />
                  </motion.span>}
                </AnimatePresence>
                <span className={styles.toggleBody} aria-hidden="true">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span key={expanded ? `name-${panel}` : panel} className={styles.toggleContent}
                      {...rise} transition={reduce ? INSTANT : SPRINGS.smooth}>
                      {expanded ? null : <CompactPanel panel={panel} data={data} />}
                    </motion.span>
                  </AnimatePresence>
                </span>
              </button>
              <div id={`${id}-panel`} hidden={!expanded} className={styles.panel}>
                <AnimatePresence mode="popLayout" initial={false}>
                  {expanded && <motion.div key={view} role="group" aria-roledescription="slide"
                    aria-label={`${named(VIEW_NAME[view], mascot)}, ${viewAt + 1} of ${views.length}`} className={styles.slide}
                    {...rise} transition={reduce ? INSTANT : { ...SPRINGS.smooth, delay: 0.08 }}>
                    <span className="sr-only">{panelSpoken(panel, data)}</span>
                    {view === "fuel" ? <FuelView data={data} />
                      : view === "water" ? <WellWater water={data.water} onAddCup={onAddCup} paused={paused} />
                      : view === "pond" ? <PondScene data={data} pet={pet} paused={paused} cheer={bounce}
                        bands={panel === "macroRings" ? MACRO_BANDS : undefined} />
                      : <FullPanel panel={panel} data={panelData} />}
                  </motion.div>}
                </AnimatePresence>
                <CareLayer active={expanded && when === "today" && !preview} />
                {/* Edit is always visible when open (OD19); long-press stays as a shortcut. */}
                {expanded && <div className={styles.editCorner}>
                  <Button variant="ghost" size="sm" className={styles.edit} onClick={() => setEditing(true)}
                    aria-expanded={editing}>Edit</Button>
                </div>}
              </div>
            </div>
            <span aria-hidden="true" className={styles.lid} />
          </motion.span>
        </motion.div>

        {panels.map((name, at) => {
          const shape = shapeOf(name);
          return <motion.button key={name} type="button" className={`matte tap ${styles.bubble}`} data-panel={name}
            aria-label={`${bubbleSpoken(name)}. Show it`} tabIndex={shape.shown ? 0 : -1}
            aria-hidden={shape.shown ? undefined : true} disabled={!shape.shown}
            initial={false} animate={{ ...box(shape), opacity: shape.shown ? 1 : 0 }}
            transition={reduce ? INSTANT : { ...transition, opacity: shape.shown ? { ...FADES.base, delay: 0.12 } : FADES.quick }}
            whileTap={reduce ? undefined : { scale: 0.9 }}
            onClick={() => {
              // PR #470 review R2, WARN: this bubble melts into the island and goes disabled and
              // aria-hidden the instant `choose` re-renders — hand focus to the surviving toggle
              // now, before that happens, rather than let it drop to the document.
              choose(name);
              toggleRef.current?.focus({ preventScroll: true });
            }}>
            <motion.span className={styles.bubbleInner} custom={at + 1} animate={squish}>
              <BubbleFace panel={name} data={data} />
              <span aria-hidden="true" className={styles.lid} />
            </motion.span>
          </motion.button>;
        })}
      </motion.div>
      </div>
      <span aria-hidden="true" className={well.lid} data-settling={settling || undefined} />
    </section>
    <AnimatePresence initial={false}>
      {editing && <WidgetEditTray key="tray" prefs={effective} onChange={update} onDone={closeTray} />}
    </AnimatePresence>
  </div>;
}

