// tests/sync/membership-backfill-on-ref-create-db.test.ts
// Loop-3 data-integrity finding (2026-10-03): production's membership_contradictions audit found
// "partial" same-name families — some food_refs carrying this account's eats/avoid mark, others
// with no user_food_prefs row — because `set_food_membership` only marks the refs that exist at
// the moment it runs, and a food_ref is minted lazily the first time anyone references that exact
// row. `get_or_create_food_ref` (20261207090000) now backfills a brand-new ref to the CALLING
// account's existing mark for that normalized name. This runs against the real RPCs, not a fake.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestUsers, HAS_BRANCH } from "../helpers/supabase";
import { dropCatalogFoods, seedCatalogFood } from "../log/fixtures";

const run = HAS_BRANCH ? describe : describe.skip;
const CATALOG_PREFIX = "backfill-ref-create-";

run("get_or_create_food_ref backfills an existing membership mark onto a new ref", () => {
  let admin: SupabaseClient;
  let userId: string;
  let otherUserId: string;
  let otherClient: SupabaseClient;
  const name = `Backfill Test Food ${crypto.randomUUID()}`;
  const nameNorm = name.toLowerCase();
  const nameNorms: string[] = [nameNorm];
  const foodIds: string[] = [];

  beforeAll(async () => {
    const users = await createTestUsers();
    admin = users.admin;
    userId = users.a.userId;
    otherUserId = users.b.userId;
    otherClient = users.b.client;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("food_membership_revisions").delete()
      .in("user_id", [userId, otherUserId]).in("name_norm", nameNorms);
    if (foodIds.length > 0) {
      await admin.from("user_foods").delete().in("user_id", [userId, otherUserId]).in("id", foodIds);
    }
    await dropCatalogFoods(admin, CATALOG_PREFIX);
  });

  it("gives a new same-name ref the account's existing mark, and leaves an unmarked name neutral", async () => {
    const insertFood = async (foodName: string) => {
      const { data, error } = await admin.from("user_foods")
        .insert({ user_id: userId, name: foodName, kind: "custom" }).select("id").single();
      expect(error).toBeNull();
      foodIds.push(data!.id as string);
      return data!.id as string;
    };

    const foodAId = await insertFood(name);
    const refA = await admin.rpc("get_or_create_food_ref",
      { p_user_id: userId, p_kind: "user", p_catalog_food_id: null, p_user_food_id: foodAId });
    expect(refA.error).toBeNull();

    const mark = await admin.rpc("set_food_membership",
      { p_user: userId, p_name_norm: name, p_status: "eats", p_note: null, p_rev: 1 });
    expect(mark.error).toBeNull();

    const { data: prefA } = await admin.from("user_food_prefs").select("status,rev")
      .eq("user_id", userId).eq("food_ref_id", refA.data as string).maybeSingle();
    // Pins the claim the backfill's own rev relies on: `set_food_membership` itself starts a
    // fresh ref's pref row at rev 1, the same value the backfill below uses for refB.
    expect(prefA).toMatchObject({ status: "eats", rev: 1 });

    // A second row that normalizes to the SAME base name, minted AFTER the mark — the exact
    // production shape: a food_ref created later for a name this account already marked.
    const foodBId = await insertFood(`${name}, variant`);
    const refB = await admin.rpc("get_or_create_food_ref",
      { p_user_id: userId, p_kind: "user", p_catalog_food_id: null, p_user_food_id: foodBId });
    expect(refB.error).toBeNull();
    expect(refB.data).not.toBe(refA.data);

    const { data: prefB } = await admin.from("user_food_prefs").select("status")
      .eq("user_id", userId).eq("food_ref_id", refB.data as string).maybeSingle();
    expect(prefB?.status).toBe("eats");

    // Idempotent: minting (looking up) refA again never overwrites its existing pref row.
    const refAAgain = await admin.rpc("get_or_create_food_ref",
      { p_user_id: userId, p_kind: "user", p_catalog_food_id: null, p_user_food_id: foodAId });
    expect(refAAgain.data).toBe(refA.data);
    const { data: prefAAgain } = await admin.from("user_food_prefs").select("status,rev")
      .eq("user_id", userId).eq("food_ref_id", refA.data as string).maybeSingle();
    expect(prefAAgain?.status).toBe("eats");
    expect(prefAAgain?.rev).toBe(1);
  });

  it("copies the family's note onto a backfilled ref, and starts it at rev 1 like any fresh mark", async () => {
    // Several marks at a client-chosen p_rev well above 1 — food_membership_revisions.rev is a
    // different counter (the name-level CAS token) from user_food_prefs.rev (a per-ref write
    // counter); set_food_membership itself always inserts a brand-new ref's pref row at rev 1
    // regardless of how high the name-level rev has climbed, and the backfill matches that.
    const notedName = `Backfill Note Food ${crypto.randomUUID()}`;
    const notedFirstId = await (async () => {
      const { data, error } = await admin.from("user_foods")
        .insert({ user_id: userId, name: notedName, kind: "custom" }).select("id").single();
      expect(error).toBeNull();
      foodIds.push(data!.id as string);
      return data!.id as string;
    })();
    const firstRef = await admin.rpc("get_or_create_food_ref",
      { p_user_id: userId, p_kind: "user", p_catalog_food_id: null, p_user_food_id: notedFirstId });
    expect(firstRef.error).toBeNull();

    await admin.rpc("set_food_membership",
      { p_user: userId, p_name_norm: notedName, p_status: "avoid", p_note: null, p_rev: 1 });
    const marked = await admin.rpc("set_food_membership", { p_user: userId,
      p_name_norm: notedName, p_status: "avoid", p_note: "flares a migraine", p_rev: 5 });
    expect(marked.error).toBeNull();

    const laterId = await (async () => {
      const { data, error } = await admin.from("user_foods")
        .insert({ user_id: userId, name: `${notedName}, variant`, kind: "custom" })
        .select("id").single();
      expect(error).toBeNull();
      foodIds.push(data!.id as string);
      return data!.id as string;
    })();
    const laterRef = await admin.rpc("get_or_create_food_ref",
      { p_user_id: userId, p_kind: "user", p_catalog_food_id: null, p_user_food_id: laterId });
    expect(laterRef.error).toBeNull();

    const { data: backfilled } = await admin.from("user_food_prefs").select("status,note,rev")
      .eq("user_id", userId).eq("food_ref_id", laterRef.data as string).maybeSingle();
    expect(backfilled).toMatchObject({ status: "avoid", note: "flares a migraine", rev: 1 });
  });

  it("backfills the catalog branch too — a ref minted by a search, scan, log or recipe match", async () => {
    // The production shape: `set_food_membership` only sees the catalog food_refs that exist at
    // the moment it runs; a later catalog food with the SAME base name (a different source row)
    // mints its own food_ref — through seedCatalogFood's own get_or_create_food_ref call, exactly
    // the way a search result, barcode scan, log entry or recipe match would — well after that.
    const catalogName = `Backfill Catalog Food ${crypto.randomUUID()}`;
    nameNorms.push(catalogName.toLowerCase());
    const first = await seedCatalogFood(admin, userId, {
      sourceId: `${CATALOG_PREFIX}${crypto.randomUUID()}`, description: catalogName,
      per100g: { energy_kcal: 100 },
    });

    const mark = await admin.rpc("set_food_membership",
      { p_user: userId, p_name_norm: catalogName, p_status: "eats", p_note: null, p_rev: 1 });
    expect(mark.error).toBeNull();

    // A second, later active catalog revision for the same food — a different source row,
    // `get_or_create_food_ref` called with p_kind "catalog" only once this account reaches it.
    const second = await seedCatalogFood(admin, userId, {
      sourceId: `${CATALOG_PREFIX}${crypto.randomUUID()}`, description: `${catalogName}, raw`,
      per100g: { energy_kcal: 95 },
    });
    expect(second.foodRefId).not.toBe(first.foodRefId);

    const { data: backfilled } = await admin.from("user_food_prefs").select("status,rev")
      .eq("user_id", userId).eq("food_ref_id", second.foodRefId).maybeSingle();
    expect(backfilled).toMatchObject({ status: "eats", rev: 1 });
  });

  it("matches a mark to a differently-cased name the same way food_name_norm does everywhere else", async () => {
    // food_name_norm lower-cases (and unaccents) before comparing, so a mark taken from mixed-case
    // typed text must still reach a ref whose own source name is cased differently.
    const mixedName = `MiXeD CaSe BackFILL Food ${crypto.randomUUID()}`;
    nameNorms.push(mixedName.toLowerCase());
    const insertFood = async (foodName: string) => {
      const { data, error } = await admin.from("user_foods")
        .insert({ user_id: userId, name: foodName, kind: "custom" }).select("id").single();
      expect(error).toBeNull();
      foodIds.push(data!.id as string);
      return data!.id as string;
    };

    const firstId = await insertFood(mixedName.toUpperCase());
    const firstRef = await admin.rpc("get_or_create_food_ref",
      { p_user_id: userId, p_kind: "user", p_catalog_food_id: null, p_user_food_id: firstId });
    expect(firstRef.error).toBeNull();

    // The mark itself is typed in yet another casing.
    const mark = await admin.rpc("set_food_membership",
      { p_user: userId, p_name_norm: mixedName.toLowerCase(), p_status: "avoid", p_note: null,
        p_rev: 1 });
    expect(mark.error).toBeNull();

    const laterId = await insertFood(mixedName.toLowerCase());
    const laterRef = await admin.rpc("get_or_create_food_ref",
      { p_user_id: userId, p_kind: "user", p_catalog_food_id: null, p_user_food_id: laterId });
    expect(laterRef.error).toBeNull();
    expect(laterRef.data).not.toBe(firstRef.data);

    const { data: backfilled } = await admin.from("user_food_prefs").select("status")
      .eq("user_id", userId).eq("food_ref_id", laterRef.data as string).maybeSingle();
    expect(backfilled?.status).toBe("avoid");
  });

  it("never reaches across accounts: a cross-user call backfills only the caller's own mark", async () => {
    // Driven as an AUTHENTICATED call under user B's own session (not the admin client), so this
    // proves the security-definer backfill is scoped by the asserted caller, not merely by
    // convention — the same boundary tests/rls/cross-user.test.ts already pins for this RPC's
    // existing ref-creation half. User A marks a name; user B creates her OWN food under that
    // same name and mints her own ref as herself — B's ref must stay neutral.
    const sharedName = `Cross User Backfill Food ${crypto.randomUUID()}`;
    nameNorms.push(sharedName.toLowerCase());
    const insertFood = async (ownerId: string, foodName: string) => {
      const { data, error } = await admin.from("user_foods")
        .insert({ user_id: ownerId, name: foodName, kind: "custom" }).select("id").single();
      expect(error).toBeNull();
      foodIds.push(data!.id as string);
      return data!.id as string;
    };

    const aFoodId = await insertFood(userId, sharedName);
    const aRef = await admin.rpc("get_or_create_food_ref",
      { p_user_id: userId, p_kind: "user", p_catalog_food_id: null, p_user_food_id: aFoodId });
    expect(aRef.error).toBeNull();
    const aMark = await admin.rpc("set_food_membership",
      { p_user: userId, p_name_norm: sharedName, p_status: "avoid", p_note: null, p_rev: 1 });
    expect(aMark.error).toBeNull();

    const bFoodId = await insertFood(otherUserId, `${sharedName}, variant`);
    const bRef = await otherClient.rpc("get_or_create_food_ref", { p_user_id: otherUserId,
      p_kind: "user", p_catalog_food_id: null, p_user_food_id: bFoodId });
    expect(bRef.error).toBeNull();
    expect(bRef.data).not.toBe(aRef.data);

    const { data: bPref } = await admin.from("user_food_prefs").select("status")
      .eq("user_id", otherUserId).eq("food_ref_id", bRef.data as string).maybeSingle();
    expect(bPref).toBeNull();

    // And the reverse never happened either: A's own ref is still exactly what A set, untouched
    // by B's later, unrelated call.
    const { data: aPref } = await admin.from("user_food_prefs").select("status")
      .eq("user_id", userId).eq("food_ref_id", aRef.data as string).maybeSingle();
    expect(aPref?.status).toBe("avoid");
  });

  it("never marks a ref for a name this account has not touched", async () => {
    const untouchedName = `Untouched Backfill Food ${crypto.randomUUID()}`;
    const untouchedId = await (async () => {
      const { data, error } = await admin.from("user_foods")
        .insert({ user_id: userId, name: untouchedName, kind: "custom" }).select("id").single();
      expect(error).toBeNull();
      foodIds.push(data!.id as string);
      return data!.id as string;
    })();

    const ref = await admin.rpc("get_or_create_food_ref",
      { p_user_id: userId, p_kind: "user", p_catalog_food_id: null, p_user_food_id: untouchedId });
    expect(ref.error).toBeNull();

    const { data: pref } = await admin.from("user_food_prefs").select("status")
      .eq("user_id", userId).eq("food_ref_id", ref.data as string).maybeSingle();
    expect(pref).toBeNull();
  });
});
