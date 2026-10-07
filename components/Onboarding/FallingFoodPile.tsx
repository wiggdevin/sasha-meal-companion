"use client";

/**
 * Onboarding v2 lane 4: the "tap the ones you love" falling-food game.
 * VISUAL-SPEC.md §6 (2026-10-07, the design lead's spec), overridden on four numbers by the
 * orchestrator's 2026-10-07 live-screenshot review (first pass read as "sparse and quiet," not
 * "foods raining in") — noted in coord.md, not silently diverged from the spec:
 *
 *   - one food spawns every 450ms ±120ms (spec: 650±150), max 5 falling at once (spec: 3) — the
 *     next spawn still waits for a free slot
 *   - a disc falls the container's full height in 3.6s (spec: 3.2s) at constant (linear) velocity
 *   - disc size 96px (spec: 72px), so 14 discs pass in roughly the owner's ~12s target
 *   - ±6° wobble, 1.8s sine period, as a transform layered on top of the fall (unchanged)
 *   - a tap pops the disc (scale/opacity out) and marks it loved; reaching the floor untapped
 *     fades it out neutrally — no penalty framing, matches the Sprout card plan's "no deficit
 *     shaming"
 *   - the session shows at most 14 discs total, then spawning stops
 *   - reduced motion replaces the whole game with a static 4-column grid of the same renders,
 *     tap-to-select, no animation beyond the tap's own feedback
 *
 * The stage is full-bleed (edge to edge, no card inset) per the same review — still the
 * `.matte`/`--grad-matte` charcoal scope VISUAL-SPEC.md asks for, just not boxed.
 *
 * Deferred, explicitly, under the ship-tomorrow deadline (not in VISUAL-SPEC.md's §9 scope for
 * this PR either): the per-tap particle burst, Sprout's catch reaction (L2 owns Sprout —
 * LANES.md), and the backdrop drift of loved foods (§3, a whole-onboarding-canvas treatment L2/L3
 * own, not this step). The tap/miss mechanics, timing and the reduced-motion fallback are real.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { dbFood } from "@/lib/food-db";
import type { Starter, StarterMark } from "@/lib/foods/starter";
import type { FoodRole } from "@/lib/foods";
import { SPRINGS } from "@/lib/design/motion";
import { foodShortName } from "./food-display-names";
import { useFoodDiscArtReady } from "./food-disc-art";
import FoodDisc from "./FoodDisc";

const ROLES: readonly FoodRole[] = ["protein", "carb", "fat"];
const QUEUE_CAP = 14;
const MAX_CONCURRENT = 5;
const SPAWN_BASE_MS = 450;
const SPAWN_JITTER_MS = 120;
const FALL_SECONDS = 3.6;
const WOBBLE_DEG = 6;
const WOBBLE_SECONDS = 1.8;
const STAGE_HEIGHT_PX = 620;
const DISC_PX = 96;
/** Lane count matches `MAX_CONCURRENT`, spread across the full stage width with a minimum gap. */
const LANES = MAX_CONCURRENT;

/** Round-robin the filtered catalog across roles so the session mixes protein/carb/fat, capped to
 *  `QUEUE_CAP` — "cap at 14 discs total shown" (VISUAL-SPEC.md §6). */
function buildQueue(choices: readonly Starter[]): Starter[] {
  const byRole = ROLES.map((role) => choices.filter((item) => item.role === role));
  const interleaved: Starter[] = [];
  let index = 0;
  while (interleaved.length < choices.length && interleaved.length < QUEUE_CAP) {
    let added = false;
    for (const group of byRole) {
      if (index < group.length && interleaved.length < QUEUE_CAP) { interleaved.push(group[index]); added = true; }
    }
    if (!added) break;
    index += 1;
  }
  return interleaved;
}

type FallItem = { item: Starter; fallKey: number; lane: number };
/** `issued` is both "how many of `queue` have been spawned so far" and the source of each new
 *  disc's unique `fallKey` — one piece of state, updated only by pure functions (see `spawnNext`
 *  below), so there is nothing for React dev-mode's double-invoked `setState` updater check to
 *  corrupt. An earlier version tracked this in refs mutated *inside* the updater; the double
 *  invoke silently burned two queue slots per real spawn and, separately, a dev-mode remount left
 *  two independent copies of that ref-based scheduler running at once. Neither failure mode is
 *  possible once every updater is pure and the effect's own cleanup (`clearTimeout`) is the only
 *  thing that stops the previous instance — the standard, React-doc-recommended effect shape. */
