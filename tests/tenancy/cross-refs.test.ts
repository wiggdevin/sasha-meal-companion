/**
 * Review r1 finding 2 (spec 3.2): a row one account owns must not point at a row another account
 * owns. For every foreign key from an account-owned table to another (generated from the catalog,
 * excluding the ownership edge), the suite writes, through the path that can actually write that
 * table (review r3 finding 2):
 *
 * - `writer: "user"`: user A with her JWT, for tables where the manifest gives her insert and
 *   update. The gate below fails if a table declared this way does not grant them, because a
 *   refusal there would prove nothing about the reference.
 * - `writer: "service_role"`: the admin client, for tables only server code writes
 *   (health_samples, ingest_events, target_proposals). RLS does not apply to it, so a refusal
 *   proves the same-owner database guard, either the migration 20261103090100 trigger or the
 *   recipe selection's composite owner foreign key.
 *
 * Each reference gets: an insert of A's row pointing at B's row, a repoint of A's row at B's row,
 * and (tables with user_id, user writer) a row filed under B's user_id pointing at A's row. Each
 * must persist nothing. A same-owner CONTROL, through the same writer, must persist: it proves the
 * probe really performs the write, so a refusal is about the reference and not about the path.
 * `write_target_proposal`, the definer RPC the weekly job calls, is probed as well.
 *
 * `holes` lists cases known to be open (a plain test proving the write persists); it is empty now.
 * `notProven` would name a reference no probe can exercise, with the reason; it is empty now.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HAS_BRANCH, HAS_DB, adminClient, ensureUser, userClient, type TestUser,
} from "../helpers/supabase";
import { crossRefs } from "./catalog";
import type { Fixture } from "./fixtures";
import declaredRefs from "./cross-refs.json";
import manifest from "./table-ops.json";
import { build, clear, find, purge, seed } from "./seed";

type Case = "insert" | "update" | "underB";
/**
 * `align` names columns a CONTROL row must copy from its same-owner target to be valid at all
 * (a sample's source must be its event's source). Foreign probes never align: every other column
 * stays A's own, so a refusal can only come from the reference under test (review r6 finding 1).
 */
type Declared = { writer: "user" | "service_role"; align?: Record<string, string>;
  holes?: Case[]; reason?: string; notProven?: string };
const refs = declaredRefs as Record<string, Declared>;
const tables = manifest as Record<string, { seed: string; ops: string[] }>;
const seeds = Object.fromEntries(Object.entries(tables).map(([t, v]) => [t, v.seed]));
const HAS_USER_ID = new Set(["coach_messages", "duplicate_groups", "favorites_foods",
  "favorites_recipes", "health_samples", "ingest_events", "media_objects", "target_proposals",
  "user_food_prefs"]);

type Outcome = { error: string | null; persisted: boolean };

/** `f` with `column` pointing at `target`, plus any column the reference requires to match. */
function pointAt(f: Fixture, column: string, target: Fixture, align: Record<string, string> = {}):
  Fixture {
  const id = target.match.id;
  const extra = Object.fromEntries(Object.entries(align).map(([mine, theirs]) =>
    [mine, target.row[theirs]]));
  const row = { ...f.row, ...extra, [column]: id };
  const match = column in f.match ? { ...f.match, [column]: id } : f.match;
  return { ...f, row, match };
}

/** The write, then what the database holds: is there a row at `f`'s key whose `column` is `id`? */
async function attempt(client: SupabaseClient, f: Fixture, op: "insert" | "update",
  column: string, id: unknown, patch: Record<string, unknown> = {}): Promise<Outcome> {
  await clear(f);
  if (op === "insert") {
    const { error } = await client.from(f.table).insert(f.row);
    return { error: error?.message ?? null, persisted: (await find(f))?.[column] === id };
  }
  const seeded = await adminClient().from(f.table).insert(f.row);
  if (seeded.error) throw new Error(`seed ${f.table}: ${seeded.error.message}`);
  const { error } = await client.from(f.table).update({ ...patch, [column]: id }).match(f.match);
  const moved = column in f.match ? { ...f, match: { ...f.match, [column]: id } } : f;
  return { error: error?.message ?? null, persisted: (await find(moved))?.[column] === id };
}

describe.skipIf(!HAS_DB)("cross-account references are declared", () => {
  it("the generated reference list equals tests/tenancy/cross-refs.json", () => {
    const found = crossRefs().map((r) => `${r.table}.${r.column}`).sort();
    expect(found).toEqual(Object.keys(refs).sort());
  });

  it("a user-written reference sits in a table the user may insert into and update", () => {
    const unprovable = Object.entries(refs).filter(([key, v]) => v.writer === "user"
      && !["insert", "update"].every((op) => tables[key.split(".")[0]].ops.includes(op)))
      .map(([key]) => key);
    expect(unprovable).toEqual([]);
  });

  it("every open or unproven reference names its reason", () => {
    const silent = Object.entries(refs).filter(([, v]) => ((v.holes?.length ?? 0) > 0
      && (v.reason ?? "").length < 20) || (v.notProven !== undefined && v.notProven.length < 20))
      .map(([k]) => k);
    expect(silent).toEqual([]);
  });
});

