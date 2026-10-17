/**
 * The I/O the coach's tools reach — one port per executor, built once per turn (T6 §6).
 *
 * Split out of lib/server/coach-turn.ts so the loop file is the loop. Every port is
 * `(userId, ...)`: no tool schema carries a user, account or url field, and nothing here reads
 * one from the model (spec invariant 2).
 */

import { isFoodKey } from "@/lib/meals/food-key";
import { readAllergenChecks, readAllergenEvidence } from "@/lib/server/allergen-evidence";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getProfile, getRuleReviewStatus, type StoredProfile } from "@/lib/server/constraints";
import { readPolicyProfile } from "@/lib/server/policy-profile";
import { latestEstimate } from "@/lib/server/expenditure";
import { activeTargets } from "@/lib/server/targets";
import { accountDay, addIsoDays } from "@/lib/server/account-day";
import { isMealSlot } from "@/lib/meals";
import { mapCatalogFoodHit } from "@/lib/server/coach";
import { eatsOwnFood } from "@/lib/server/eats-own-food";
import type { ExecutorPorts } from "@/lib/coach/executors";
import type { FoodHit } from "@/lib/coach/executors";
import { clampMealTarget } from "@/lib/coach/compose";
import type { SuggestInput } from "@/lib/coach/suggest";
import { runLookup } from "@/lib/server/lookup-lane";
import type { DayContext } from "@/lib/server/day-context";
import { viewedDay } from "@/lib/server/viewed-day";
import { recipeSearchFromWish } from "@/lib/coach/recipe-query";
import type { SkipPreview } from "@/lib/plan/skip-preview";
import type { SlotId, Store } from "@/lib/types";

type UserFoodSearchRow = {
  id: string;
  name: string;
  brand: string | null;
  per_100g: Record<string, number | null> | null;
  ingredients_text?: string | null;
  rev: number;
  allergen_tags: string[] | null;
  kind: string;
};

async function coachExpenditureStatus(admin: SupabaseClient, userId: string): Promise<unknown> {
  const status = await latestEstimate(admin, userId);
  if (process.env.COACH_ACTIVITY_CONTEXT_ENABLED === "true") return status;
  // exp-3.0.0: `profileTdeeKcal` is the starting estimate every surface shows, so it stays even
  // with the activity fields off; only the activity context and the learning counter are gated.
  const { activityContext, learningDaysRemaining, ...legacy } = status;
  void activityContext; void learningDaysRemaining;
  return legacy;
}

/**
 * A ref-minting RPC that stops when the turn stops waiting. The RPC is an idempotent get-or-create
 * of an identity row (`on conflict do nothing`), exactly what every search already does for hits
 * the user never picks; aborting only saves late round trips, it does not guarantee no commit.
 */
function cancellable<T>(call: PromiseLike<T> & { abortSignal?: (s: AbortSignal) => PromiseLike<T> },
  signal: AbortSignal | undefined): PromiseLike<T> {
  return signal && typeof call.abortSignal === "function" ? call.abortSignal(signal) : call;
}

