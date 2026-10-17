/**
 * `POST /api/foods/world` (Phase 18 D3, D4, D14, W2b): the only writer of `user_settings.food_world`
 * and of the condition confirmations. It runs on the service-role client because both are
 * server-written (migrations 20261213090200 and 20261213090300 refuse an authenticated write), and every read and
 * write below names this account's own id.
 *
 *   `closed` is always allowed: the stop switch.
 *   `open` answers 423 while the open world is unreleased (`OPEN_WORLD_ENABLED`, or a non-empty
 *   `OPEN_WORLD_USER_IDS` release list that does not name the account) or the account is
 *   held (`OPEN_WORLD_HOLD_USER_IDS`), and 409 `condition_review` while any stated condition is
 *   unconfirmed. Confirmations are accepted only in reviewed wording (`CONDITION_PACKS_ENABLED`,
 *   owner decision Q4); a `pack` choice adds the pack's allergen rules to the account first.
 *
 * The database re-checks the condition gate on the write itself, so a condition saved from another
 * device while this runs still keeps the account closed (the 409 below).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  effectiveFoodWorld, openWorldHeld, openWorldListed, openWorldOpenableFor, openWorldReleased,
  type OpenWorldEnv,
} from "@/lib/foods/world/access";
import { planConfirmations, unconfirmedConditions } from "@/lib/foods/world/condition-gate";
import type { ConditionPacksEnv } from "@/lib/policy/profiles/condition-packs";
import { HttpError } from "@/lib/server/auth";
import { ONBOARDING_CUTOVER, openedAfterCutover } from "@/lib/profile/onboarding-cutover";
import { normalizeAllergens, putProfile } from "@/lib/server/constraints";

export const foodWorldRequest = z.object({
  world: z.enum(["open", "closed"]),
  confirmations: z.array(z.object({
    condition: z.string().trim().min(1).max(200),
    choice: z.enum(["pack", "no_limit"]),
  })).max(20).optional(),
  /**
   * Sol round 2 BLOCK: the onboarding open-default's retry (lib/foods/world-open-client.ts) is
   * fire-and-forget and the Settings switch is the only thing that was asked to call
   * `clearWorldOpenPending` on a deliberate choice -- a UI promise this route cannot rely on.
   * `"onboarding_default"` marks a POST as that retry, never sent by Settings or the coach. See
   * the refusal in `setFoodWorld` below.
   */
  intent: z.literal("onboarding_default").optional(),
}).strict();
export type FoodWorldRequest = z.infer<typeof foodWorldRequest>;

export type FoodWorldResult =
  | { status: 200; body: { world: "open" | "closed" } }
  | { status: 409; body: { error: "condition_review"; conditions: string[]; reason?: string } }
  | { status: 423; body: { error: "held" | "open_world_not_released" } };

type Env = OpenWorldEnv & ConditionPacksEnv;

function failed(cause: unknown): never {
  throw new HttpError(503, "food_world_unavailable", "Your food settings could not be saved right now.", { cause });
}

async function readGate(admin: SupabaseClient, userId: string) {
  const [profile, confirmed] = await Promise.all([
    admin.from("constraint_profiles").select("rev,conditions,avoid_allergens,condition_review_required")
      .eq("user_id", userId).maybeSingle(),
    admin.from("food_world_condition_confirmations").select("condition_key").eq("user_id", userId),
  ]);
  if (profile.error || confirmed.error) failed(profile.error ?? confirmed.error);
  const row = profile.data as { rev: number; conditions: string[] | null; avoid_allergens: string[] | null;
    condition_review_required: boolean } | null;
  return {
    rev: row?.rev ?? 0, conditions: row?.conditions ?? [], allergens: row?.avoid_allergens ?? [],
    review: row?.condition_review_required === true,
    confirmed: new Set(((confirmed.data ?? []) as { condition_key: string }[]).map((r) => r.condition_key)),
  };
}

async function applyConfirmations(admin: SupabaseClient, userId: string, gate: Awaited<ReturnType<typeof readGate>>,
  plan: { confirmations: { key: string; choice: string }[]; allergens: string[] }): Promise<void> {
  const added = plan.allergens.filter((key) => !normalizeAllergens(gate.allergens).includes(key));
  if (added.length) {
    const saved = await putProfile(admin, userId, { baseRev: gate.rev,
      avoidAllergens: [...gate.allergens, ...added] });
    if (saved.status === "conflict") throw new HttpError(409, "conflict", "Your food rules just changed. Try again.");
  }
  if (plan.confirmations.length) {
    const { error } = await admin.from("food_world_condition_confirmations").upsert(plan.confirmations
      .map((entry) => ({ user_id: userId, condition_key: entry.key, choice: entry.choice,
        confirmed_at: new Date().toISOString() })), { onConflict: "user_id,condition_key" });
    if (error) failed(error);
    for (const entry of plan.confirmations) gate.confirmed.add(entry.key);
  }
}

