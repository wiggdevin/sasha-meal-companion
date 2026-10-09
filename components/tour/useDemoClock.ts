"use client";

import { useEffect, useState } from "react";

/**
 * A demo's beat counter. Each beat is a pause, in ms, before the next pose; the poses themselves move
 * on the house springs (lib/design/motion.ts), so no animation here owns a duration. The count loops
 * back to 0 after the last beat. Under reduced motion it never ticks and answers `still`: the demo
 * draws that one pose as a static frame.
 */
export function useDemoClock(beats: readonly number[], reduce: boolean, still: number, key: string = ""): number {
  const [beat, setBeat] = useState(0);
  // A new demo (or a new sub-demo) starts at its first pose.
  const [lastKey, setLastKey] = useState(key);
  if (lastKey !== key) {
    setLastKey(key);
    setBeat(0);
  }
  useEffect(() => {
    if (reduce || beats.length === 0) return;
    const timer = setTimeout(() => setBeat((b) => (b + 1) % beats.length), beats[beat] ?? 1000);
    return () => clearTimeout(timer);
  }, [beat, beats, reduce]);
  return reduce ? still : beat;
}