/** Exact, account-scoped fallback for custom foods the catalog RPC cannot return. */
export async function searchExactUserFood(
  admin: SupabaseClient,
  userId: string,
  query: string,
  signal?: AbortSignal,
): Promise<FoodHit | null> {
  const exactName = query.trim().replaceAll("\\", "\\\\").replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  const food = await admin.from("user_foods")
    .select("id,name,brand,per_100g,allergen_tags,ingredients_text,rev,kind")
    .eq("user_id", userId)
    .in("kind", ["custom", "label_scan"])
    .is("deleted_at", null)
    .ilike("name", exactName)
    .limit(1)
    .maybeSingle();
  if (food.error || !food.data) return null;
  const row = food.data as UserFoodSearchRow;
  signal?.throwIfAborted();
  // sol FIX (review round 1, finding #2): foodKey needs only row.id/row.rev, already known here —
  // start these two reads now, alongside the ref→pref chain below, instead of tacking them on
  // after both complete. That used to add a full extra serial round trip to every coach-turn call
  // to this exact-food-search fallback. A `.catch` with no handler keeps an early ref/pref return
  // below from leaving an unhandled rejection if `readAllergenEvidence` fails while in flight; the
  // real result (or error) is still read from `factsRead` once we get there.
  const foodKey = `user_food:${row.id}:${row.rev}`;
  const factsRead = Promise.all([
    readAllergenEvidence(admin, [foodKey]), readAllergenChecks(admin, userId, [foodKey]),
  ]);
  factsRead.catch(() => {});
  const refCall = admin.rpc("get_or_create_food_ref", {
    p_user_id: userId, p_kind: "user", p_catalog_food_id: null, p_user_food_id: row.id,
  });
  const ref = await cancellable(refCall, signal);
  if (ref.error || typeof ref.data !== "string") return null;
  const pref = await admin.from("user_food_prefs").select("status")
    .eq("user_id", userId).eq("food_ref_id", ref.data).maybeSingle();
  if (pref.error) return null;
  const [evidence, checks] = await factsRead;
  const values = row.per_100g ?? {};
  const amount = (key: string) => typeof values[key] === "number" ? values[key] : null;
  const status = pref.data?.status === "eats" || pref.data?.status === "avoid"
    ? pref.data.status : null;
  return {
    foodRefId: ref.data,
    name: row.name,
    brand: row.brand,
    catalogFoodRevisionId: null,
    // The account's own food keys by its own id (lib/meals/food-key.ts).
    ...(isFoodKey(`food:${row.id}`) ? { foodKey: `food:${row.id}` } : {}),
    kcalPer100g: amount("energy_kcal") ?? amount("energy_kcal_calc"),
    proteinPer100g: amount("protein"),
    carbsPer100g: amount("carbohydrate"),
    fatPer100g: amount("fat_total"),
    prefStatus: status,
    allergenTags: row.allergen_tags,
    allergenEvidence: evidence.get(foodKey) ?? {},
    checkedAllergens: checks.get(foodKey) ?? [],
    ingredientsText: row.ingredients_text ?? null,
    // sol BLOCK (r5): a client-created "custom" food's own editable text is never a printed
    // label (§9 R2) — only a "label_scan" row genuinely came off one — so the policy's live
    // derivation may not treat it as complete enough to CLEAR a major allergen by its own shape.
    ingredientsTextIsLabel: row.kind === "label_scan",
    // 2026-10-02 DeepSeek audit, round 4 (#1): packaged by the same test as the commit lane
    // (lib/server/log-evidence.ts), so a scanned "Chicken breast" never clears as a whole food.
    packaged: row.kind === "label_scan",
    category: null,
    portionGrams: null,
    portionLabel: null,
  };
}

/**
 * What a composed meal has to add up to — ONE meal's worth (T6 §4, ruling 2026-09-18).
 *
 * A named slot uses that slot's macros. Otherwise use what is left, divided by the
 * slots still pending today. A wish is for a meal, and sizing a wrap to a whole day's remainder
 * made it 1 425 kcal wide and could never fit — the wrap it produced was 860 kcal and honest, and
 * only the bar was wrong.
 */
export async function composeTarget(
  admin: SupabaseClient, userId: string, slot: string | undefined,
  clock: { tz: string; date: string },
): Promise<{ kcal: number; protein: number; carbs: number; fat: number }> {
  const { buildDayContext } = await import("@/lib/server/day-context");
  // The TURN's date, not the process clock: `Date.now()` here put a turn sent at 23:40 Denver on
  // the server's tomorrow (Grok pass 1, MEDIUM 12).
  const day = await buildDayContext(admin, userId, clock.date, clock.tz, slot);
  if (!day.remaining) throw new Error("Profile setup is required before sizing a meal.");
  const named = slot ? day.slots.find((row) => row.slot === slot) : undefined;
  // An empty slot carries zero totals (design §2.1), and zero is not a meal's
  // worth. Fall through to the remaining share so a new account can still be
  // sized against its revision.
  if (named && named.state !== "empty") return named.totals;
  if (named?.state === "empty" && day.planningTarget) return day.planningTarget;
  return remainingMealShare(day);
}

/** Reserve one share for an empty meal, including a slot the user cleared and is planning again. */
function remainingMealShare(day: DayContext): NonNullable<DayContext["remaining"]> {
  if (!day.remaining) throw new Error("Profile setup is required before sizing a meal.");
  // Rituals do not consume meal shares. An empty meal does, even while the visible generated
  // meals temporarily expand around it, so Plan is sized for the slot the user opened.
  const pending = Math.max(1, day.slots
    .filter((row) => (row.state === "pending" || row.state === "empty") && isMealSlot(row.slot)).length);
  const share = (value: number) => Math.round(value / pending);
  return {
    kcal: share(day.remaining.kcal), protein: share(day.remaining.protein),
    carbs: share(day.remaining.carbs), fat: share(day.remaining.fat),
  };
}