describe.skipIf(!HAS_BRANCH || !HAS_DB)("no row points at another account's row", () => {
  let a: TestUser;
  let b: TestUser;
  let asA: SupabaseClient;

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await purge([a.id, b.id]);
    asA = await userClient(a);
  });

  afterAll(async () => {
    await purge([a.id, b.id]);
  });

  /** Isolation for a closed case; proof of the write for a declared hole. */
  function check(key: string, c: Case, name: string, run: () => Promise<Outcome>): void {
    const hole = refs[key]?.holes?.includes(c) ?? false;
    if (!hole) {
      it(name, async () => {
        const outcome = await run();
        expect(outcome.persisted).toBe(false);
        // A service-role write bypasses RLS, so require the database refusal to name this
        // reference's same-owner guard (review r6 finding 1).
        // A column that may never move after insert (ingest_events.source_id, PR #250 review r2)
        // is refused as "<table>.user_id/source_id is fixed after insert": the message must still
        // name this table and this column.
        if (refs[key]?.writer === "service_role") {
          const [table, column] = key.split(".");
          if (key === "recipe_plan_selections.target_revision_id") {
            // The composite FK checks both the revision and its owner. Name the exact constraint:
            // a generic failure (or an unrelated FK) must not satisfy this canary.
            expect(outcome.error ?? "").toContain(
              'foreign key constraint "recipe_plan_selections_target_owner_fk"');
          } else {
            expect(outcome.error ?? "").toMatch(
              new RegExp(`cross_account_reference: ${table}\\.(?:[a-z_]+/)*${column}\\b`));
          }
        }
      });
      return;
    }
    it(`KNOWN HOLE (${refs[key]?.reason}): ${name} — the write succeeds today`, async () => {
      expect(await run()).toEqual({ error: null, persisted: true });
    });
  }

  const cases = HAS_DB ? crossRefs() : [];
  for (const r of cases) {
    const key = `${r.table}.${r.column}`;
    const d = refs[key];
    if (!d || d.notProven) continue;
    const via = d.writer === "user" ? "A" : "the service role";
    const writer = () => (d.writer === "user" ? asA : adminClient());

    it(`${key}: CONTROL — ${via} can point A's row at A's own ${r.references}`, async () => {
      const own = await seed(seeds[r.references], a.id);
      const f = pointAt(await build(seeds[r.table], a.id), r.column, own, d.align);
      expect(await attempt(writer(), f, "insert", r.column, own.match.id))
        .toEqual({ error: null, persisted: true });
    });

    check(key, "insert", `${key}: ${via} cannot point A's new row at B's ${r.references}`,
      async () => {
        const target = await seed(seeds[r.references], b.id);
        // No alignment: every other column stays A's own, so only this reference differs.
        const f = pointAt(await build(seeds[r.table], a.id), r.column, target);
        return attempt(writer(), f, "insert", r.column, target.match.id);
      });

    check(key, "update", `${key}: ${via} cannot repoint A's row at B's ${r.references}`,
      async () => {
        const target = await seed(seeds[r.references], b.id);
        const f = await build(seeds[r.table], a.id);
        return attempt(writer(), f, "update", r.column, target.match.id);
      });

    if (d.writer === "user" && HAS_USER_ID.has(r.table)) {
      check(key, "underB", `${key}: A cannot file a row under B's user_id that points at her ${
        r.references}`, async () => {
        const own = await seed(seeds[r.references], a.id);
        const f = pointAt(await build(seeds[r.table], b.id), r.column, own, d.align);
        return attempt(asA, f, "insert", r.column, own.match.id);
      });
    }
  }

  it("a referenced target revision cannot change owner after a selection is saved", async () => {
    const selection = await seed("recipe_plan_selections", a.id);
    const targetId = selection.row.target_revision_id;
    const changed = await adminClient().from("target_profiles")
      .update({ user_id: b.id }).eq("id", targetId);
    expect(changed.error?.message).toContain(
      'foreign key constraint "recipe_plan_selections_target_owner_fk"');
    expect((await adminClient().from("target_profiles").select("user_id")
      .eq("id", targetId).single()).data?.user_id).toBe(a.id);
  });

  it("write_target_proposal (weekly job RPC): refuses B's estimate, accepts A's own", async () => {
    const [mine, theirs] = await Promise.all([seed("expenditure_estimates", a.id),
      seed("expenditure_estimates", b.id)]);
    const propose = (estimateId: unknown, week: string) => adminClient()
      .rpc("write_target_proposal", { p_user_id: a.id, p_week_start: week,
        p_based_on_estimate_id: estimateId, p_proposed: { kcalTrain: 2000 } });
    const refused = await propose(theirs.match.id, "2042-01-06");
    expect(refused.error).not.toBeNull();
    const accepted = await propose(mine.match.id, "2042-01-13");
    expect(accepted.error).toBeNull();
    const rows = await adminClient().from("target_proposals").select("based_on_estimate_id")
      .eq("user_id", a.id).in("week_start", ["2042-01-06", "2042-01-13"]);
    expect(rows.error).toBeNull();
    expect(rows.data).toEqual([{ based_on_estimate_id: mine.match.id }]);
  });
});
