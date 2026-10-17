import { AccountChanged, accountFetch, accountJson, type AccountHandle } from "@/lib/device/account";
import type { Food } from "@/lib/foods";
import { readMealSnapshot, saveMealSnapshot, snapshotEpoch } from "@/lib/foods/meal-snapshot-store";
import { snapshotInputWrites } from "@/lib/sync/idb";
import {
  mealEvidence, parseMealSnapshot, SNAPSHOT_MAX_AGE_MS, snapshotUsable, SUGGESTIONS_NEED_CONNECTION,
  type MealEvidence,
} from "@/lib/meals/snapshot";
import { readPrefRefCache, type FoodPrefRefCache } from "@/lib/foods/prefs-client";
import { foodRulesKey, type VerifiedEligibleSet } from "@/lib/foods/rule-marks";
import { foodRulesEpoch, noteRulesRevision } from "@/lib/foods/rules-epoch";
import type { EligibleFoods, ExcludedFoodRef } from "@/lib/server/eligible-foods";
import { ruleMarkFromWire } from "@/lib/foods/rule-mark-wire";
import { readRulesState, type RulesState } from "@/lib/foods/world/rules-version-client";
import { sameRulesToken } from "@/lib/foods/world/freshness";
import { openWorldInputs, type OpenWorldInputs } from "@/lib/meals/open-world";
import { parseMealSnapshotV3, snapshotToken, snapshotV3Usable, type MealSnapshotV3 } from "@/lib/meals/snapshot-v3";
import type { RuleMark } from "@/lib/types";
import { heldShoppingFocus } from "@/lib/shopping/focus-client";
import type { FocusState } from "@/lib/shopping/focus";

type VerifiedIds = Pick<EligibleFoods, "eligibleRefIds" | "eligibleFoodIds" | "eligibleCatalogFoodIds">;

/**
 * The phone's verified set (F3): a `Set` the page stores as before, stamped with the local rule
 * inputs it was verified under and revoked by the next direct rule write. resolveDay refuses a
 * revoked or differently stamped set (`lib/foods/rule-marks.ts`).
 */
