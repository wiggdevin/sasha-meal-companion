/**
 * U6 (D3, F2): the profile omit/null/idempotency contract at the real sync RPC boundary.
 *
 * apply_sync_op is the public compare-and-swap seam. Successful creates and updates execute the
 * real _sync_upsert function in the same database transaction; sync_changes is the pull seam.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  settingsProfileFromRow, settingsProfileToRow, type UserSettingsProfileRow,
} from "@/lib/sync/user-settings";

const URL = process.env.SUPABASE_TEST_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ?? "";
const hasBranch = URL.length > 0;
const branchDescribe = hasBranch ? describe : describe.skip;

type SyncResult = Record<string, unknown> & { status: string; rev?: number; seq?: number };
type ProfilePayload = {
  height_unit?: "ft_in" | "cm" | null;
  weight_unit?: "lb" | "kg" | null;
  weight_kg?: number | null;
  activity_level?: "sedentary" | "light" | "moderate" | "active" | "very_active" | null;
  goal?: "lose_fat" | "recomp" | "maintain" | "gain_muscle" | null;
  training_weekdays?: number[] | null;
  diet_prefs?: Record<string, unknown> | null;
  onboarded_at?: string | null;
  cuisines?: unknown;
  country_code?: string | null;
};

let admin: SupabaseClient;
const users: string[] = [];

async function createUser(): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email: `u6-profile-${crypto.randomUUID()}@meal-companion.test`,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("could not create the U6 profile test user");
  users.push(data.user.id);
  return data.user.id;
}

function profileOp(
  kind: "create" | "update",
  baseRev: number | null,
  payload: ProfilePayload,
  opId = crypto.randomUUID(),
) {
  return {
    op_id: opId,
    entity: "user_settings",
    entity_id: "settings",
    kind,
    base_rev: baseRev,
    payload,
    client_ts: new Date().toISOString(),
  };
}

async function apply(userId: string, op: ReturnType<typeof profileOp>): Promise<SyncResult> {
  const { data, error } = await admin.rpc("apply_sync_op", { p_user_id: userId, p_op: op });
  if (error) throw error;
  return data as SyncResult;
}

async function pulledSettings(userId: string): Promise<UserSettingsProfileRow & { rev: number }> {
  const { data, error } = await admin.rpc("sync_changes", {
    p_user_id: userId,
    p_since: 0,
    p_limit: 500,
  });
  if (error) throw error;
  const changes = data as Array<{
    entity: string;
    current: (UserSettingsProfileRow & { rev: number }) | null;
  }>;
  const current = changes.filter((change) => change.entity === "user_settings").at(-1)?.current;
  if (!current) throw new Error("profile sync pull returned no user_settings row");
  return current;
}

branchDescribe(
  hasBranch
    ? "profile sync contract against a Supabase branch"
    : "profile sync contract (skipped: set SUPABASE_TEST_URL to run against a branch)",
  () => {
    beforeAll(() => {
      if (!SERVICE_KEY) {
        throw new Error("profile sync integration needs SUPABASE_TEST_SERVICE_ROLE_KEY");
      }
      admin = createClient(URL, SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    });

    afterAll(async () => {
      await Promise.all(users.map(async (userId) => {
        const { error } = await admin.auth.admin.deleteUser(userId);
        if (error) throw error;
      }));
    });

    it("creates profile fields, preserves omitted values, clears explicit nulls, and pulls camelCase", async () => {
      const userId = await createUser();
      const onboardedAt = "2026-09-19T18:30:00.000Z";
      const created = await apply(userId, profileOp("create", null, {
        height_unit: "cm",
        weight_unit: "kg",
        weight_kg: 67.5,
        activity_level: "active",
        goal: "recomp",
        training_weekdays: [1, 3, 5],
        diet_prefs: { flags: ["gluten_free"], text: "No dairy" },
        onboarded_at: onboardedAt,
      }));
      expect(created).toMatchObject({ status: "applied", rev: 1 });
      const createdSettings = await pulledSettings(userId);
      expect(createdSettings).toMatchObject({
        height_unit: "cm",
        weight_unit: "kg",
        weight_kg: 67.5,
        activity_level: "active",
        goal: "recomp",
        training_weekdays: [1, 3, 5],
        diet_prefs: { flags: ["gluten_free"], text: "No dairy" },
        rev: 1,
      });
      expect(new Date(createdSettings.onboarded_at ?? "").toISOString()).toBe(onboardedAt);

      const omitted = await apply(userId, profileOp("update", 1, {
        activity_level: "moderate",
        goal: "maintain",
        training_weekdays: [1, 3, 5, 6],
        onboarded_at: onboardedAt,
      }));
      expect(omitted).toMatchObject({ status: "applied", rev: 2 });
      const omittedSettings = await pulledSettings(userId);
      expect(omittedSettings).toMatchObject({
        height_unit: "cm",
        weight_unit: "kg",
        weight_kg: 67.5,
        diet_prefs: { flags: ["gluten_free"], text: "No dairy" },
        activity_level: "moderate",
        goal: "maintain",
        training_weekdays: [1, 3, 5, 6],
        rev: 2,
      });
      expect(new Date(omittedSettings.onboarded_at ?? "").toISOString()).toBe(onboardedAt);

      const cleared = await apply(userId, profileOp("update", 2, {
        height_unit: null,
        weight_unit: null,
        weight_kg: null,
        diet_prefs: null,
      }));
      expect(cleared).toMatchObject({ status: "applied", rev: 3 });
      const pulled = await pulledSettings(userId);
      expect(pulled).toMatchObject({
        height_unit: null,
        weight_unit: null,
        weight_kg: null,
        diet_prefs: null,
        rev: 3,
      });
      const profile = settingsProfileFromRow(pulled);
      expect(profile).toMatchObject({
        weightKg: null,
        heightUnit: "ft_in",
        weightUnit: "lb",
        activityLevel: "moderate",
        goal: "maintain",
        trainingWeekdays: [1, 3, 5, 6],
        dietPrefs: null,
      });
      expect(new Date(profile.onboardedAt ?? "").toISOString()).toBe(onboardedAt);
    });

    it("does not re-apply an already accepted op when its retry now has a stale base revision", async () => {
      const userId = await createUser();
      await apply(userId, profileOp("create", null, {
        weight_kg: 65,
        activity_level: "active",
        goal: "recomp",
        training_weekdays: [1, 3, 4, 5],
        diet_prefs: { flags: ["gluten_free"] },
        onboarded_at: "2026-09-19T18:30:00.000Z",
      }));
      const op = profileOp("update", 1, { goal: "maintain" });
      const first = await apply(userId, op);
      expect(first).toMatchObject({ status: "applied", rev: 2 });

      const retry = await apply(userId, op);
      expect(retry).toMatchObject({ status: "duplicate" });
      const stale = await apply(userId, profileOp("update", 1, { goal: "lose_fat" }));
      expect(stale).toMatchObject({
        status: "conflict",
        current_rev: 2,
        current: { goal: "maintain", rev: 2 },
      });
      const pulled = await pulledSettings(userId);
      expect(pulled).toMatchObject({ goal: "maintain", rev: 2 });
      const { data, error } = await admin.rpc("sync_changes", {
        p_user_id: userId,
        p_since: 0,
        p_limit: 500,
      });
      if (error) throw error;
      expect((data as Array<{ entity: string }>).filter((row) => row.entity === "user_settings"))
        .toHaveLength(2);
    });

    it("rejects invalid profile arrays, objects, and display units", async () => {
      const userId = await createUser();
      await apply(userId, profileOp("create", null, {
        weight_kg: 65,
        activity_level: "active",
        goal: "recomp",
        training_weekdays: [1, 3, 5],
        diet_prefs: { flags: [] },
        onboarded_at: "2026-09-19T18:30:00.000Z",
      }));

      const duplicateWeekday = await admin.rpc("apply_sync_op", {
        p_user_id: userId,
        p_op: profileOp("update", 1, { training_weekdays: [1, 1, 3] }),
      });
      expect(duplicateWeekday.data).toBeNull();
      expect(duplicateWeekday.error?.message)
        .toContain("user_settings_training_weekdays_valid_check");

      const nonObjectDietPrefs = await admin.rpc("apply_sync_op", {
        p_user_id: userId,
        p_op: profileOp("update", 1, {
          diet_prefs: ["gluten_free"] as unknown as Record<string, unknown>,
        }),
      });
      expect(nonObjectDietPrefs.data).toBeNull();
      expect(nonObjectDietPrefs.error?.message).toContain("user_settings_diet_prefs_object_check");
      const invalidHeightUnit = await admin.rpc("apply_sync_op", {
        p_user_id: userId,
        p_op: profileOp("update", 1, {
          height_unit: "feet" as "cm",
        }),
      });
      expect(invalidHeightUnit.data).toBeNull();
      expect(invalidHeightUnit.error?.message).toContain("user_settings_height_unit_check");
      expect(await pulledSettings(userId)).toMatchObject({
        training_weekdays: [1, 3, 5],
        diet_prefs: { flags: [] },
        rev: 1,
      });
    });

    // Phase 18 W5 (docs/specs/phase-18-open-world-foods.md §10 W5, acceptance 1 and 2).
    it("W5: creates, updates, omits, clears and round-trips cuisines, country_code and diet_prefs.taste", async () => {
      const userId = await createUser();
      const taste = { dislikes: ["f:okra", "t:slimy"] };
      const bare = await apply(userId, profileOp("create", null, { goal: "maintain" }));
      expect(bare).toMatchObject({ status: "applied", rev: 1 });
      expect(await pulledSettings(userId)).toMatchObject({ cuisines: [], country_code: null, rev: 1 });

      const created = await apply(userId, profileOp("update", 1, {
        cuisines: ["korean", "italian"], country_code: "US",
        diet_prefs: { flags: ["vegetarian"], water: { unit: "ml" }, taste },
      }));
      expect(created).toMatchObject({ status: "applied", rev: 2 });
      expect(await pulledSettings(userId)).toMatchObject({
        cuisines: ["korean", "italian"], country_code: "US",
        diet_prefs: { flags: ["vegetarian"], water: { unit: "ml" }, taste }, rev: 2,
      });

      // Omitted keys keep the stored values.
      await apply(userId, profileOp("update", 2, { goal: "recomp" }));
      expect(await pulledSettings(userId)).toMatchObject({
        goal: "recomp", cuisines: ["korean", "italian"], country_code: "US", diet_prefs: { taste }, rev: 3,
      });

      // An update replaces; order is kept.
      await apply(userId, profileOp("update", 3, { cuisines: ["african", "korean", "caribbean"], country_code: "CA",
        diet_prefs: { flags: ["vegetarian"], taste: { dislikes: ["t:bitter"] } } }));
      expect(await pulledSettings(userId)).toMatchObject({
        cuisines: ["african", "korean", "caribbean"], country_code: "CA",
        diet_prefs: { taste: { dislikes: ["t:bitter"] } }, rev: 4,
      });

      // Round trip through the phone mapping: pull, map, push, pull is the same row.
      const before = await pulledSettings(userId);
      const roundTrip = settingsProfileToRow(settingsProfileFromRow(before));
      await apply(userId, profileOp("update", 4, {
        cuisines: roundTrip.cuisines, country_code: roundTrip.country_code,
        diet_prefs: roundTrip.diet_prefs as Record<string, unknown>,
      }));
      const after = await pulledSettings(userId);
      expect({ cuisines: after.cuisines, country_code: after.country_code, diet_prefs: after.diet_prefs })
        .toEqual({ cuisines: before.cuisines, country_code: before.country_code, diet_prefs: before.diet_prefs });

      // Null clears the country; [] clears cuisines; a null diet_prefs clears taste with it.
      await apply(userId, profileOp("update", 5, { cuisines: [], country_code: null, diet_prefs: null }));
      const cleared = await pulledSettings(userId);
      expect(cleared).toMatchObject({ cuisines: [], country_code: null, diet_prefs: null, rev: 6 });
      expect(settingsProfileFromRow(cleared)).toMatchObject({ cuisines: [], countryCode: null, dietPrefs: null });
    });

    it("W5: a pre-W5 diet_prefs (no taste key) keeps the stored taste; an explicit taste replaces it", async () => {
      const userId = await createUser();
      const taste = { dislikes: ["f:okra", "t:slimy"] };
      await apply(userId, profileOp("create", null, { diet_prefs: { flags: ["vegetarian"], taste } }));
      // The origin/main mapper rebuilds diet_prefs from flags, text, lifestyle and water only.
      const preW5 = { flags: ["vegan"], text: "No eggs", lifestyle: { cookingEffort: "minimal" }, water: { unit: "ml" } };
      expect(await apply(userId, profileOp("update", 1, { diet_prefs: preW5 }))).toMatchObject({ status: "applied", rev: 2 });
      expect((await pulledSettings(userId)).diet_prefs).toEqual({ ...preW5, taste });

      const replaced = { dislikes: ["t:bitter"] };
      await apply(userId, profileOp("update", 2, { diet_prefs: { ...preW5, taste: replaced } }));
      expect((await pulledSettings(userId)).diet_prefs).toEqual({ ...preW5, taste: replaced });

      // An explicit empty taste clears the dislikes; it is not filled from the stored value.
      await apply(userId, profileOp("update", 3, { diet_prefs: { ...preW5, taste: {} } }));
      expect((await pulledSettings(userId)).diet_prefs).toEqual({ ...preW5, taste: {} });

      // A null diet_prefs still clears the whole object, taste included; a later pre-W5 save adds none.
      await apply(userId, profileOp("update", 4, { diet_prefs: null }));
      await apply(userId, profileOp("update", 5, { diet_prefs: preW5 }));
      expect((await pulledSettings(userId)).diet_prefs).toEqual(preW5);
    });

    it("W5: refuses invalid cuisines, country codes and taste, through the RPC and directly", async () => {
      const userId = await createUser();
      await apply(userId, profileOp("create", null, { cuisines: ["japanese"], country_code: "US",
        diet_prefs: { flags: [], taste: { dislikes: ["f:okra"] } } }));
      const refused = async (payload: ProfilePayload, message: string) => {
        const result = await admin.rpc("apply_sync_op", { p_user_id: userId, p_op: profileOp("update", 1, payload) });
        expect(result.data).toBeNull();
        expect(result.error?.message).toContain(message);
      };
      const seven = ["american", "latin_american", "italian", "mediterranean", "south_asian", "chinese", "japanese"];
      await refused({ cuisines: seven }, "user_settings_cuisines_valid");
      await refused({ cuisines: ["korean", "korean"] }, "user_settings_cuisines_valid");
      await refused({ cuisines: ["klingon"] }, "user_settings_cuisines_valid");
      await refused({ cuisines: ["Korean"] }, "user_settings_cuisines_valid");
      await refused({ cuisines: [null] }, "user_settings_cuisines_valid");
      await refused({ cuisines: null }, "cuisines_null");
      await refused({ cuisines: "korean" }, "cannot extract elements from a scalar");
      await refused({ country_code: "us" }, "user_settings_country_code_check");
      await refused({ country_code: "USA" }, "user_settings_country_code_check");
      const taste = (value: unknown) => ({ diet_prefs: { flags: [], taste: value } });
      await refused(taste(null), "user_settings_diet_prefs_taste_check");
      await refused(taste({ dislikes: ["okra"] }), "user_settings_diet_prefs_taste_check");
      await refused(taste({ dislikes: [7] }), "user_settings_diet_prefs_taste_check");
      await refused(taste({ dislikes: "f:okra" }), "user_settings_diet_prefs_taste_check");
      await refused(taste({ dislikes: [], likes: ["f:kale"] }), "user_settings_diet_prefs_taste_check");
      await refused(taste({ dislikes: Array.from({ length: 51 }, (_, i) => `f:food ${i}`) }),
        "user_settings_diet_prefs_taste_check");
      // The checks hold for a direct write too, not only the sync RPC.
      const direct = await admin.from("user_settings").update({ cuisines: seven }).eq("user_id", userId);
      expect(direct.error?.message).toContain("user_settings_cuisines_valid");
      const directNull = await admin.from("user_settings").update({ cuisines: null }).eq("user_id", userId);
      expect(directNull.error?.message).toMatch(/null value in column "cuisines"|user_settings_cuisines_valid/);
      // A non-canonical family is a valid stored key: the database takes "f:Okra" and the phone
      // keeps it unchanged on read (only new client writes require the canonical form).
      const okra = await apply(userId, profileOp("update", 1, { diet_prefs: { flags: [], taste: { dislikes: ["f:Okra"] } } }));
      expect(okra).toMatchObject({ status: "applied", rev: 2 });
      const okraRow = await pulledSettings(userId);
      expect(settingsProfileFromRow(okraRow).dietPrefs?.taste).toEqual({ dislikes: ["f:Okra"] });
      expect(settingsProfileToRow(settingsProfileFromRow(okraRow)).diet_prefs?.taste).toEqual({ dislikes: ["f:Okra"] });
      // Six distinct cuisines and 50 dislikes are accepted.
      const fifty = Array.from({ length: 50 }, (_, i) => `f:food ${i}`);
      const six = await apply(userId, profileOp("update", 2, { cuisines: seven.slice(0, 6),
        diet_prefs: { flags: [], taste: { dislikes: fifty } } }));
      expect(six).toMatchObject({ status: "applied", rev: 3 });
      expect(await pulledSettings(userId)).toMatchObject({ cuisines: seven.slice(0, 6), country_code: "US",
        diet_prefs: { taste: { dislikes: fifty } }, rev: 3 });
    });
  },
);
