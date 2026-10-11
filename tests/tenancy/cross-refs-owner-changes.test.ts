/**
 * PR #250 review r1, findings 1, 2 and 6. The same-owner triggers check a child row when it is
 * written. A child row can also become cross-account without being written, when its parent
 * changes owner or is re-parented. Migration 20261103090100 therefore makes the owner of every
 * referenced parent fixed after insert. No app code changes an owner. This suite proves:
 *
 * - the service role cannot change `user_id` on any referenced parent, or re-parent a food ref
 *   or a recipe revision onto another account's row;
 * - ordinary service-role updates and deletes of those parents still work, including the cascades
 *   and the ON DELETE SET NULL to the children;
 * - a health sample's ingest event must come from the sample's own source.
 */
// Refuses any non-local database before anything else runs (PR #247 review r9).
import "./local-only";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, ensureUser, resetUser, type TestUser } from "../helpers/supabase";
import { admin, hex, must, one, seedOwned, seedSource, type Owned } from "./xref-fixtures";

const PARENTS: { table: string; id: (o: Owned) => string }[] = [
  { table: "user_foods", id: (o) => o.userFood },
  { table: "log_entries", id: (o) => o.entry },
  { table: "recipes", id: (o) => o.recipe },
  { table: "favorites_meals", id: (o) => o.meal },
  { table: "duplicate_groups", id: (o) => o.group },
  { table: "coach_threads", id: (o) => o.thread },
  { table: "ai_calls", id: (o) => o.aiCall },
  { table: "health_sources", id: (o) => o.source },
  { table: "ingest_events", id: (o) => o.event },
  { table: "expenditure_estimates", id: (o) => o.estimate },
];