export class StampedEligibleSet extends Set<string> implements VerifiedEligibleSet {
  /**
   * `sentences`: the same exclusions as whole sentences for a surface that shows the food itself
   * (Foods › Eats), from each entry's `mark`; empty from an older server (callers fall back to the
   * name + fragment rule). `marks` keeps the fragments `lib/foods/rule-marks.ts` reads.
   */
  constructor(ids: Iterable<string>, readonly marks: ReadonlyMap<string, RuleMark>,
    readonly rulesKey: string, readonly epoch: number,
    /**
     * The account's meal snapshot evidence (Phase 17 O2); absent from a v1 server; `null` when the
     * snapshot answer went stale in flight (no new suggestion from it).
     */
    evidence?: MealEvidence | null,
    /** When the server verified these ids (ms); a set is never used past SNAPSHOT_MAX_AGE_MS. */
    readonly verifiedAt: number = Date.now(),
    /** The account this set was read for (its snapshot-input writes are watched). */
    readonly accountId?: string,
    readonly sentences: ReadonlyMap<string, RuleMark> = new Map(),
    /**
     * Phase 18 W8: an open food-world account's admitted pool, taste values and search, from a v3
     * snapshot whose token was the server's current one when this set was made. Absent for a
     * closed account (main's set exactly).
     */
    open?: OpenWorldInputs) {
    super(ids);
    this.evidence = evidence;
    this.inputsAt = accountId ? snapshotInputWrites(accountId) : 0;
    this.openInputs = open;
  }
  private readonly evidence: MealEvidence | null | undefined;
  private readonly inputsAt: number;
  private readonly openInputs: OpenWorldInputs | undefined;
  /**
   * W137: an open set held across a date change waits for the server's token before it seeds
   * anything again (`markProvisional`, `recheckHeldOpenSet`); `withdrawn` is final: the server
   * said the account is no longer open or the token moved. A closed set is never either.
   */
  private provisional = false;
  private withdrawn = false;
  /** Moves on every `markProvisional`, so an older recheck never lifts a newer hold. */
  private holdGeneration = 0;
  /**
   * The open-world inputs while this set may still seed a suggestion: never once revoked (a local
   * rule write, or 7 days). A local Avoid mark written since is applied by the reader
   * (lib/meals/open-world.ts `livePool`), so it takes effect before the next read.
   */
  get open(): OpenWorldInputs | undefined {
    return this.revoked ? undefined : this.openInputs;
  }
  /** The open-world inputs this set was made with, revoked or not (the recheck's token). */
  get heldOpen(): OpenWorldInputs | undefined { return this.openInputs; }
  /**
   * W137: hold an open set until its token is rechecked; answers the hold's generation. No effect
   * on a closed set. While held the set is revoked (fail closed): it seeds no meal, and saved lines
   * read "not checked" until the recheck or the next read answers.
   */
  markProvisional(): number {
    if (this.openInputs && !this.withdrawn) {
      this.provisional = true;
      this.holdGeneration += 1;
    }
    return this.holdGeneration;
  }
  /**
   * W137: a recheck's verdict for the hold `generation` it started under. `withdrawn` revokes the
   * set for good whenever it lands; `fresh` lifts the hold only if no later date change held it again.
   */
  settleProvisional(verdict: "fresh" | "withdrawn", generation: number): void {
    if (!this.openInputs) return;
    if (verdict === "withdrawn") {
      this.withdrawn = true;
      this.provisional = false;
    } else if (generation === this.holdGeneration) {
      this.provisional = false;
    }
  }
  get isProvisional(): boolean { return this.provisional; }
  get isWithdrawn(): boolean { return this.withdrawn; }
  /**
   * Phase 18 W11 (D7): this account's shopping focus as the phone holds it now
   * (lib/shopping/focus-client.ts), read on every use so a toggle re-ranks at once. A ranking
   * input only: it never admits a food the set does not already vouch for.
   */
  get shoppingFocus(): FocusState | null {
    return this.revoked || !this.accountId ? null : heldShoppingFocus(this.accountId);
  }
  /**
   * The snapshot evidence, while nothing it was computed from changed locally. After a local log,
   * Eats or settings write the history is no longer offered (curated ranking only, `undefined`)
   * until the next read; `null` (a stale-in-flight answer) stays `null`.
   */
  get meals(): MealEvidence | null | undefined {
    if (this.evidence && this.accountId && snapshotInputWrites(this.accountId) !== this.inputsAt) return undefined;
    return this.evidence;
  }
  /**
   * Lazy: any rules change after the request started revokes it, however long it is held, and so
   * does age: a set (online or from the offline snapshot) is never used more than 7 days after the
   * server verified it (D2), checked on every use rather than only when IndexedDB is read.
   */
  get revoked(): boolean {
    return this.provisional || this.withdrawn
      || this.epoch !== foodRulesEpoch() || Date.now() - this.verifiedAt > SNAPSHOT_MAX_AGE_MS;
  }
  /**
   * A revoked set clears nothing, even for a caller that only asks `.has` (round 5 WARN 5, e.g.
   * the swap sheet). Iteration still lists the ids; resolveDay refuses a revoked set first.
   */
  override has(id: string): boolean { return !this.revoked && super.has(id); }
}

function mappedRefs(food: Food, refs: FoodPrefRefCache): string[] {
  const mapped = refs[food.id];
  return [mapped?.userRefId, mapped?.catalogRefId].filter((ref): ref is string => typeof ref === "string");
}

/**
 * Why each Eats food the server did not clear is out: a blocked ref wins over an unknown one. Keeps
 * the server's `reason` FRAGMENT, because `lib/foods/rule-marks.ts` prefixes the saved line's own
 * name; `name`/`mark` (the full sentence) are not needed here and an older server omits them.
 */
