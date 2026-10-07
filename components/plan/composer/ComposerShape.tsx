"use client";
/**
 * The ask box's body as one SVG piece (tab-shape.ts): the paper pill and, while "+" is open, the
 * tab rising out of its top edge. Every layer of `.plan-ask` (the AI rim, the paper fill and its
 * inner shade, the focus glow) is drawn from the same outline, so the tab is the pill's own material
 * and the rim runs round it too, rather than a second object laid on it. The tab wears a breath of
 * sage: the same outline filled again, shaded the same way and clipped to the tab's region
 * (tabRegionPath), so it reads as a tinted section of one shape, not a separate cap.
 *
 * Motion: the outline's `d` is recomputed from two motion values every frame, so the path morphs
 * from flat to raised. The height rides the dock bubble's spring (MORPH, a little overshoot, so
 * it gives like the bubble does); the width trails it on the lens's slow edge on the way up and
 * leads on the quick edge on the way down, so the tab rises as a narrow drop and spreads, then
 * draws in and sinks. Reduced motion: no morph; the raised outline fades in over the flat one.
 */
import { useEffect, useId } from "react";
import { animate, motion, useMotionValue, useTransform, type MotionValue } from "motion/react";
import { LEAD_EDGE, MORPH, TRAIL_EDGE } from "@/components/dock/dock-motion";
import { RISE, tabPath, tabRegionPath, type TabGeometry } from "@/components/plan/composer/tab-shape";
import styles from "@/components/plan/PlanComposer.module.css";

/** The fade that stands in for the morph under reduced motion. */
const REDUCED_FADE = { duration: 0.2, ease: "easeOut" } as const;

type Ids = { fill: string; tabFill: string; rim: string; shade: string; shadeFocus: string };

function Layers({ d, region, clip, ids }: {
  d: string | MotionValue<string>; region: string | MotionValue<string>; clip: string; ids: Ids;
}) {
  return <>
    <clipPath id={clip}><motion.path d={region} /></clipPath>
    <motion.path d={d} className={styles.glow} />
    <motion.path d={d} className={styles.rim} stroke={`url(#${ids.rim})`} data-shape-rim="" />
    <motion.path d={d} fill={`url(#${ids.fill})`} filter={`url(#${ids.shade})`} data-shape-fill="" />
    {/* The filter runs before the clip, so the tab keeps the pill's inner shade along its top. */}
    <motion.path d={d} fill={`url(#${ids.tabFill})`} filter={`url(#${ids.shade})`} clipPath={`url(#${clip})`}
      data-shape-tab="" />
    <motion.path d={d} className={styles.focusFill} filter={`url(#${ids.shadeFocus})`} />
    <motion.path d={d} className={styles.tabFocusFill} filter={`url(#${ids.shadeFocus})`}
      clipPath={`url(#${clip})`} />
  </>;
}

export default function ComposerShape({ width, height, plateau, open, reduce }: {
  width: number; height: number; plateau: number; open: boolean; reduce: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const ids = {
    fill: `${uid}-fill`, tabFill: `${uid}-tab-fill`, rim: `${uid}-rim`, shade: `${uid}-shade`,
    shadeFocus: `${uid}-shade-focus`,
  };

  const w = useMotionValue(width);
  const h = useMotionValue(height);
  const rise = useMotionValue(open ? RISE : 0);
  const spread = useMotionValue(open ? 1 : 0);
  const top = useMotionValue(plateau);
  const now = (): TabGeometry => ({
    width: w.get(), height: h.get(), rise: rise.get(), spread: spread.get(), plateau: top.get(),
  });
  const d = useTransform(() => tabPath(now()));
  const region = useTransform(() => tabRegionPath(now()));

  useEffect(() => { w.set(width); h.set(height); top.set(plateau); }, [width, height, plateau, w, h, top]);
  useEffect(() => {
    if (reduce) { rise.jump(open ? RISE : 0); spread.jump(open ? 1 : 0); return; }
    const runs = [
      animate(rise, open ? RISE : 0, MORPH),
      animate(spread, open ? 1 : 0, open ? TRAIL_EDGE : LEAD_EDGE),
    ];
    return () => runs.forEach((run) => run.stop());
  }, [open, reduce, rise, spread]);

  const down: TabGeometry = { width, height, rise: 0, spread: 0, plateau };
  const up: TabGeometry = { width, height, rise: RISE, spread: 1, plateau };

  return <svg aria-hidden="true" focusable="false" className={styles.shape} width={width} height={height}
    viewBox={`0 0 ${width} ${height}`} data-tab-motion={reduce ? "fade" : "morph"}>
    <defs>
      {/* Level with the pill (0 to its height), so the tab above it takes the pill's top colour. */}
      <linearGradient id={ids.fill} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={height}>
        <stop offset="0" className={styles.stopTop} />
        <stop offset="1" className={styles.stopBottom} />
      </linearGradient>
      {/* The tab's tint, across its own height: sage-tinted ivory on top, easing toward the pill's
          top colour at the pill's edge so the join stays soft. */}
      <linearGradient id={ids.tabFill} gradientUnits="userSpaceOnUse" x1="0" y1={-RISE} x2="0" y2="0">
        <stop offset="0" className={styles.tabStopTop} />
        <stop offset="1" className={styles.tabStopBottom} />
      </linearGradient>
      {/* The AI rim runs across the box: olive at "+", sage, then wheat at Send. */}
      <linearGradient id={ids.rim} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={width} y2="0">
        <stop offset="0" className={styles.rimOlive} />
        <stop offset="0.55" className={styles.rimSage} />
        <stop offset="1" className={styles.rimWheat} />
      </linearGradient>
      {[{ id: ids.shade, blur: 1, dy: 1, flood: styles.shade },
        { id: ids.shadeFocus, blur: 1, dy: 1, flood: styles.shadeFocus }].map((shade) =>
        <filter key={shade.id} id={shade.id} x="-10%" y="-60%" width="120%" height="220%"
          colorInterpolationFilters="sRGB">
          {/* An inset shadow: the shape's outside, blurred and dropped, kept only inside the shape. */}
          <feComponentTransfer in="SourceAlpha" result="outside">
            <feFuncA type="table" tableValues="1 0" />
          </feComponentTransfer>
          <feGaussianBlur in="outside" stdDeviation={shade.blur} result="soft" />
          <feOffset in="soft" dy={shade.dy} result="dropped" />
          <feFlood className={shade.flood} result="ink" />
          <feComposite in="ink" in2="dropped" operator="in" result="shadow" />
          <feComposite in="shadow" in2="SourceAlpha" operator="in" result="inner" />
          <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="inner" /></feMerge>
        </filter>)}
    </defs>
    {reduce ? <>
      <g data-shape="flat">
        <Layers d={tabPath(down)} region={tabRegionPath(down)} clip={`${uid}-tab-flat`} ids={ids} />
      </g>
      <motion.g data-shape="raised" initial={false} animate={{ opacity: open ? 1 : 0 }} transition={REDUCED_FADE}>
        <Layers d={tabPath(up)} region={tabRegionPath(up)} clip={`${uid}-tab-raised`} ids={ids} />
      </motion.g>
    </> : <g data-shape="morph"><Layers d={d} region={region} clip={`${uid}-tab-morph`} ids={ids} /></g>}
  </svg>;
}