/**
 * The onboarding default's conditional write matched no row: either the account has no settings
 * row yet (409 `profile_required`, the client retries) or a choice was already made, which this
 * answers as a no-op with the account's own current world (the client settles on it).
 */
async function settledDefault(admin: SupabaseClient, userId: string, env: Env): Promise<FoodWorldResult> {
  const current = await admin.from("user_settings").select("food_world,food_world_set_at,first_opened_at")
    .eq("user_id", userId).maybeSingle();
  if (current.error) failed(current.error);
  const row = current.data as { food_world?: string; food_world_set_at?: string | null;
    first_opened_at?: string | null } | null;
  if (!row) throw new HttpError(409, "profile_required", "Finish your profile first.");
  // An account opened before the onboarding cutover is never a brand-new account, so the default
  // never applies to it (audit 2026-10-10 A091): it moves over only through the invitation (D14, Q5).
  if (!openedAfterCutover(row.first_opened_at)) {
    return { status: 200, body: { world: effectiveFoodWorld(row.food_world, userId, env) } };
  }
  // A row that appeared after the write with nothing decided yet: retryable, never a settlement.
  if (!row.food_world_set_at) failed(new Error("food_world default raced a new settings row"));
  return { status: 200, body: { world: effectiveFoodWorld(row.food_world, userId, env) } };
}

export async function setFoodWorld(admin: SupabaseClient, userId: string, req: FoodWorldRequest,
  env: Env = process.env as Env): Promise<FoodWorldResult> {
  if (req.world === "open" && openWorldHeld(userId, env)) return { status: 423, body: { error: "held" } };
  // Staged release (OPEN_WORLD_USER_IDS): an account off a non-empty list is not released yet.
  if (req.world === "open" && (!openWorldReleased(env) || !openWorldListed(userId, env))) {
    return { status: 423, body: { error: "open_world_not_released" } };
  }
  const gate = await readGate(admin, userId);
  const plan = planConfirmations(gate.conditions, req.confirmations ?? [], env);
  if (!plan.ok) {
    return { status: 409, body: { error: "condition_review", conditions: plan.conditions, reason: plan.reason } };
  }
  await applyConfirmations(admin, userId, gate, plan);
  const open = unconfirmedConditions(gate.conditions, gate.confirmed);
  if (gate.review && open.length === 0) {
    const { error } = await admin.from("constraint_profiles").update({ condition_review_required: false })
      .eq("user_id", userId);
    if (error) failed(error);
  }
  if (req.world === "open" && open.length > 0) {
    return { status: 409, body: { error: "condition_review", conditions: open } };
  }
  // Backend-side guarantee (Sol round 2 BLOCK, no UI change required): a retried onboarding
  // default never overrides a choice this account already made -- by the default itself (once it
  // first lands) or by a person closing it again afterward. `food_world_set_at` is null only for
  // an account nothing has ever explicitly written.
  //
  // Sol round 3 BLOCK: the default used to read `food_world_set_at` and then update in a second
  // statement, so a close from another device landing between the two was overwritten. The
  // default is now ONE conditional UPDATE (`... where user_id = $1 and food_world_set_at is null`):
  // Postgres re-checks that predicate on the locked row, so an explicit choice that commits first
  // always excludes it, whatever the interleaving. An explicit choice (no intent) stays
  // unconditional, so it always wins over a default that committed before it.
  const isDefault = req.intent === "onboarding_default";
  let write = admin.from("user_settings")
    .update({ food_world: req.world, food_world_set_at: new Date().toISOString() })
    .eq("user_id", userId);
  // The default opens only a brand-new account (D14: "New accounts become open at onboarding
  // completion"); a grandfathered one finishing the Today invite or Settings "Finish profile" stays
  // closed until it accepts the invitation (audit 2026-10-10 A091). Both are predicates of the one
  // conditional write, so the rule and the "never decided" check hold on the same locked row.
  if (isDefault) write = write.is("food_world_set_at", null).gt("first_opened_at", ONBOARDING_CUTOVER);
  const { data, error } = await write.select("food_world").maybeSingle();
  if (error && /condition_review/.test(error.message ?? "")) {
    const fresh = await readGate(admin, userId);
    return { status: 409, body: { error: "condition_review",
      conditions: unconfirmedConditions(fresh.conditions, fresh.confirmed) } };
  }
  if (error) failed(error);
  if (!data && isDefault) return settledDefault(admin, userId, env);
  if (!data) throw new HttpError(409, "profile_required", "Finish your profile first.");
  return { status: 200, body: { world: req.world } };
}

