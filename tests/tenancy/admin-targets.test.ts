/**
 * Spec 3.5 canary for lib/server/target-writes.ts: the target authority's write RPCs run on the
 * service-role client (migration 20261228090000 revokes them from `authenticated`), always for the
 * user id the caller verified. B holds a canary revision and a pending proposal. A, on A's own
 * session client, authors a pinned revision and tries to approve B's proposal: A's revision lands
 * for A only, the approval answers 404, and every row B owns is unchanged. The B-side control
 * (the same pinned write for B) proves the canary is the row a write would replace.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, userClient, type TestUser,
} from "../helpers/supabase";
import { activeProfile, authorTargets } from "@/lib/server/targets";
import { decideProposal } from "@/lib/server/proposals";
import { HttpError } from "@/lib/server/auth";
import { purge } from "./seed";
import { assertLocalTargets } from "./target-guard";

const CANARY_KCAL = 3737;
const DATE = "2020-05-05";

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await adminClient().from(table).insert(row).select("id").single();
  if (error) throw new Error(`seed ${table}: ${error.message}`);
  return String((data as { id: string }).id);
}

async function rowsOf(table: string, owner: string): Promise<string[]> {
  const { data, error } = await adminClient().from(table).select("*").eq("user_id", owner);
  if (error) throw new Error(`read ${table}: ${error.message}`);
  return (data ?? []).map((r) => JSON.stringify(r)).sort();
}

const revision = (owner: string, kcal: number) => ({ user_id: owner, effective_from: "2020-01-01",
  kcal_train: kcal, kcal_rest: kcal, authored_by: "user", mode: "grams", protein_g: 100, fat_g: 60,
  carb_g: 265, protein_g_min: 100, target_source: "manual",
  training_macros: { kcal, protein: 100, carbs: 265, fat: 60 },
  rest_macros: { kcal, protein: 100, carbs: 265, fat: 60 },
  input_weight_kg: 70, input_weight_source: "onboarding", input_training_weekdays: [1],
  input_activity_level: "moderate", input_goal: "maintain", formula_name: "tenancy" });

const pin = { mode: "grams", effectiveFrom: DATE, kcalTrain: 2400, kcalRest: 2200,
  grams: { proteinG: 140, fatG: 70, carbG: 300 } } as const;

describe.skipIf(!HAS_BRANCH || !HAS_DB)("target writes (service role) stay with their account (canary)", () => {
  let a: TestUser;
  let b: TestUser;
  let asA: SupabaseClient;
  let asB: SupabaseClient;
  let bProposal = "";

  beforeAll(async () => {
    assertLocalTargets();
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await purge([a.id, b.id]);
    [asA, asB] = await Promise.all([userClient(a), userClient(b)]);
    await insert("target_profiles", revision(a.id, 2000));
    await insert("target_profiles", revision(b.id, CANARY_KCAL));
    bProposal = await insert("target_proposals", { user_id: b.id, proposed: {},
      week_start: "2020-05-04" });
  });

  afterAll(async () => { await purge([a.id, b.id]); });

  it("A's session cannot reach the writers itself", async () => {
    const { error } = await asA.rpc("write_target_revision", { p_user_id: a.id, p_row: {} });
    expect(error?.code).toBe("42501");
  });

  it("A's pinned revision is written for A only; B's canary stays in force", async () => {
    const before = await rowsOf("target_profiles", b.id);
    const written = await authorTargets(asA, a.id, pin);
    expect(written.resolved.training.kcal).toBe(2400);
    expect((await activeProfile(adminClient(), a.id, DATE))?.id).toBe(written.id);
    expect(await rowsOf("target_profiles", b.id)).toEqual(before);
    expect((await activeProfile(adminClient(), b.id, DATE))?.kcal_train).toBe(CANARY_KCAL);
  });

  it("A cannot approve B's proposal: 404, and B's proposal and revisions are unchanged", async () => {
    const before = [await rowsOf("target_proposals", b.id), await rowsOf("target_profiles", b.id)];
    const refused = await decideProposal(asA, a.id, bProposal,
      { decision: "approve", expectedStatus: "pending" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HttpError);
    expect((refused as HttpError).status).toBe(404);
    expect([await rowsOf("target_proposals", b.id), await rowsOf("target_profiles", b.id)])
      .toEqual(before);
  });

  it("control: the same pinned write for B replaces B's canary", async () => {
    await authorTargets(asB, b.id, pin);
    expect((await activeProfile(adminClient(), b.id, DATE))?.kcal_train).not.toBe(CANARY_KCAL);
  });
});
