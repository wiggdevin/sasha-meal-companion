"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sceneArt, type MascotKey } from "@/components/today/island/mascots";
import { MOMENTS, momentLength, nextMomentIn, pickMoment, type MomentKey, type MomentPose } from "@/components/today/scene/moments";

/** Where a skipped pebble lands, and the swim's path across the lake, in the scene's 350 × 420 box. */
export const PEBBLE = { from: { x: 208, y: 176 }, to: { x: 236, y: 292 } } as const;
export const SWIM_PATH = [{ x: 132, y: 262 }, { x: 292, y: 290 }, { x: 150, y: 318 }] as const;
/** The least wait, ms, before a moment that fell due during a pause plays. */
const RESUME_MS = 1500;

/** Loads a moment's poses ahead of time (the scene mounts only the pose on show). */
function preload(key: MomentKey, mascot: MascotKey) {
  if (typeof Image === "undefined") return;
  const sources = key === "swim" ? [sceneArt(mascot, "swim")] : MOMENTS[key].frames.map((f) => sceneArt(mascot, f.pose));
  for (const src of sources) { const img = new Image(); img.src = src; }
}

/**
 * Plays Sprout's moments (moments.ts) on their own: one every 40–70 s of time `enabled` (fishing, the
 * day fine, the pond shown, nothing else happening), never the same twice in a row. A pebble lands with a
 * splash; a swim sends small ripples along its path. Stops at once when disabled.
 */
export function usePondMoments({ mascot = "sprout", enabled, splash }: { mascot?: MascotKey; enabled: boolean; splash: (x: number, y: number, strength: number) => void }) {
  const [playing, setPlaying] = useState<{ key: MomentKey; frame: number; run: number } | null>(null);
  const runs = useRef(0);
  const enabledRef = useRef(enabled);
  const mascotRef = useRef(mascot);
  useEffect(() => { mascotRef.current = mascot; }, [mascot]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  const last = useRef<MomentKey | null>(null);
  const splashRef = useRef(splash);
  useEffect(() => { splashRef.current = splash; }, [splash]);

  // Disabled: whatever is playing ends now.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!enabled) setPlaying(null);
  }, [enabled]);

  // The next moment, a while after the last one ended. The wait is a deadline, not a timer: a cast or
  // a catch (every 28-44 s) turns moments off for a second or two, and that pause holds the wait
  // rather than restarting it, so moments still come every 40-70 s. Coming back from a pause, the
  // moment waits at least RESUME_MS so it never starts the instant a cast ends.
  const due = useRef<number | null>(null);
  const upNext = useRef<MomentKey | null>(null);
  useEffect(() => {
    if (!enabled || playing) return;
    if (due.current === null || upNext.current === null) {
      due.current = Date.now() + nextMomentIn();
      // Choose now and load its poses while waiting, so the moment never flashes in.
      upNext.current = pickMoment(last.current);
      preload(upNext.current, mascotRef.current);
    }
    const timer = setTimeout(() => {
      const chosen = upNext.current;
      const key = chosen && chosen !== last.current ? chosen : pickMoment(last.current);
      due.current = null;
      upNext.current = null;
      last.current = key;
      runs.current += 1;
      setPlaying({ key, frame: 0, run: runs.current });
    }, Math.max(RESUME_MS, due.current - Date.now()));
    return () => clearTimeout(timer);
  }, [enabled, playing]);

  // Step through the moment's poses, its splashes, and its end.
  const key = playing?.key ?? null;
  const run = playing?.run ?? 0;
  useEffect(() => {
    if (!key) return;
    const moment = MOMENTS[key];
    const timers: ReturnType<typeof setTimeout>[] = [];
    let at = 0;
    moment.frames.forEach((frame, i) => {
      if (i > 0) timers.push(setTimeout(() => setPlaying((p) => (p ? { ...p, frame: i } : p)), at));
      at += frame.ms;
    });
    if (key === "pebble") timers.push(setTimeout(() => splashRef.current(PEBBLE.to.x, PEBBLE.to.y, 70), 480 + 520));
    if (key === "swim") {
      for (let t = 300; t < (moment.swimMs ?? 0); t += 650) {
        const u = t / (moment.swimMs ?? 1);
        const a = SWIM_PATH[u < 0.5 ? 0 : 1];
        const b = SWIM_PATH[u < 0.5 ? 1 : 2];
        const k = u < 0.5 ? u * 2 : (u - 0.5) * 2;
        timers.push(setTimeout(() => splashRef.current(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k + 14, 22), t));
      }
    }
    timers.push(setTimeout(() => setPlaying(null), momentLength(moment)));
    return () => { for (const id of timers) clearTimeout(id); };
  }, [key, run]);

  /**
   * Starts a moment now (a double tap, the gallery), only while moments are allowed; a repeat restarts
   * it. True when it started. The wait for the next automatic moment starts again after it.
   */
  const play = useCallback((next: MomentKey): boolean => {
    if (!enabledRef.current) return false;
    due.current = null;
    upNext.current = null;
    preload(next, mascotRef.current);
    last.current = next;
    runs.current += 1;
    setPlaying({ key: next, frame: 0, run: runs.current });
    return true;
  }, []);

  const moment = playing ? MOMENTS[playing.key] : null;
  const pose: MomentPose | null = moment && playing ? moment.frames[playing.frame]?.pose ?? null : null;
  return {
    key,
    pose,
    frame: playing?.frame ?? 0,
    swimming: key === "swim",
    line: moment?.line ?? null,
    play,
  };
}