export async function suggestionTarget(
  admin: SupabaseClient, userId: string, input: SuggestInput,
  clock: { tz: string; date: string },
  /** The viewed day already read for this slot, so the build's slotClock reuses one query. */
  loaded?: Promise<DayContext>,
): Promise<{ kcal: number; protein: number; carbs: number; fat: number } | null> {
  const { buildDayContext } = await import("@/lib/server/day-context");
  const day = await (loaded ?? buildDayContext(admin, userId, clock.date, clock.tz, input.slot));
  // No revision yet, or none effective on the turn's OWN day (a day before the account's first
  // revision, or a revision dated later than the day asked about). That is a fact about the day,
  // not a failure: the suggestion path says so (lib/coach/suggest.ts) instead of throwing into
  // the fast path's catch, where it used to read "I couldn't build those suggestions right now. Please try again." Every
  // other property still throws, so a real failure is still reported as one.
  if (!day.remaining) return null;
  if (input.kind === "snack") return day.remaining;
  const planned = input.slot ? day.slots.find((row) => row.slot === input.slot) : undefined;
  if (planned?.state === "empty") return day.planningTarget
    ? (input.fitRemaining ? clampMealTarget(day.planningTarget, day.remaining) : day.planningTarget)
    : remainingMealShare(day);
  // A Plan-sheet ask about a meal that is already planned replaces it: size it to the share the
  // sheet shows (planningSlotTarget), not to the meal it would replace.
  if (planned?.state === "pending" && input.fitRemaining && day.planningTarget) {
    return clampMealTarget(day.planningTarget, day.remaining);
  }
  const named = planned;
  if (named) {
    return input.fitRemaining
      ? clampMealTarget(named.totals, day.remaining) : named.totals;
  }
  if (input.fitRemaining) {
    const next = day.slots.find((row) => row.state === "pending" && isMealSlot(row.slot));
    return clampMealTarget(next?.totals ?? day.remaining, day.remaining);
  }
  return composeTarget(admin, userId, undefined, clock);
}

/** The viewed date's store with its logged entries, as buildDayContext resolves it. */
async function storeWithLogs(admin: SupabaseClient, userId: string, date: string): Promise<Store> {
  const { loggedEntries, serverStoreFor } = await import("@/lib/server/day-context");
  const [store, logged] = await Promise.all([
    serverStoreFor(admin, userId, date), loggedEntries(admin, userId, date),
  ]);
  return { ...store, days: { ...store.days, [date]: { ...(store.days[date] ?? { date }),
    extras: logged.map(({ entry }) => entry) } } };
}

/** What skipping one meal on the named date would do; the preview_skip tool. Writes nothing. */
export async function skipPreview(
  admin: SupabaseClient, userId: string, date: string, slot: string,
): Promise<SkipPreview> {
  const { previewSkip } = await import("@/lib/plan/skip-preview");
  return previewSkip(await storeWithLogs(admin, userId, date), date, slot as SlotId);
}

/** Pending meal slots, in order, for the composed card's slot button. */
async function pendingMealSlots(
  admin: SupabaseClient, userId: string, clock: { tz: string; date: string },
): Promise<{ slot: string; label: string }[]> {
  const { buildDayContext } = await import("@/lib/server/day-context");
  const day = await buildDayContext(admin, userId, clock.date, clock.tz);
  return day.slots.filter((row) => row.state === "pending" && isMealSlot(row.slot))
    .map((row) => ({ slot: row.slot, label: row.label }));
}

