"use client";

/**
 * Onboarding v2: the "tap the foods you love" falling-food game (VISUAL-SPEC.md §6, with the
 * orchestrator's 2026-10-07 overrides: a spawn every 450 ms ±120 ms, a 3.6 s linear fall, ±6°
 * wobble, 96 px discs, at most 14 foods in a session).
 *
 * Live QA 2026-10-07 (defect 3) rebuilt the parts the owner saw fail on his phone:
 * - Lanes: four lanes, each new disc takes a random free lane (not one a disc used in the last
 *   two spawns, and not next to the previous disc's lane when another is free) — never
 *   `fallKey % n`, which drew a diagonal staircase.
 * - Geometry: lane centres are clamped inside the screen (`FallingFoodPile.module.css` `.lane`), so
 *   no disc sits half off the left or right edge.
 * - Stage: transparent, its top edge faded with a mask (no hard band), sized to the space left
 *   so the loved tray stays visible.
 * - A visible "Tap the foods you love" line and a per-group count.
 * - An end state: once every food has fallen, a grid of everything shown, with the taps kept and
 *   each one still toggleable. Reduced motion shows that same grid from the start.
 * - Shown foods can be held by the caller (`shownIds` / `onShown`), so a remount of this
 *   component never replays foods the person already saw.
 *
 * Owner feedback 2026-10-08 ("it starts too fast; the foods fall far too fast"):
 * - The page holds still for `PILE_TIMING.settleMs` before the first disc, so the instruction can
 *   be read. Reduced motion never animates at all (the grid from the start, as before).
 * - Discs spawn about three times further apart and fall about two and a half times slower.
 * - "Just pick from the list" opens the same end grid (`FoodGrid`) at once, with every food in
 *   the deck; a tap there writes the same `onMark` the falling discs do.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { dbFood } from "@/lib/food-db";
import type { Starter, StarterMark } from "@/lib/foods/starter";
import { starterVarietyOrder } from "@/lib/foods/starter-variety";
import type { FoodRole } from "@/lib/foods";
import { FADES, SPRINGS } from "@/lib/design/motion";
import Button from "@/components/ui/Button";
import { CHIP_FILL } from "./facts/chip-fill";
import { foodShortName } from "./food-display-names";
import { useFoodDiscArtReady } from "./food-disc-art";
import FoodDisc from "./FoodDisc";
import TileGrid from "./TileGrid";
import styles from "./FallingFoodPile.module.css";

const ROLES: readonly FoodRole[] = ["protein", "carb", "fat"];
const ROLE_NAME: Record<FoodRole, string> = { protein: "Proteins", carb: "Carbs", fat: "Fats" };
const PER_ROLE = 2;
const QUEUE_CAP = 14;
const LANES = 4;
const MAX_CONCURRENT = 4;
/** A lane is free again this many spawns after it was last used (about 150 px of fall). */
const LANE_COOLDOWN = 3;
/** The game's clock (owner 2026-10-08: the old 450 ms spawn and 3.6 s fall read as a blur). A fall
 *  is a constant-speed drop, not a spring, so it keeps its own linear duration here. */
export const PILE_TIMING = {
  /** Still time before the first disc, so the page settles and the instruction can be read. */
  settleMs: 1800,
  spawnBaseMs: 1500,
  spawnJitterMs: 250,
  fallSeconds: 9,
} as const;
const SPAWN_BASE_MS = PILE_TIMING.spawnBaseMs;
const SPAWN_JITTER_MS = PILE_TIMING.spawnJitterMs;
const FALL_SECONDS = PILE_TIMING.fallSeconds;
const WOBBLE_DEG = 6;
const WOBBLE_SECONDS = 1.8;
const DISC_PX = 112;
const FALLBACK_STAGE_PX = 360;

/** Per role, the deck's share of its 14 foods: five proteins (a five-meal plan needs five), six
 *  carbs (starches, vegetables and fruit share the role) and three fats. A role with fewer foods
 *  leaves its share to the others. */
const ROLE_SHARE: Record<FoodRole, number> = { protein: 5, carb: 6, fat: 3 };