describe.skipIf(!HAS_BRANCH)("a referenced parent cannot change owner", () => {
  let a: TestUser;
  let b: TestUser;
  let ownA: Owned;
  let ownB: Owned;

  beforeAll(async () => {
    [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    await Promise.all([resetUser(a.id), resetUser(b.id)]);
    [ownA, ownB] = await Promise.all([seedOwned(a, "a"), seedOwned(b, "b")]);
  });

  afterAll(async () => {
    await admin().from("media_objects").delete().in("user_id", [a.id, b.id]);
    await Promise.all([resetUser(a.id), resetUser(b.id)]);
  });

  for (const p of PARENTS) {
    it(`${p.table}: the service role cannot move A's row to B`, async () => {
      const { error } = await admin().from(p.table).update({ user_id: b.id }).eq("id", p.id(ownA));
      expect(error?.code).toBe("42501");
      const kept = await one(admin().from(p.table).select("user_id").eq("id", p.id(ownA)).single(),
        `read ${p.table}`);
      expect(kept.user_id).toBe(a.id);
    });

    it(`${p.table}: writing the same owner back is not a change`, async () => {
      await must(admin().from(p.table).update({ user_id: a.id }).eq("id", p.id(ownA)),
        `same-owner update ${p.table}`);
    });
  }

  it("food_refs: the service role cannot re-point A's food ref at B's user food", async () => {
    const { error } = await admin().from("food_refs").update({ user_food_id: ownB.userFood })
      .eq("id", ownA.foodRef);
    expect(error).not.toBeNull();
    const kept = await one(admin().from("food_refs").select("user_food_id").eq("id", ownA.foodRef)
      .single(), "read food ref");
    expect(kept.user_food_id).toBe(ownA.userFood);
  });

  it("recipe_revisions: the service role cannot move A's revision under B's recipe", async () => {
    const { error } = await admin().from("recipe_revisions").update({ recipe_id: ownB.recipe })
      .eq("id", ownA.revision);
    expect(error?.code).toBe("42501");
  });

  it("ordinary service-role updates of a parent still work", async () => {
    await must(admin().from("log_entries").update({ note: "edited" }).eq("id", ownA.entry), "entry");
    await must(admin().from("recipes").update({ name: "renamed" }).eq("id", ownA.recipe), "recipe");
    await must(admin().from("coach_threads").update({ title: "t" }).eq("id", ownA.thread), "thread");
    await must(admin().from("health_sources").update({ revoked_at: new Date().toISOString() })
      .eq("id", ownA.source), "source");
  });

  it("deleting A's parents still cascades to, or clears, her children", async () => {
    const own = await seedOwned(a, "del");
    const item = crypto.randomUUID();
    await must(admin().from("log_items").insert({ id: item, entry_id: own.entry, seq: 1, qty: 1,
      unit: "g", food_ref_id: own.foodRef, grams: 1, snapshot: {} }), "item");
    await must(admin().from("duplicate_group_members").insert({ group_id: own.group,
      entry_id: own.entry }), "member");
    const path = `media/${a.id}/${crypto.randomUUID()}.jpg`;
    await must(admin().from("media_objects").insert({ path, user_id: a.id, kind: "image", bytes: 1,
      entry_id: own.entry }), "media");
    await must(admin().from("favorites_recipes").insert({ user_id: a.id, recipe_id: own.recipe }),
      "favorite recipe");

    await must(admin().from("log_entries").delete().eq("id", own.entry), "delete entry");
    await must(admin().from("recipes").delete().eq("id", own.recipe), "delete recipe");

    expect(await must(admin().from("log_items").select("id").eq("id", item), "items")).toEqual([]);
    expect(await must(admin().from("duplicate_group_members").select("entry_id")
      .eq("group_id", own.group), "members")).toEqual([]);
    const media = await one(admin().from("media_objects").select("entry_id").eq("path", path)
      .single(), "media");
    expect(media.entry_id).toBeNull();
    expect(await must(admin().from("favorites_recipes").select("recipe_id")
      .eq("recipe_id", own.recipe), "favorites")).toEqual([]);
  });
});

describe.skipIf(!HAS_BRANCH)("a health sample's event comes from the sample's source", () => {
  let a: TestUser;

  beforeAll(async () => {
    a = await ensureUser("a");
    await resetUser(a.id);
  });

  afterAll(async () => {
    await resetUser(a.id);
  });

  const sample = (source: string, event: string) => ({ user_id: a.id, type: "step_count", value: 1,
    unit: "count", source_id: source, ingest_event_id: event, tz: "UTC",
    start_time: "2026-11-03T00:00:00Z", end_time: "2026-11-03T00:00:00Z" });

  it("refuses A's sample from one source that names an event from her other source", async () => {
    const [one1, two] = await Promise.all([seedSource(a.id), seedSource(a.id)]);
    const { error } = await admin().from("health_samples").insert(sample(one1.source, two.event));
    expect(error?.code).toBe("42501");
  });

  // PR #250 review r2: moving the event to another of A's sources would leave its samples on the
  // old source while their event names the new one.
  it("refuses moving an ingest event to another of A's sources", async () => {
    const [from, to] = await Promise.all([seedSource(a.id), seedSource(a.id)]);
    await must(admin().from("health_samples").insert(sample(from.source, from.event)), "sample");
    const { error } = await admin().from("ingest_events").update({ source_id: to.source })
      .eq("id", from.event);
    expect(error?.code).toBe("42501");
    const kept = await one(admin().from("ingest_events").select("source_id").eq("id", from.event)
      .single(), "read event");
    expect(kept.source_id).toBe(from.source);
  });

  it("accepts the sample when source and event agree, and health_ingest_apply still applies", async () => {
    const s = await seedSource(a.id);
    await must(admin().from("health_samples").insert(sample(s.source, s.event)), "sample");
    const applied = await admin().rpc("health_ingest_apply", { p_user_id: a.id,
      p_source_id: s.source, p_event_id: s.event, p_samples: [{ type: "step_count", value: 5,
        unit: "count", start_time: "2026-11-04T00:00:00Z", end_time: "2026-11-04T01:00:00Z",
        tz: "UTC", vendor_sample_id: hex() }] });
    expect(applied.error).toBeNull();
  });

  it("health_ingest_apply refuses another account's event", async () => {
    const b = await ensureUser("b");
    const mine = await seedSource(a.id);
    const theirs = await seedSource(b.id);
    const applied = await admin().rpc("health_ingest_apply", { p_user_id: a.id,
      p_source_id: mine.source, p_event_id: theirs.event, p_samples: [{ type: "step_count", value: 5,
        unit: "count", start_time: "2026-11-05T00:00:00Z", end_time: "2026-11-05T01:00:00Z",
        tz: "UTC", vendor_sample_id: hex() }] });
    expect(applied.error?.code).toBe("42501");
    await resetUser(b.id);
  });
});