export function defaultPorts(
  client: SupabaseClient, admin: SupabaseClient, newId: () => string,
  clock: { tz: string; date: string; now?: string },
  /**
   * `signal` aborts once the turn has stopped waiting (review r2): a lookup still in flight then
   * does not go on to mint food refs for an answer nobody will read.
   */
  opts: { signal?: AbortSignal; profile?: StoredProfile } = {},
): ExecutorPorts {
  const tz = clock.tz;
  /** The turn's own policy profile (constraint row + confirmed profile rules), already read once
   *  (lib/server/coach-turn/setup.ts); read here only when a caller built the ports without it. */
  const policyProfile = async (userId: string): Promise<StoredProfile> => opts.profile
    ?? (await readPolicyProfile(client, userId, clock.now ? new Date(clock.now) : new Date())).profile;
  const ports: ExecutorPorts = {
    // #21: totals carry the same caveats as the day context (lower bound; check could not run).
    dayTotals: async (userId, date) => {
      const { dayTotalsWithCaveats } = await import("@/lib/server/day-totals");
      return (await dayTotalsWithCaveats(admin, userId, [date]))[0];
    },
    weekTotals: async (userId, weekStart) => {
      const { dayTotalsWithCaveats } = await import("@/lib/server/day-totals");
      const start = Date.parse(`${weekStart}T00:00:00.000Z`);
      return dayTotalsWithCaveats(admin, userId, Array.from({ length: 7 }, (_, i) =>
        new Date(start + i * 86_400_000).toISOString().slice(0, 10)));
    },
    activeTargets: async (userId) => activeTargets(client, userId, clock.date),
    latestEstimate: (userId) => coachExpenditureStatus(admin, userId),
    searchFoods: async (userId, query, limit) => {
      const { getFoodDetail, searchFoods } = await import("@/lib/server/catalog");
      const [result, custom] = await Promise.all([
        searchFoods(client, { q: query, limit }),
        searchExactUserFood(admin, userId, query, opts.signal),
      ]);
      opts.signal?.throwIfAborted();
      const catalog = await Promise.all(result.hits.map(async (hit) => {
        const [{ data }, detail] = await Promise.all([
          cancellable(admin.rpc("get_or_create_food_ref", {
            p_user_id: userId, p_kind: "catalog",
            p_catalog_food_id: hit.catalogFoodId, p_user_food_id: null,
          }), opts.signal),
          getFoodDetail(client, hit.catalogFoodId, { catalogVersion: result.catalogVersion }),
        ]);
        return mapCatalogFoodHit(hit, detail, typeof data === "string" ? data : null);
      }));
      return [...(custom ? [custom] : []), ...catalog].slice(0, limit);
    },
    // Phase 13 §4, §9 R5 (owner ruling 2026-10-02): the confirmed profile hard rules travel with
    // the constraint row here too, the same as every other policy call site — a model that calls
    // this tool mid-turn must see them, not just the legacy avoid_allergens/banned_categories.
    getConstraints: async (userId) => policyProfile(userId),
    recentGut: async (userId, days) => {
      // gut_log.local_date is the account's own day, so the window steps back from the account's
      // today (stored zone, else the turn's zone), never the server's UTC date (audit A109).
      const today = await accountDay(client, userId, { purpose: "recentGut", requestZone: tz,
        now: clock.now ? new Date(clock.now) : new Date() });
      const from = addIsoDays(today.date, -days);
      const { data } = await client.from("gut_log")
        .select("local_date, state, note").eq("user_id", userId)
        .is("deleted_at", null).gte("local_date", from)
        .order("local_date", { ascending: false });
      return (data ?? []) as { local_date: string; state: string; note: string | null }[];
    },
    compose: async (userId, args) => {
      const { composeMeal } = await import("@/lib/coach/compose");
      const { composePoolPorts } = await import("@/lib/server/compose-pool-ports");
      const { buildDayContext } = await import("@/lib/server/day-context");
      const [target, profile, day] = await Promise.all([
        composeTarget(admin, userId, args.slot, clock),
        policyProfile(userId),
        // The slot's own clock (W9, O4a): read once more here for its "HH:MM" (DayContext never
        // carries it past `composeTarget`'s own macros). Absent slot: the wish's phrase or "other".
        args.slot ? buildDayContext(admin, userId, clock.date, clock.tz, args.slot) : null,
      ]);
      const slotClock = args.slot ? day?.slots.find((row) => row.slot === args.slot)?.time ?? null : null;
      const meal = await composeMeal(userId,
        { wish: args.wish, slot: args.slot ?? null, target, date: clock.date, slotClock },
        profile, {
          searchFoods: ports.searchFoods,
          eatsNames: async (uid) => {
            const { foodLists } = await import("@/lib/server/coach-context");
            return (await foodLists(client, uid)).eats;
          },
          ...composePoolPorts(client, admin, clock.now, clock.date),
        });
      return { ...meal, pendingSlots: await pendingMealSlots(admin, userId, clock) };
    },
    suggest: async (userId, args) => {
      if (args.kind === "recipe") {
        const { recipeAccessEnabled } = await import("@/lib/server/recipe-access");
        if (!recipeAccessEnabled(userId)) return { candidates: [], noResultReasons: [
          "Shared recipe discovery is not available for this account yet.",
        ] };
        const { loadRecipeCandidates } = await import("@/lib/server/recipe-candidates");
        const { search, unsupportedExclusion } = recipeSearchFromWish(args.wish ?? "", args.count ?? 3);
        if (unsupportedExclusion) return { candidates: [], noResultReasons: [
          "This search cannot check a one-off ingredient exclusion. Add the ingredient to Avoids, then search again.",
        ] };
        const result = await loadRecipeCandidates(client, userId,
          search, clock.now ? new Date(clock.now) : new Date());
        return { candidates: result.candidates, noResultReasons: result.noResultReasons,
          exactMatch: result.exactMatch };
      }
      const { suggestOptions } = await import("@/lib/coach/suggest");
      const { eatsForSuggestions } = await import("@/lib/server/coach-context");
      const { composePoolPorts } = await import("@/lib/server/compose-pool-ports"); // W10 acc. 1
      let eats: ReturnType<typeof eatsForSuggestions> | null = null;
      const suggestionEats = (uid: string) => (eats ??= eatsForSuggestions(client, uid));
      const day = viewedDay(admin, userId, clock, args.slot);
      const [target, profile] = await Promise.all([
        suggestionTarget(admin, userId, args, clock, day.viewed),
        policyProfile(userId),
      ]);
      // The rotation and history windows run on the turn's day, never the server's UTC date when
      // the model leaves `date` out (audit A110).
      return suggestOptions({ ...args, date: args.date ?? clock.date }, {
        userId,
        profile,
        target: async () => target,
        searchFoods: ports.searchFoods,
        ownFood: eatsOwnFood(client, (uid, name, signal) =>
          searchExactUserFood(admin, uid, name, signal ?? opts.signal)),
        eatsNames: async (uid) => (await suggestionEats(uid)).all,
        eatsAnchors: async (uid) => (await suggestionEats(uid)).anchors,
        ...composePoolPorts(client, admin, clock.now, clock.date),
        // `uid` is read explicitly, like `eatsNames`/`eatsAnchors` above, not closed over, and
        // the suggest budget's own signal bounds the read the same way it bounds everything else
        // this port builds (2026-10-03 audit, finding #4: this used to run unbounded ahead of
        // it). Deliberately not memoized across calls: a promise cache keyed by neither `uid`
        // nor `signal` would answer a differently-abled call with an earlier call's stale result
        // (round-2 audit, DeepSeek MAJOR #1). Each `suggest()` call reads this at most once.
        ruleReviewRequired: async (uid, signal) => (await getRuleReviewStatus(client, uid, signal)).required,
        pendingSlots: () => pendingMealSlots(admin, userId, clock),
        slotClock: day.slotClock, timeOfDay: day.timeOfDay,
      });
    },
    recipes: async (userId) => {
      const { recipeSummaries } = await import("@/lib/server/coach-context");
      return (await recipeSummaries(client, userId)).recipes;
    },
    dayPlan: async (userId, date) => {
      const { buildDayContext } = await import("@/lib/server/day-context");
      const day = await buildDayContext(admin, userId, date, tz);
      return { date: day.date, dayType: day.dayType, targets: day.targets,
        stillToEat: day.remaining, slots: day.slots,
        // #21: same flag names as the rendered context block (upper bound; check could not run).
        ...(day.consumedPartial ? { remaining_is_upper_bound: true } : {}),
        ...(day.nutritionUnchecked ? { nutrition_unchecked: true } : {}) };
    },
    dayEntries: async (userId, date) => {
      const { buildDayContext } = await import("@/lib/server/day-context");
      const day = await buildDayContext(admin, userId, date, tz); // caveat per entry, same shape
      return day.nutritionUnchecked
        ? day.entries.map((entry) => ({ ...entry, nutrition_unchecked: true })) : day.entries;
    },
    lookup: async (userId, subject) => {
      const { profile } = await getProfile(client, userId);
      // Phase 13 §9 R8: the same catalog search every coach tool grounds a food name against
      // (lib/coach/ground.ts) resolves the candidate. The D0 gate gets every stored term this
      // profile carries (no user name is stored here), and the turn's signal (review r1).
      return runLookup(admin, userId, subject, { searchFoods: ports.searchFoods },
        { allergens: profile.avoid_allergens, conditions: profile.conditions },
        { signal: opts.signal });
    },
    skipPreview: (userId, date, slot) => skipPreview(admin, userId, date, slot),
    newDraftId: newId,
  };
  return ports;
}