/** Round-robin the filtered catalog across roles so the session mixes protein/carb/fat; inside a
 *  role, plate-variety order (lib/foods/starter-variety.ts), so the capped deck offers vegetables,
 *  fruit, more than one kind of starch and distinct proteins, not five starches (onb3). */
export function buildQueue(choices: readonly Starter[]): Starter[] {
  const byRole = ROLES.map((role) => starterVarietyOrder(choices.filter((item) => item.role === role)));
  const take = (shares: readonly number[]) => {
    const interleaved: Starter[] = [];
    for (let index = 0; interleaved.length < QUEUE_CAP; index += 1) {
      let added = false;
      byRole.forEach((group, role) => {
        if (index < Math.min(group.length, shares[role]) && interleaved.length < QUEUE_CAP) {
          interleaved.push(group[index]); added = true;
        }
      });
      if (!added) break;
    }
    return interleaved;
  };
  const shared = take(ROLES.map((role) => ROLE_SHARE[role]));
  if (shared.length >= Math.min(QUEUE_CAP, choices.length)) return shared;
  // A short role (a strict profile) gives its share away: refill without the shares, keeping order.
  return take(ROLES.map(() => QUEUE_CAP));
}

type FallItem = { item: Starter; fallKey: number; lane: number };
/** Pure state, updated only by pure functions (React may double-invoke an updater in dev). */
type GameState = { falling: FallItem[]; issued: number; laneUsedAt: number[]; lastLane: number };
const emptyGame = (): GameState => ({ falling: [], issued: 0, laneUsedAt: Array(LANES).fill(-LANE_COOLDOWN), lastLane: -2 });

/** The lane for the next disc: a free lane, away from the previous one when possible. `rand` is
 *  drawn outside the updater, so the updater stays pure. */
export function pickLane(game: Pick<GameState, "issued" | "laneUsedAt" | "lastLane">, rand: number): number | null {
  const free = Array.from({ length: LANES }, (_, lane) => lane)
    .filter((lane) => game.issued - game.laneUsedAt[lane] >= LANE_COOLDOWN);
  if (free.length === 0) return null;
  const apart = free.filter((lane) => Math.abs(lane - game.lastLane) > 1);
  const pool = apart.length > 0 ? apart : free;
  return pool[Math.min(pool.length - 1, Math.floor(rand * pool.length))];
}

function spawnNext(queue: readonly Starter[], rand: number) {
  return (game: GameState): GameState => {
    if (game.falling.length >= MAX_CONCURRENT || game.issued >= queue.length) return game;
    const lane = pickLane(game, rand);
    if (lane === null) return game;
    const fallKey = game.issued;
    const laneUsedAt = game.laneUsedAt.slice();
    laneUsedAt[lane] = fallKey;
    return {
      falling: [...game.falling, { item: queue[fallKey], fallKey, lane }],
      issued: game.issued + 1, laneUsedAt, lastLane: lane,
    };
  };
}

function roleCounts(choices: readonly Starter[], marks: Record<string, StarterMark>) {
  return ROLES.map((role) => ({
    role, loved: choices.filter((item) => item.role === role && marks[item.id] === "eats").length,
  }));
}

function Instruction({ choices, marks }: { choices: readonly Starter[]; marks: Record<string, StarterMark> }) {
  return <div className="flex w-full flex-col gap-1">
    <p className="m-0 font-serif text-heading-sm text-charcoal">Tap the foods you love</p>
    <p className="m-0 text-caption text-graphite" aria-live="polite">
      {roleCounts(choices, marks).map(({ role, loved }, index) => <span key={role}>
        {index > 0 && " · "}{ROLE_NAME[role]} {Math.min(loved, PER_ROLE)}/{PER_ROLE}
      </span>)}
    </p>
  </div>;
}

function FoodGrid({ items, marks, onMark }: {
  items: readonly Starter[]; marks: Record<string, StarterMark>; onMark: (id: string, mark: StarterMark) => void;
}) {
  const tiles = items.map((item) => {
    const full = dbFood(item.id)?.name ?? item.id;
    return { id: item.id, label: foodShortName(item.id, full), ariaLabel: `Love ${full}` };
  });
  const selected = new Set(items.filter((item) => marks[item.id] === "eats").map((item) => item.id));
  return <TileGrid tiles={tiles} selected={selected} testId="food-grid"
    onToggle={(id, next) => onMark(id, next ? "eats" : "neutral")} />;
}