export function eligibleLocalMarks(foods: Record<string, Food>, refs: FoodPrefRefCache,
  excluded: readonly Pick<ExcludedFoodRef, "refId" | "verdict" | "reason">[] | undefined,
  ids: ReadonlySet<string>): Map<string, RuleMark> {
  const byRef = new Map((excluded ?? []).map((entry) => [entry.refId, entry]));
  const marks = new Map<string, RuleMark>();
  for (const food of Object.values(foods)) {
    if (food.status !== "eats" || ids.has(food.id)) continue;
    const found = mappedRefs(food, refs).map((ref) => byRef.get(ref))
      .filter((entry) => entry !== undefined);
    const mark = found.find((entry) => entry.verdict === "blocked") ?? found[0];
    if (mark) marks.set(food.id, { verdict: mark.verdict, reason: mark.reason });
  }
  return marks;
}

/**
 * The same choice as `eligibleLocalMarks` (blocked ref first), as the entry's whole-sentence `mark`.
 * An entry whose `mark` is absent or malformed contributes nothing; its fragment still stands.
 */
export function eligibleLocalSentences(foods: Record<string, Food>, refs: FoodPrefRefCache,
  excluded: readonly (Pick<ExcludedFoodRef, "refId" | "verdict"> & { mark?: unknown })[] | undefined,
  ids: ReadonlySet<string>): Map<string, RuleMark> {
  const byRef = new Map((excluded ?? []).map((entry) => [entry.refId, entry]));
  const sentences = new Map<string, RuleMark>();
  for (const food of Object.values(foods)) {
    if (food.status !== "eats" || ids.has(food.id)) continue;
    const found = mappedRefs(food, refs).map((ref) => byRef.get(ref))
      .filter((entry) => entry !== undefined);
    const chosen = found.find((entry) => entry.verdict === "blocked") ?? found[0];
    const mark = chosen ? ruleMarkFromWire(chosen.mark) : null;
    if (mark && mark.verdict === chosen?.verdict) sentences.set(food.id, mark);
  }
  return sentences;
}

/** Project server-verified refs onto this account's local foods; unknown IDs stay out. */
export function eligibleLocalFoodIds(
  foods: Record<string, Food>, refs: FoodPrefRefCache, verified: VerifiedIds,
): Set<string> {
  const allowedRefs = new Set(verified.eligibleRefIds);
  const allowedFoods = new Set(verified.eligibleFoodIds);
  const ids = new Set<string>();
  for (const food of Object.values(foods)) {
    if (food.status !== "eats") continue;
    const mapped = refs[food.id];
    const foodRefs = [mapped?.userRefId, mapped?.catalogRefId]
      .filter((ref): ref is string => typeof ref === "string");
    if (foodRefs.length > 0) {
      if (foodRefs.every((ref) => allowedRefs.has(ref))) ids.add(food.id);
      continue;
    }
    // A catalog-linked row may have two policy identities. Without its ref cache, we cannot
    // prove both were cleared, even if one side's food ID or catalog ID appears in the result.
    if (food.catalogFoodId === undefined && allowedFoods.has(food.id)) ids.add(food.id);
  }
  return ids;
}

function validEligible(body: unknown): body is EligibleFoods {
  const row = body as Partial<EligibleFoods> | null;
  return !!row && Array.isArray(row.eligibleRefIds) && Array.isArray(row.eligibleFoodIds)
    && Array.isArray(row.eligibleCatalogFoodIds);
}

