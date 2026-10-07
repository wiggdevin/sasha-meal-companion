"use client";
/**
 * Whether a fetched recipe's rule mark is current, and the one re-read each recipe surface runs
 * when it is not (2026-10-05, recipe marks round 3).
 *
 * Trust comes from the server's own judgement: every planning response says which diet flags it
 * judged under (`ruleFlags`; a list also says `rulesFingerprint`, null when the rules could not be
 * read). The client boundary turns that into `ruleMarkRulesKey` on each recipe. A mark counts only
 * while that key equals the phone's own (`foodRulesKey` of the current settings, as Foods › Eats
 * stamps its eligible set); otherwise, or while a rule change the phone saw is being re-read, the
 * recipe shows "Check: Checking against your updated food rules", never clear.
 *
 * Each surface owns one reader (`useRecipeReader`): one generation counter, the predecessor aborted,
 * only the newest response applied. Rule signals (an Avoid put from an open recipe, a sync pass that
 * moved the rules epoch, the diet flags or the Avoid list) are coalesced over 600 ms into one re-read,
 * which waits for a read in flight and runs once after it. A stale-judged or failed re-read retries
 * after 30 s, then every 2 min; a response judged under the phone's rules stops it.
 */
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { foodRulesEpoch, SYNCED_EVENT } from "@/lib/foods/rules-epoch";
import { foodRulesKey, RECIPE_RECHECK } from "@/lib/foods/rule-marks";
import { loadStore } from "@/lib/store";
import { equalJitter, type RandomSource } from "@/lib/jitter";
import type { RuleMark, Settings } from "@/lib/types";

/** RecipeDetails' event when an ingredient is put on Avoid from an open recipe. */
export const RECIPE_AVOID_CHANGED = "recipe-avoid-changed";
export const RULE_SIGNAL_DEBOUNCE_MS = 600;
export const RECIPE_RETRY_MS = [30_000, 120_000] as const;
/** At most this many retries in a row (about 12 minutes); a rule signal or a new ask starts over. */
export const MAX_RECIPE_RETRIES = 6;
/** The key of an answer that did not say which rules it judged under: never current. */
export const UNJUDGED_RECIPE_RULES = "unjudged-recipe-rules";
export const RECIPE_RECHECK_MARK: RuleMark = { verdict: "unknown", reason: RECIPE_RECHECK };

type Store = Partial<ReturnType<typeof loadStore>> | undefined;

/** The rules key a planning response was judged under (`ruleFlags`, and a list's fingerprint). */
export function judgedRulesKey(body: unknown): string {
  if (!body || typeof body !== "object") return UNJUDGED_RECIPE_RULES;
  const { ruleFlags, rulesFingerprint } = body as { ruleFlags?: unknown; rulesFingerprint?: unknown };
  if (rulesFingerprint === null || !Array.isArray(ruleFlags)) return UNJUDGED_RECIPE_RULES;
  return foodRulesKey({ dietPrefs: { flags: ruleFlags.filter((flag): flag is string => typeof flag === "string") } });
}

/** The phone's own rules key now. */
export function phoneRulesKey(): string {
  const store: Store = loadStore();
  return foodRulesKey((store?.settings ?? {}) as Pick<Settings, "dietPrefs">);
}

/** Avoids put from an open recipe this page: their outbox write may not have reached the store yet. */
let avoidEdits = 0;
if (typeof window !== "undefined") {
  // Installed when the module loads, so it counts before any surface's own listener reads the key.
  window.addEventListener(RECIPE_AVOID_CHANGED, () => { avoidEdits += 1; });
}

/**
 * Every rule input a recipe mark depends on, as the phone sees it: the rules epoch, the diet flags,
 * the Avoid list and the Avoids put from an open recipe. A verdict read under one key is not
 * current under another.
 */
export function recipeRuleInputs(): string {
  const store: Store = loadStore();
  const avoid = Object.values(store?.foods ?? {}).filter((food) => food.status === "avoid")
    .map((food) => food.name.trim().toLowerCase()).sort();
  return JSON.stringify([foodRulesEpoch(), phoneRulesKey(), avoid, avoidEdits]);
}

function subscribeRuleInputs(onChange: () => void): () => void {
  window.addEventListener(SYNCED_EVENT, onChange);
  window.addEventListener(RECIPE_AVOID_CHANGED, onChange);
  return () => {
    window.removeEventListener(SYNCED_EVENT, onChange);
    window.removeEventListener(RECIPE_AVOID_CHANGED, onChange);
  };
}