export default function FallingFoodPile({ choices, marks, onMark, shownIds, onShown }: {
  choices: readonly Starter[];
  marks: Record<string, StarterMark>;
  onMark: (id: string, mark: StarterMark) => void;
  /** Foods already shown this session, held by the caller so a remount never replays them. */
  shownIds?: readonly string[];
  onShown?: (id: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  useFoodDiscArtReady();
  const queue = useMemo(() => buildQueue(choices), [choices]);
  const [ownShown, setOwnShown] = useState<readonly string[]>([]);
  const shown = shownIds ?? ownShown;
  const markShown = (id: string) => { if (onShown) onShown(id); else setOwnShown((current) => current.includes(id) ? current : [...current, id]); };
  const shownRef = useRef(shown);
  useLayoutEffect(() => { shownRef.current = shown; }, [shown]);

  /** First call per `fallKey` wins: Motion fires one `onAnimationComplete` for the fall and again
   *  for the pop-out exit (GPT-6 Sol r3/r4 BLOCK). */
  const resolvedKeys = useRef<Set<number>>(new Set());
  /** The latest allowed ids, read at tap time — a disc exiting during a deck swap must not mark a
   *  food the new deck excludes (GPT-6 Sol r5/r6 BLOCK; layout effect so it lands before paint). */
  const allowedIds = useRef<Set<string>>(new Set());
  useLayoutEffect(() => { allowedIds.current = new Set(choices.map((item) => item.id)); }, [choices]);

  // The foods still to fall this session: the deck less everything already shown. Snapshotted per
  // session (a new deck or a motion flip starts a new one), so a tap that marks a food shown never
  // reshuffles the remaining order mid-game.
  const sessionKey = `${choices.map((item) => item.id).join(",")}:${reduceMotion}`;
  const [session, setSession] = useState(() => ({
    key: sessionKey, remaining: queue.filter((item) => !shown.includes(item.id)), game: emptyGame(),
  }));
  if (session.key !== sessionKey) {
    setSession({ key: sessionKey, remaining: queue.filter((item) => !shown.includes(item.id)), game: emptyGame() });
  }
  const setGame = (update: (game: GameState) => GameState) =>
    setSession((current) => ({ ...current, game: update(current.game) }));
  const remaining = session.remaining;
  const game = session.game;

  const stage = useRef<HTMLDivElement | null>(null);
  const [stageHeight, setStageHeight] = useState(FALLBACK_STAGE_PX);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const report = () => { if (el.offsetHeight > 0) setStageHeight(el.offsetHeight); };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [reduceMotion]);

  /** "Just pick from the list": the end grid now, the fall stopped. */
  const [listMode, setListMode] = useState(false);

  useEffect(() => {
    if (reduceMotion || listMode) return;
    resolvedKeys.current = new Set();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function tick(): void {
      if (cancelled) return;
      setGame(spawnNext(remaining, Math.random()));
      timer = setTimeout(tick, SPAWN_BASE_MS + Math.round((Math.random() * 2 - 1) * SPAWN_JITTER_MS));
    }
    // Deferred, never synchronous (Strict Mode's setup→cleanup→setup would otherwise spawn twice),
    // and held for the settle time so the page is still while the person reads it.
    timer = setTimeout(tick, PILE_TIMING.settleMs);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // Keyed on the session's content, not on array identity (GPT-6 Sol r5 WARN).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.key, listMode]);

  // A disc counts as shown the moment it starts to fall.
  useEffect(() => {
    for (const { item } of game.falling) if (!shownRef.current.includes(item.id)) markShown(item.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.falling]);

  function resolve(fallKey: number, item: Starter, loved: boolean): void {
    if (resolvedKeys.current.has(fallKey)) return;
    resolvedKeys.current.add(fallKey);
    setGame((current) => ({ ...current, falling: current.falling.filter((disc) => disc.fallKey !== fallKey) }));
    if (!loved || !allowedIds.current.has(item.id)) return;
    onMark(item.id, "eats");
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(10);
  }

  const loved = choices.filter((item) => marks[item.id] === "eats");
  const finished = !reduceMotion && game.issued >= remaining.length && game.falling.length === 0;
  // The end grid: everything shown this session plus anything marked loved, in deck order, current
  // deck only (an excluded food never comes back).
  const gridItems = reduceMotion || listMode ? queue
    : queue.filter((item) => shown.includes(item.id) || marks[item.id] === "eats");

  if (reduceMotion || finished || listMode) {
    return <div className="flex w-full flex-col gap-3" data-testid="falling-food-pile" data-state="grid">
      <Instruction choices={choices} marks={marks} />
      {finished && <p className="m-0 text-caption text-graphite">That&rsquo;s all of them. Tap any you missed.</p>}
      <FoodGrid items={gridItems} marks={marks} onMark={onMark} />
      <FoodTray loved={loved} />
    </div>;
  }

  return <div className="flex w-full flex-col gap-3" data-testid="falling-food-pile" data-state="falling">
    <Instruction choices={choices} marks={marks} />
    <Button variant="tertiary" size="md" block className="min-h-11" onClick={() => setListMode(true)}>
      Just pick from the list
    </Button>
    {/* Full-bleed: -mx-4 cancels the 16px gutter so the lanes use the whole phone width. */}
    <div ref={stage} className={`${styles.stage} -mx-4 w-[calc(100%+32px)]`} data-testid="food-pile">
      {/* Keyed by session: a new deck (a just-confirmed allergy) drops every disc of the old deck at
          once, with no exit animation left on screen to tap. */}
      <AnimatePresence key={session.key}>
        {game.falling.map(({ item, fallKey, lane }) => {
          const full = dbFood(item.id)?.name ?? item.id;
          // A small per-disc stagger on the fall time keeps a wave from landing all at once.
          const fallSeconds = FALL_SECONDS + (((fallKey * 37) % 9) - 4) / 4;
          return <motion.div key={fallKey} className={styles.lane} data-lane={lane}
            style={{ "--lane": lane / (LANES - 1) } as CSSProperties}
            initial={{ y: -DISC_PX }} animate={{ y: stageHeight }}
            exit={{ scale: 0, opacity: 0, transition: FADES.quick }}
            transition={{ duration: fallSeconds, ease: "linear" }}
            onAnimationComplete={() => resolve(fallKey, item, false)}>
            <motion.div animate={{ rotate: [-WOBBLE_DEG, WOBBLE_DEG, -WOBBLE_DEG] }}
              transition={{ duration: WOBBLE_SECONDS, repeat: Infinity, ease: "easeInOut" }}>
              <FoodDisc id={item.id} shortName={foodShortName(item.id, full)} label={`Love ${full}`}
                pressed={false} variant="tertiary" onToggle={() => resolve(fallKey, item, true)} />
            </motion.div>
          </motion.div>;
        })}
      </AnimatePresence>
    </div>
    <FoodTray loved={loved} />
  </div>;
}

function FoodTray({ loved }: { loved: readonly Starter[] }) {
  const reduceMotion = useReducedMotion();
  return <div className={`${CHIP_FILL} flex min-h-12 w-full flex-wrap items-center gap-1.5 rounded-[16px] p-2`}
    data-testid="food-tray" aria-live="polite" aria-label={`${loved.length} loved`}>
    {loved.length === 0
      ? <span className="px-1 text-caption text-graphite">Foods you love land here.</span>
      : loved.map((item) => {
        const full = dbFood(item.id)?.name ?? item.id;
        const chip = <span className="inline-flex min-h-7 items-center rounded-full bg-[rgb(var(--ink-rgb)/0.14)] px-2.5 text-caption text-charcoal">
          {foodShortName(item.id, full)}
        </span>;
        if (reduceMotion) return <span key={item.id}>{chip}</span>;
        return <motion.span key={item.id} initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }} transition={SPRINGS.bouncy}>
          {chip}
        </motion.span>;
      })}
  </div>;
}