function stamped(foods: Record<string, Food>, refs: FoodPrefRefCache, body: EligibleFoods, startedAt: number,
  meals?: MealEvidence | null, verifiedAt?: number, accountId?: string): StampedEligibleSet {
  const ids = eligibleLocalFoodIds(foods, refs, body);
  // Stamp with the flags the server judged under. An answer that does not say which flags it used
  // is never current (rounds 4 and 5): its clears and its exclusion reasons are both unproven.
  const judgedKey = Array.isArray(body.preferenceFlags)
    ? foodRulesKey({ dietPrefs: { flags: body.preferenceFlags } }) : "unjudged-diet-flags";
  return new StampedEligibleSet(ids, eligibleLocalMarks(foods, refs, body.excluded, ids),
    judgedKey, startedAt, meals, verifiedAt, accountId, eligibleLocalSentences(foods, refs, body.excluded, ids));
}

/** The read failed only because there is no usable snapshot: the UI shows the slot copy for it. */
export function needsConnection(error: unknown): boolean {
  return error instanceof Error && error.message === SUGGESTIONS_NEED_CONNECTION;
}

/**
 * No connection: this account's stored snapshot, when it is no older than 7 days and nothing it
 * was computed from has changed since (lib/foods/meal-snapshot-store.ts), stands in for the read.
 * Otherwise no new suggestion can be made (D2, acceptance 8). An open food-world snapshot (v3)
 * never stands in: offline, the phone cannot prove that another device did not add a rule, so it
 * makes no new suggestion (D4 step 3, owner question 6).
 */
async function offlineEligible(account: AccountHandle, foods: Record<string, Food>,
  startedAt: number): Promise<StampedEligibleSet> {
  const stored = await readMealSnapshot(account);
  if (!stored || stored.snapshot.schemaVersion !== 2) throw new Error(SUGGESTIONS_NEED_CONNECTION);
  const refs = readPrefRefCache(account.userId);
  return stamped(foods, refs, stored.eligible, startedAt, mealEvidence(stored.snapshot, foods, refs),
    Date.parse(stored.snapshot.computedAt), account.userId);
}

/**
 * An open account's set (W8): the local foods the v3 snapshot admits plus the admitted universe
 * pool ids, stamped like any set, carrying the open-world inputs. Only a snapshot whose token is
 * the server's current one reaches here.
 */
function openStamped(foods: Record<string, Food>, refs: FoodPrefRefCache, snapshot: MealSnapshotV3,
  startedAt: number, accountId: string): StampedEligibleSet {
  const open = openWorldInputs(snapshot, foods, refs);
  const ids = Object.keys(open.foods);
  const body = snapshot.eligible;
  const judgedKey = Array.isArray(body.preferenceFlags)
    ? foodRulesKey({ dietPrefs: { flags: body.preferenceFlags } }) : "unjudged-diet-flags";
  const local = new Set(ids.filter((id) => foods[id] !== undefined));
  return new StampedEligibleSet(ids, eligibleLocalMarks(foods, refs, body.excluded, local), judgedKey, startedAt,
    open.evidence, Date.parse(snapshot.computedAt), accountId, eligibleLocalSentences(foods, refs, body.excluded, local),
    open);
}

/**
 * The open-world freshness check before a new suggestion run (D11): the server's current token,
 * read now. A held v3 snapshot whose token it is serves the run without a refetch.
 */
async function heldOpenSet(account: AccountHandle, foods: Record<string, Food>,
  startedAt: number): Promise<{ set: StampedEligibleSet | null; held: boolean; state?: RulesState }> {
  const stored = await readMealSnapshot(account);
  if (!stored || stored.snapshot.schemaVersion !== 3) return { set: null, held: false };
  // Same offline floor as a fresh answer (Sol r1 BLOCK): a held v3 body under an old ranking,
  // preference or bundled-universe contract, or older than 7 days, never seeds a run just because
  // its token still matches.
  if (!snapshotV3Usable(stored.snapshot, account.userId)) return { set: null, held: false };
  const current = await readRulesState(account);
  if (current === null) throw new Error(SUGGESTIONS_NEED_CONNECTION);
  // Sol r2 BLOCK: only while the server still says this account is open (released, listed, not
  // held). Taken off the release list or put on hold: one refetch, which answers the closed body.
  if (current.world !== "open" || !sameRulesToken(current.token, snapshotToken(stored.snapshot))) {
    return { set: null, held: true, state: current };
  }
  return { set: openStamped(foods, readPrefRefCache(account.userId), stored.snapshot, startedAt, account.userId),
    held: true };
}