/** The rule-input key now; re-renders when a sync pass or an Avoid could have moved it. */
export function useRecipeRuleInputs(): string {
  return useSyncExternalStore(subscribeRuleInputs, recipeRuleInputs, () => "");
}

/** A verdict stamped with the rule inputs it was read under: current only while they hold. */
export function verdictNow(mark: RuleMark | null | undefined, inputs: string | undefined,
  current: string): RuleMark | null | undefined {
  if (inputs !== undefined && current !== "" && inputs !== current) return RECIPE_RECHECK_MARK;
  return mark;
}

type Judged = { ruleMark?: RuleMark | null; ruleMarkRulesKey?: string };

/** The mark to show. A recipe no planning route judged (no key) shows its own mark. */
export function shownRecipeRuleMark(recipe: Judged, stale: boolean, phoneKey: string): RuleMark | null | undefined {
  if (recipe.ruleMarkRulesKey === undefined) return recipe.ruleMark;
  if (stale || recipe.ruleMarkRulesKey !== phoneKey) return RECIPE_RECHECK_MARK;
  return recipe.ruleMark;
}

/** Every recipe was judged under the phone's rules now (an empty list is current). */
export function recipesJudgedNow(recipes: readonly Judged[]): boolean {
  const key = phoneRulesKey();
  return recipes.every((recipe) => recipe.ruleMarkRulesKey === undefined || recipe.ruleMarkRulesKey === key);
}

/** A surface's re-read in progress after a rule change: its cards say "Checking…" meanwhile. */
export const RecipeFreshness = createContext<{ stale: boolean }>({ stale: false });

export function useShownRecipeRuleMark(recipe: Judged): RuleMark | null | undefined {
  return shownRecipeRuleMark(recipe, useContext(RecipeFreshness).stale, phoneRulesKey());
}

export type ReadOutcome<T> = { status: "applied"; value: T } | { status: "failed"; error: unknown }
  | { status: "superseded" };
type Load<T> = (signal: AbortSignal) => Promise<T>;
/** Applies the newest answer; `inputs` is the rule-input key its read started under. */
type Apply<T> = (value: T, inputs: string) => void;

/**
 * One surface's reads (see the module note). Plain state, driven by `useRecipeReader`: `read` is an
 * ask, `signal` a rule change, `stale` says whether the cards should read "Checking…".
 */
export class RecipeReader<T> {
  private gen = 0;
  private controller: AbortController | null = null;
  private inFlight = false;
  private pending = false;
  private load: Load<T> | null = null;
  private step = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inputs = recipeRuleInputs();
  private stale = false;

  /** `retryAsks`: a failed ask is retried too (a surface that has nothing else to show meanwhile).
   *  `random`: the jitter's source (lib/jitter.ts), so a test can pin a retry's time. */
  constructor(private hooks: { apply: Apply<T>; judged: (value: T) => boolean;
    setStale: (stale: boolean) => void; retryAsks?: boolean; random?: RandomSource }) {}

  /** The owner's latest callbacks (its state setters close over its render). */
  setCallbacks(apply: Apply<T>, judged: (value: T) => boolean): void {
    this.hooks = { ...this.hooks, apply, judged };
  }

  /** A sync pass: a rule change only when the rules epoch, the flags or the Avoids moved. */
  syncPass(): void {
    const inputs = recipeRuleInputs();
    if (inputs === this.inputs) return;
    this.inputs = inputs;
    this.signal();
  }

  /** An ask: aborts the read before it and becomes the source a rule change re-reads. */
  read(load: Load<T>): Promise<ReadOutcome<T>> {
    this.stopTimers();
    this.step = 0;
    this.pending = false;
    return this.start(load, "ask");
  }