type GameState = { falling: FallItem[]; issued: number };
const EMPTY_GAME: GameState = { falling: [], issued: 0 };

function spawnNext(queue: readonly Starter[]) {
  return (game: GameState): GameState => {
    if (game.falling.length >= MAX_CONCURRENT || game.issued >= queue.length) return game;
    const item = queue[game.issued];
    const fallKey = game.issued;
    return {
      falling: [...game.falling, { item, fallKey, lane: fallKey % LANES }],
      issued: game.issued + 1,
    };
  };
}

export default function FallingFoodPile({ choices, marks, onMark }: {
  choices: readonly Starter[];
  marks: Record<string, StarterMark>;
  onMark: (id: string, mark: StarterMark) => void;
}) {
  const reduceMotion = useReducedMotion();
  useFoodDiscArtReady();
  const queue = useMemo(() => buildQueue(choices), [choices]);
  const [game, setGame] = useState<GameState>(EMPTY_GAME);
  /** Each `motion.div` below carries both `animate` (the fall) and `exit` (the pop/fade), and
   *  Motion fires the *same* `onAnimationComplete` for either one finishing — so a tap's own exit
   *  transition re-invokes the handler a moment after the tap already resolved the disc (GPT-6 Sol
   *  r3/r4 BLOCK). Guard here, in the plain event-handler body (never inside a setState updater —
   *  see `GameState`'s own doc on why that specific spot has to stay pure): the first call for a
   *  given `fallKey` wins, every later one for that key is the exit echo and does nothing. */
  const resolvedKeys = useRef<Set<number>>(new Set());
  /** The id set `resolve` checks a tap against, always kept current (GPT-6 Sol r5 BLOCK): an
   *  `AnimatePresence` exit gives a just-removed disc ~220ms on screen with its `onToggle` still
   *  wired to the render that created it. If a deck swap (a confirmed allergy excludes that very
   *  food) lands during that window, the tap must not still mark the now-excluded food loved —
   *  checking the *latest* allowed ids at call time, not the ids `resolve`'s own closure captured,
   *  is what actually closes that gap. A plain `useEffect` still leaves a real, if narrow, window
   *  open: it runs after paint, so a tap landing between commit and that effect would still read
   *  the stale set (GPT-6 Sol r6 BLOCK). `useLayoutEffect` runs synchronously after the DOM
   *  mutates and before the browser paints — before the user could possibly see or tap the new
   *  frame — which is the standard fix for exactly this class of "effect ran too late" race. */
  const allowedIds = useRef<Set<string>>(new Set());
  useLayoutEffect(() => { allowedIds.current = new Set(choices.map((item) => item.id)); }, [choices]);
  // A new deck (or a reduced-motion flip) clears the session during render, not in an effect
  // (React's documented pattern for state that must track a prop). Keyed on the deck's actual
  // identity (the joined ids), not just its length (GPT-6 Sol r4 BLOCK) — a same-length filtered
  // replacement (e.g. a newly confirmed allergy swaps one food for another) must still clear
  // `falling`/`issued`, or an excluded food already mid-fall stays tappable and the new deck's
  // early items never get a turn.
  const sessionKey = `${choices.map((item) => item.id).join(",")}:${reduceMotion}`;
  const [trackedSessionKey, setTrackedSessionKey] = useState(sessionKey);
  if (trackedSessionKey !== sessionKey) {
    setTrackedSessionKey(sessionKey);
    setGame(EMPTY_GAME);
  }

  useEffect(() => {
    if (reduceMotion) return;
    resolvedKeys.current = new Set();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    function tick(): void {
      if (cancelled) return;
      setGame(spawnNext(queue));
      const jitter = SPAWN_BASE_MS + Math.round((Math.random() * 2 - 1) * SPAWN_JITTER_MS);
      timer = setTimeout(tick, jitter);
    }
    // Scheduled, not called synchronously: Strict Mode's dev-only setup→cleanup→setup runs this
    // effect body twice before either timer fires, so a synchronous first `tick()` call here
    // would spawn two discs at mount instead of one (GPT-6 Sol r4 WARN, confirmed with a
    // read-only React probe). Deferring the first tick the same way every later one already is
    // means the first effect instance's timer is cleared by its own cleanup before it ever
    // fires, so only the surviving instance's tick ever actually spawns anything.
    timer = setTimeout(tick, 0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // Keyed on `sessionKey` (content), not `queue` (a fresh array reference every render even
    // when the ids are unchanged, e.g. a parent re-render that rebuilds `choices`) — otherwise
    // this effect reruns and wipes `resolvedKeys` without `game` itself resetting, reopening the
    // exact double-resolve window the guard above exists to close (GPT-6 Sol r5 WARN). `queue`
    // and `reduceMotion` are read from closure on purpose; `sessionKey` already changes whenever
    // either of them would.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  function resolve(fallKey: number, item: Starter, loved: boolean): void {
    if (resolvedKeys.current.has(fallKey)) return;
    resolvedKeys.current.add(fallKey);
    setGame((current) => ({ ...current, falling: current.falling.filter((disc) => disc.fallKey !== fallKey) }));
    if (!loved || !allowedIds.current.has(item.id)) return;
    onMark(item.id, "eats");
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(10);
  }

  const falling = game.falling;
  const loved = choices.filter((item) => marks[item.id] === "eats");

  if (reduceMotion) {
    return <div className="flex flex-col gap-4" data-testid="falling-food-pile">
      <div className="grid grid-cols-4 gap-2" data-testid="food-pile">
        {queue.map((item) => {
          const full = dbFood(item.id)?.name ?? item.id;
          const pressed = marks[item.id] === "eats";
          return <FoodDisc key={item.id} id={item.id} shortName={foodShortName(item.id, full)}
            label={`Love ${full}`} pressed={pressed} variant={pressed ? "primary" : "tertiary"}
            onToggle={() => onMark(item.id, pressed ? "neutral" : "eats")} />;
        })}
      </div>
      <FoodTray loved={loved} />
    </div>;
  }

  return <div className="-mx-4 flex flex-col gap-4" data-testid="falling-food-pile">
    {/* Full-bleed: the -mx-4 above cancels DESIGN.md's 16px gutter, so a plain w-full here reaches
        the screen edges without a fixed-position/viewport-unit hack (orchestrator 2026-10-07: "the
        whole viewport behind the header and the dock, not a rounded card inside the page"). */}
    <div className="matte matte-grain relative w-full overflow-hidden"
      style={{ background: "var(--grad-matte)", height: STAGE_HEIGHT_PX }} data-testid="food-pile">
      <AnimatePresence>
        {falling.map(({ item, fallKey, lane }) => {
          const full = dbFood(item.id)?.name ?? item.id;
          // Lanes spread across the full stage width with a minimum gap (LANES slots, one per
          // concurrent disc) rather than a fixed small set of positions.
          const laneWidth = 100 / LANES;
          const left = laneWidth * lane + laneWidth / 2;
          // The first wave (nothing has resolved yet) spawns in a tight ~2s burst to fill the 5
          // concurrent slots, which — with one shared fall duration — left every stage show a
          // synchronized "all land within the same few hundred ms" moment, then a visibly empty
          // stage for a beat before the next wave refilled (reproduced live). A small per-disc
          // stagger on the fall duration breaks that up without changing the spec's target speed
          // on average.
          const fallSeconds = FALL_SECONDS + (((fallKey * 37) % 9) - 4) / 10;
          return <motion.div key={fallKey} className="absolute top-0 -translate-x-1/2"
            style={{ left: `${left}%` }}
            initial={{ y: -DISC_PX }} animate={{ y: STAGE_HEIGHT_PX }}
            exit={{ scale: 0, opacity: 0, transition: { duration: 0.22 } }}
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
  return <div className="well flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-[16px] p-2"
    data-testid="food-tray" aria-live="polite">
    {loved.length === 0
      ? <span className="text-tiny text-muted">Loved foods land here.</span>
      : loved.map((item) => {
        const full = dbFood(item.id)?.name ?? item.id;
        const chip = <span className="rounded-full bg-primary/10 px-2 py-0.5 text-tiny text-primary">
          {foodShortName(item.id, full)}
        </span>;
        if (reduceMotion) return <span key={item.id}>{chip}</span>;
        return <motion.span key={item.id} initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }} transition={SPRINGS.bouncy}>
          {chip}
        </motion.span>;
      })}
  </div>;
}