/**
 * W137: the check a held open set needs after a date change, before it seeds a meal again. The set
 * is provisional (nothing new is generated from it) from the call until the answer; a caller can
 * mark it earlier (`markProvisional`). Today never waits on it. The set is fresh only while the server still says the
 * account is open and its token is the one the set was admitted under; otherwise it is withdrawn.
 * Unreachable server: it stays provisional (no new suggestion), and the next read replaces it.
 * A closed set (no open inputs) asks nothing and is `closed`.
 */
export async function recheckHeldOpenSet(account: AccountHandle, set: StampedEligibleSet):
  Promise<"closed" | "fresh" | "withdrawn" | "provisional"> {
  const open = set.heldOpen;
  if (!open || set.accountId !== account.userId) return "closed";
  if (set.isWithdrawn) return "withdrawn";
  const generation = set.markProvisional();
  const current = await readRulesState(account);
  if (current === null) return "provisional";
  if (current.world !== "open" || !sameRulesToken(current.token, open.token)) {
    set.settleProvisional("withdrawn", generation);
    return "withdrawn";
  }
  set.settleProvisional("fresh", generation);
  return set.isProvisional ? "provisional" : "fresh";
}

/**
 * One verified read. The epoch is taken BEFORE the request, so a rule that changes while it is in
 * flight leaves the answer stale rather than trusted; the diet-flag key is the server's own.
 *
 * It asks for the v2 snapshot (Phase 17 O2): the eligible set plus the account's meal evidence,
 * which is kept for offline use. A v1 answer (an older server) is read as before, with curated
 * evidence only. With no connection, a stored snapshot of this account no older than 7 days is
 * used; without one the read fails with "Suggestions need a connection".
 */
export async function loadEligibleLocalFoodIds(
  account: AccountHandle, foods: Record<string, Food>,
): Promise<StampedEligibleSet> {
  const cached = closedCaches.get(account.userId);
  if (cached) {
    if (await closedCacheHolds(account, foods, cached)) return cached.set;
    if (closedCaches.get(account.userId) === cached) closedCaches.delete(account.userId);
  }
  // A snapshot answer that a local change (a log, an Eats edit) overtook in flight is read once
  // more; if that one is overtaken too, its ids stand but its evidence is not used (`null`).
  const first = await readEligibleOnce(account, foods);
  if (first.state !== "stale") return first.set;
  const second = await readEligibleOnce(account, foods);
  if (second.state !== "stale") return second.set;
  const set = second.set;
  return new StampedEligibleSet(set, set.marks, set.rulesKey, set.epoch, null, set.verifiedAt, set.accountId,
    set.sentences);
}