/** The account's own current `food_world` ('closed' when the row is missing: the same default
 *  the column itself carries, migration 20261213090000). */
export async function readFoodWorld(admin: SupabaseClient, userId: string,
  env: Env = process.env as Env): Promise<"open" | "closed"> {
  const { data, error } = await admin.from("user_settings").select("food_world")
    .eq("user_id", userId).maybeSingle();
  if (error) failed(error);
  return effectiveFoodWorld((data as { food_world?: string } | null)?.food_world, userId, env);
}

/**
 * W13 (D14), Sol round 4 BLOCK: the server's own answer to "may any device seed the legacy
 * closed-world starter (default Favored marks) for this account?", so every device agrees. A
 * device-local pending flag cannot see another device's failed open POST.
 *
 * - `openDefaultPending`: the account went through the W13 onboarding default
 *   (`food_world_default_due_at`, stamped by the database in the same write that first set
 *   `onboarded_at`), nothing has decided its world yet (`food_world_set_at` null), it is still
 *   closed, it is a brand-new account (first opened after the onboarding cutover), and the
 *   default could still open it: released, not held, no unconfirmed condition -- exactly the
 *   cases where `setFoodWorld` would answer the default with `open`.
 * - `starterSeed`: the world is `closed`, the server row is onboarded, and no open default is
 *   pending. That covers a legacy account (onboarded before W13, no due stamp), an explicit closed
 *   choice (`food_world_set_at` set while closed), a grandfathered account that finished the
 *   invite after W13 (due stamp, but not brand new), and a W13 account whose default can never open
 *   it by policy (unreleased, held, or a condition to confirm -- the default's 423/409, which the
 *   phone also settles as closed). An open account, a row not yet onboarded on the server, and a
 *   pending default never seed. A failed read throws (503), and the phone seeds nothing on it.
 */
export type FoodWorldState = {
  world: "open" | "closed";
  openDefaultPending: boolean;
  starterSeed: boolean;
};

export async function readFoodWorldState(admin: SupabaseClient, userId: string,
  env: Env = process.env as Env): Promise<FoodWorldState> {
  const { data, error } = await admin.from("user_settings")
    .select("food_world,food_world_set_at,food_world_default_due_at,onboarded_at,first_opened_at")
    .eq("user_id", userId).maybeSingle();
  if (error) failed(error);
  const row = data as { food_world?: string; food_world_set_at?: string | null;
    food_world_default_due_at?: string | null; onboarded_at?: string | null;
    first_opened_at?: string | null } | null;
  const world = effectiveFoodWorld(row?.food_world, userId, env);
  // A stored-open account the release settings read as closed never seeds the closed starter:
  // its own choice comes back, unchanged, when it is allowed again (no write here).
  if (!row || row.food_world === "open") return { world, openDefaultPending: false, starterSeed: false };
  let openDefaultPending = false;
  // The due stamp is written for every first `onboarded_at`, a grandfathered account's too; only a
  // brand-new account's default is pending (audit 2026-10-10 A091), so no device adopts it for an
  // existing account and the closed starter seeds for it as it always did.
  if (row.food_world_default_due_at && !row.food_world_set_at
    && openedAfterCutover(row.first_opened_at) && openWorldOpenableFor(userId, env)) {
    const gate = await readGate(admin, userId);
    openDefaultPending = unconfirmedConditions(gate.conditions, gate.confirmed).length === 0;
  }
  return { world, openDefaultPending, starterSeed: Boolean(row.onboarded_at) && !openDefaultPending };
}

/**
 * W13 (D14): whether to show this account the dismissible open-world invitation. False for an
 * already-open account (nothing to invite into), a held account (D14, Q5 — stays `closed` with
 * no invitation until the owner decides), or while the open world is unreleased. A held or
 * unreleased account answers `eligible: false` without reading the account's own row at all, so
 * the one `OPEN_WORLD_HOLD_USER_IDS` allowlist is the only thing deciding it either way.
 */
export async function invitationEligible(
  admin: SupabaseClient, userId: string, env: Env = process.env as Env,
): Promise<boolean> {
  if (!openWorldOpenableFor(userId, env)) return false;
  return (await readFoodWorld(admin, userId, env)) === "closed";
}