  /** A rule change: "Checking…" now, one re-read after the signals stop for 600 ms. */
  signal(): void {
    if (!this.load) return;
    // The baseline a later sync pass compares against: these inputs are already being re-read.
    this.inputs = recipeRuleInputs();
    this.markStale(true);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => { this.debounceTimer = null; this.step = 0; this.reread(); },
      RULE_SIGNAL_DEBOUNCE_MS);
  }

  /** Forget the source and drop whatever is in flight (an account change, an unmount). */
  clear(): void {
    this.stopTimers();
    this.controller?.abort();
    this.gen += 1;
    this.controller = null; this.inFlight = false; this.pending = false; this.load = null; this.step = 0;
    this.markStale(false);
  }

  /** Tells the owner only when the flag actually changes: no render for a repeated clear. */
  private markStale(stale: boolean): void {
    if (this.stale === stale) return;
    this.stale = stale;
    this.hooks.setStale(stale);
  }

  private stopTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.retryTimer = null; this.debounceTimer = null;
  }

  /** Never two at once: a re-read asked for while one runs waits and runs once after it. */
  private reread(): void {
    if (!this.load) return;
    if (this.inFlight) { this.pending = true; return; }
    void this.start(this.load, "reread");
  }

  private retry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    // Bounded: after the cap the cards stay "Checking…" until a rule signal or a new ask.
    if (this.step >= MAX_RECIPE_RETRIES) { this.retryTimer = null; return; }
    // Jittered (scale S1): every phone whose re-read failed in the same outage would otherwise
    // come back on the same second; the delay lands between half the step and the step itself.
    const planned = RECIPE_RETRY_MS[Math.min(this.step, RECIPE_RETRY_MS.length - 1)];
    const delay = equalJitter(planned, this.hooks.random);
    this.step += 1;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.reread(); }, delay);
  }

  private start(load: Load<T>, kind: "ask" | "reread"): Promise<ReadOutcome<T>> {
    this.controller?.abort();
    const gen = ++this.gen;
    const controller = new AbortController();
    this.controller = controller;
    this.inFlight = true;
    this.load = load;
    // The rule inputs this read starts under: its answer clears "Checking…" only if they still hold.
    const snapshot = recipeRuleInputs();
    this.inputs = snapshot;
    const latest = () => gen === this.gen && !controller.signal.aborted;
    return load(controller.signal).then((value): ReadOutcome<T> => {
      if (!latest()) return { status: "superseded" };
      this.hooks.apply(value, snapshot);
      if (recipeRuleInputs() !== snapshot) {
        // The rules moved while it was in flight: keep "Checking…"; the signal's re-read follows.
        this.markStale(true);
        if (!this.pending && !this.debounceTimer) this.signal();
      } else if (this.hooks.judged(value)) {
        this.step = 0;
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        this.markStale(false);
      } else this.retry();
      return { status: "applied", value };
    }, (error: unknown): ReadOutcome<T> => {
      if (!latest()) return { status: "superseded" };
      // A failed ask is the surface's to report, and nothing it asked for is shown to re-read. A
      // failed re-read keeps the shown cards, still "Checking…", and tries again later.
      if (kind === "ask" && !this.hooks.retryAsks) this.load = null;
      else this.retry();
      return { status: "failed", error };
    }).finally(() => {
      if (gen !== this.gen) return;
      this.inFlight = false;
      this.controller = null;
      if (this.pending) { this.pending = false; this.reread(); }
    });
  }
}

/** What a surface calls: both stable for the life of the surface, safe in effect dependencies. */
export type RecipeReaderControls<T> = {
  read: (load: Load<T>) => Promise<ReadOutcome<T>>;
  clear: () => void;
};

/**
 * A surface's `RecipeReader`, listening for rule changes while it is mounted. `reader` never changes
 * identity, so an effect may depend on it; `stale` is the render-time flag. (A fresh object per
 * render in an effect's dependencies re-ran the effect on every render: with an account already
 * ready, `onAccountReady` fires at once and its setState rendered again, without end.)
 */
export function useRecipeReader<T>({ apply, judged, retryAsks = false }: {
  apply: Apply<T>; judged: (value: T) => boolean; retryAsks?: boolean;
}): { reader: RecipeReaderControls<T>; stale: boolean } {
  const [stale, setStale] = useState(false);
  const [instance] = useState(() => new RecipeReader<T>({ apply, judged, setStale, retryAsks }));
  const [reader] = useState<RecipeReaderControls<T>>(() => ({
    read: (load) => instance.read(load), clear: () => instance.clear() }));
  useEffect(() => { instance.setCallbacks(apply, judged); });
  useEffect(() => {
    const onSynced = () => instance.syncPass();
    const onAvoid = () => instance.signal();
    window.addEventListener(SYNCED_EVENT, onSynced);
    window.addEventListener(RECIPE_AVOID_CHANGED, onAvoid);
    return () => {
      window.removeEventListener(SYNCED_EVENT, onSynced);
      window.removeEventListener(RECIPE_AVOID_CHANGED, onAvoid);
      instance.clear();
    };
  }, [instance]);
  return { reader, stale };
}