async function readEligibleOnce(account: AccountHandle, foods: Record<string, Food>):
  Promise<{ set: StampedEligibleSet; state: "stored" | "stale" | "skipped" }> {
  const startedAt = foodRulesEpoch();
  const inputsAtStart = snapshotInputWrites(account.userId);
  const generation = await snapshotEpoch(account);
  const keyAtStart = closedCacheKey(account, foods, startedAt, inputsAtStart);
  // An open account's held snapshot serves this run only under the server's current token (W8).
  const held = await heldOpenSet(account, foods, startedAt);
  if (held.set) return { set: held.set, state: "skipped" };
  // W047 (d): the token BEFORE the body, so a body cached under it is at least as new as it.
  const tokenBefore = held.held ? held.state ?? null : await readRulesState(account);
  let response: Response;
  try {
    // `?v=3`: an open account's snapshot; a closed account gets main's v2 body byte for byte.
    response = await accountFetch(account, "/api/foods/eligible?v=3", { cache: "no-store" });
  } catch (error) {
    if (error instanceof AccountChanged) throw error;
    if (held.held) throw new Error(SUGGESTIONS_NEED_CONNECTION);
    return { set: await offlineEligible(account, foods, startedAt), state: "skipped" };
  }
  if (response.status === 409) {
    const body = await accountJson<{ error?: string }>(account, response);
    if (body?.error === "rule_review_required") {
      throw new Error("Review your existing food rules in Settings before swapping meals.");
    }
  }
  if (!response.ok) throw new Error("Couldn’t check your food rules. Try again.");
  const raw = await accountJson<unknown>(account, response);
  const open = parseMealSnapshotV3(raw);
  if (open) return readOpenAnswer(account, foods, open, startedAt, inputsAtStart, generation);
  if ((raw as { schemaVersion?: unknown } | null)?.schemaVersion === 3) {
    // A v3 body that does not parse: nothing in it is trusted, and nothing is generated from it.
    throw new Error("Couldn’t check your food rules. Try again.");
  }
  const snapshot = parseMealSnapshot(raw);
  const body = snapshot ? (raw as { eligible?: unknown }).eligible : raw;
  if (!validEligible(body) || (snapshot && snapshot.accountId !== account.userId)) {
    throw new Error("Couldn’t check your food rules. Try again.");
  }
  // A revision other than the last one seen moves the epoch, so this answer is born stale and the
  // re-read it triggers is stamped under the new one.
  if (typeof body.rulesRevision === "number") noteRulesRevision(body.rulesRevision, account.userId);
  const refs = readPrefRefCache(account.userId);
  // The same compatibility check as a stored snapshot (account, ranking contract, not from the
  // future, not older than 7 days): an incompatible answer's ids stand, its history is not used.
  if (!snapshot || !snapshotUsable(snapshot, account.userId)) {
    return { set: stamped(foods, refs, body, startedAt), state: "skipped" };
  }
  // A snapshot input written in this page (or announced by another tab) while the request was in
  // flight makes the answer stale even before the persisted watermark catches up.
  const state = snapshotInputWrites(account.userId) !== inputsAtStart ? "stale" as const
    : await saveMealSnapshot(account, snapshot, body, generation).catch(() => "skipped" as const);
  const set = stamped(foods, refs, body, startedAt, mealEvidence(snapshot, foods, refs),
    Date.parse(snapshot.computedAt), account.userId);
  if (state === "stored") rememberClosedSet(account, set, tokenBefore, keyAtStart);
  return { set, state };
}

/**
 * W047 (d): a closed account's verified set, reused while nothing it was computed from can have
 * changed. Design and safety argument: PR "W047 (d)". The key is everything the phone holds that
 * the answer depends on (rules epoch, eaten-history watermark, local date, the Eats foods and
 * their refs); the server side is the rules token (`rulesVersion` covers every account table
 * admission reads, `evidenceVersion` every shared one), checked by a fresh `rules-version` read
 * before each reuse, plus the next instant a calendar or expiring hard rule changes on its own
 * (`ruleBoundaryAt`). In memory only, at most CLOSED_CACHE_MAX_MS old (a server deploy).
 */
export const CLOSED_CACHE_MAX_MS = 10 * 60_000;

type ClosedCache = {
  set: StampedEligibleSet; token: RulesState["token"]; key: string; cachedAt: number;
  /** The rule boundary (ms) the server reported when the set was cached; null for none. */
  boundary: number | null;
};

const closedCaches = new Map<string, ClosedCache>();

/** Forget every cached closed set (tests; an account's own entry is replaced on its next read). */
export function resetEligibleCache(): void {
  closedCaches.clear();
}

function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function closedCacheKey(account: AccountHandle, foods: Record<string, Food>, epoch: number,
  watermark: number): string {
  const refs = readPrefRefCache(account.userId);
  const rows = Object.keys(foods).sort().map((id) => {
    const food = foods[id];
    return [id, food.name, food.status, food.catalogFoodId ?? null, refs[id]?.userRefId ?? null,
      refs[id]?.catalogRefId ?? null];
  });
  return JSON.stringify({ account: account.userId, epoch, watermark, date: localDate(new Date()), rows });
}

function rememberClosedSet(account: AccountHandle, set: StampedEligibleSet, token: RulesState | null,
  key: string): void {
  // Only a closed answer read under a closed token that said where its rules change next.
  if (!token || token.world !== "closed" || token.ruleBoundaryAt === undefined || set.open) {
    closedCaches.delete(account.userId);
    return;
  }
  const now = Date.now();
  if (token.ruleBoundaryAt !== null && now >= token.ruleBoundaryAt) {
    closedCaches.delete(account.userId);
    return;
  }
  closedCaches.set(account.userId, { set, token: token.token, key, cachedAt: now, boundary: token.ruleBoundaryAt });
}

async function closedCacheHolds(account: AccountHandle, foods: Record<string, Food>,
  cached: ClosedCache): Promise<boolean> {
  const local = () => {
    const now = Date.now();
    return now - cached.cachedAt <= CLOSED_CACHE_MAX_MS && (cached.boundary === null || now < cached.boundary)
      && !cached.set.revoked && cached.set.open === undefined
      && closedCacheKey(account, foods, foodRulesEpoch(), snapshotInputWrites(account.userId)) === cached.key;
  };
  if (!local()) return false;
  const current = await readRulesState(account);
  // The server's clock decides: once its next boundary differs from the cached one (a window
  // opened or closed there, whatever this phone's clock says), the set is not reused.
  if (!current || current.world !== "closed" || !sameRulesToken(current.token, cached.token)
    || current.ruleBoundaryAt === undefined || current.ruleBoundaryAt !== cached.boundary) return false;
  // Nothing local moved while the token was read.
  return local();
}

/**
 * An open account's answer (W8). It is used only when the server's current token, read right
 * after it, is the one it was admitted under; otherwise no new suggestion is made from it (the
 * caller reads once more). Offline right after the answer: no new suggestion either.
 */
async function readOpenAnswer(account: AccountHandle, foods: Record<string, Food>, snapshot: MealSnapshotV3,
  startedAt: number, inputsAtStart: number, generation: number):
  Promise<{ set: StampedEligibleSet; state: "stored" | "stale" | "skipped" }> {
  if (snapshot.accountId !== account.userId || !snapshotV3Usable(snapshot, account.userId)) {
    throw new Error("Couldn’t check your food rules. Try again.");
  }
  if (typeof snapshot.eligible.rulesRevision === "number") noteRulesRevision(snapshot.eligible.rulesRevision, account.userId);
  const current = await readRulesState(account);
  if (current === null) throw new Error(SUGGESTIONS_NEED_CONNECTION);
  const refs = readPrefRefCache(account.userId);
  const set = openStamped(foods, refs, snapshot, startedAt, account.userId);
  // The world closed (release list, hold) after this answer was built: never used either.
  if (current.world !== "open" || !sameRulesToken(current.token, snapshotToken(snapshot))) {
    // Admitted under an older token: never used. An empty set clears nothing and generates nothing.
    return { set: new StampedEligibleSet([], new Map(), set.rulesKey, set.epoch, null, set.verifiedAt,
      account.userId), state: "stale" };
  }
  const state = snapshotInputWrites(account.userId) !== inputsAtStart ? "stale" as const
    : await saveMealSnapshot(account, snapshot, snapshot.eligible as EligibleFoods, generation)
      .catch(() => "skipped" as const);
  return { set, state };
}
