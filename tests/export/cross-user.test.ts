/**
 * Acceptance criterion 4's "route and export" half for /api/export, at the HTTP
 * layer. Lane A's tests/rls/cross-user.test.ts proves table and RPC denial; it
 * never calls a route. This calls the real handler with user B's session while
 * user A holds meal rows, and asserts B sees none of them.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createChunks, stringToBase64URL } from "@supabase/ssr";
import { createTestUsers, HAS_BRANCH, resetUser } from "../helpers/supabase";
import { accountHeaderFromCookie } from "@/tests/helpers/account-header";
import type { NutrientCode } from "@/lib/nutrients/codes";

// Phase 2 (Task 15) has route.ts reach lib/server/export.ts, which imports "server-only" (see
// tests/log/commit.test.ts for the precedent). Only the marker package is stubbed, never the
// module itself; the assertions below are otherwise Phase 0's, unchanged.
vi.mock("server-only", () => ({}));

const { GET } = await import("../../app/api/export/route");
const { flattenMeals } = await import("@/lib/server/export-meals");
const { computeSnapshot } = await import("@/lib/nutrients/snapshot");

const run = HAS_BRANCH ? describe : describe.skip;

describe("flattenMeals", () => {
  const value = (amount: number | null, unit: string) =>
    ({ amount, unit, basis: "per_100g", source: "usda", source_version: "1", revision_id: 1 });
  const per100 = (over: Partial<Record<NutrientCode, number | null>>) =>
    over as Record<NutrientCode, number | null>;

  it("reads each macro column from the snapshot's nutrient code", () => {
    const rows = flattenMeals([
      {
        id: "e1", tz: "America/Los_Angeles",
        log_items: [
          {
            seq: 1, qty: 1, unit: "cup", grams: 240, food_ref_id: "f1",
            snapshot: {
              energy_kcal: value(120, "kcal"),
              protein: value(8, "g"),
              carbohydrate: value(12, "g"),
              fat_total: value(null, "g"),
            },
          },
        ],
      },
    ]);

    expect(rows).toEqual([
      {
        id: "e1", tz: "America/Los_Angeles",
        seq: 1, qty: 1, unit: "cup", grams: 240, food_ref_id: "f1",
        energy_kcal: 120, protein_g: 8, carbohydrate_g: 12, fat_g: null,
      },
    ]);
  });

  it("fills the macro columns from a snapshot computeSnapshot produced, and keeps unknown null", () => {
    const snapshot = computeSnapshot(
      per100({ energy_kcal: 165, protein: 31, carbohydrate: 0, fat_total: 3.6, fiber_total: null }),
      150,
      { source: "usda", source_version: "sr28", revision_id: 7 },
    );
    const [row] = flattenMeals([
      { id: "e2", tz: "UTC", log_items: [{ seq: 1, grams: 150, snapshot }] },
    ]);

    expect(row).toMatchObject({ energy_kcal: 247.5, protein_g: 46.5, carbohydrate_g: 0, fat_g: 5.4 });
    // A measured zero stays 0; a nutrient the source never measured stays null, never 0.
    const [missing] = flattenMeals([
      { id: "e3", tz: "UTC", log_items: [{ seq: 1, grams: 100,
        snapshot: computeSnapshot(per100({ energy_kcal: 50, protein: null }), 100,
          { source: "usda", source_version: "sr28", revision_id: 7 }) }] },
    ]);
    expect(missing).toMatchObject({ energy_kcal: 50, protein_g: null, carbohydrate_g: null, fat_g: null });
  });
});

/**
 * Lane B's createRequestClient reads the session from the `Cookie:` header only
 * (lib/supabase/server.ts, parseCookieHeader) — a Bearer header is never looked
 * at. So the session is sent exactly the way @supabase/ssr's createServerClient
 * writes it: storage key `sb-<project-ref>-auth-token`, value `base64-` plus the
 * base64url of the stored session JSON, split with the package's own createChunks.
 */
function projectRef(): string {
  return new URL(process.env.SUPABASE_TEST_URL ?? "https://ref.supabase.co").hostname.split(".")[0];
}

function sessionCookieHeader(session: unknown): string {
  const key = `sb-${projectRef()}-auth-token`;
  const value = `base64-${stringToBase64URL(JSON.stringify(session))}`;
  return createChunks(key, value)
    .map((chunk) => `${chunk.name}=${encodeURIComponent(chunk.value)}`)
    .join("; ");
}

function request(kind: string, cookie?: string): Request {
  return new Request(`https://app.test/api/export?kind=${kind}&format=json`, {
    headers: cookie ? { cookie, ...accountHeaderFromCookie(cookie) } : {},
  });
}

run("GET /api/export cross-user denial", () => {
  let aCookie = "";
  let bCookie = "";

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_TEST_ANON_KEY;

    const { a, b, admin } = await createTestUsers();
    await resetUser(a.userId);
    await resetUser(b.userId);

    const settings = await admin.from("user_settings").upsert({
      user_id: a.userId,
      first_opened_at: "2026-09-01T00:00:00.000Z",
      height_cm: 165,
      birth_year: 1996,
      sex: "female",
      body_fat_pct: 25,
    }).select("user_id").single();
    expect(settings.error).toBeNull();

    // A meal row of user A's that user B must never see.
    const entry = await admin
      .from("log_entries")
      .insert({ id: randomUUID(), user_id: a.userId, local_date: "2026-09-11", tz: "America/Los_Angeles",
        eaten_at: "2026-09-11T18:00:00Z", slot: "meal-2", method: "search" })
      .select("id").single();
    expect(entry.error).toBeNull();

    /* Third round, finding 5: `body-data` reads raw samples, so this case is only meaningful with a
       sample of A's actually there. A source row first — health_samples.source_id is not nullable. */
    const source = await admin
      .from("health_sources")
      .insert({ id: randomUUID(), user_id: a.userId, kind: "manual", device_label: "Withings" })
      .select("id").single();
    expect(source.error).toBeNull();

    const sample = await admin
      .from("health_samples")
      .insert({ id: randomUUID(), user_id: a.userId, source_id: source.data?.id,
        type: "body_mass", value: 57.6, unit: "kg", start_time: "2026-09-11T11:12:00Z",
        end_time: "2026-09-11T11:12:00Z", tz: "America/Los_Angeles", device_label: "Withings" })
      .select("id").single();
    expect(sample.error).toBeNull();

    const sessionA = await a.client.auth.getSession();
    expect(sessionA.data.session).not.toBeNull();
    aCookie = sessionCookieHeader(sessionA.data.session);

    const session = await b.client.auth.getSession();
    expect(session.data.session).not.toBeNull();
    bCookie = sessionCookieHeader(session.data.session);
  });

  it("401s with no session at all", async () => {
    const res = await GET(request("meals"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  // T11b (Sol audit finding 4, tightened by finding 5): the daily roll-up is RLS-scoped like every
  // other kind. A's own export must contain the day — otherwise B's empty page proves nothing — and
  // B's must contain none of it, because both the sample read and the roll-up run as the caller.
  it("401s the body-data kind with no session, and hands B none of A's days", async () => {
    expect((await GET(request("body-data"))).status).toBe(401);

    const mine = await GET(request("body-data", aCookie));
    expect(mine.status).toBe(200);
    await expect(mine.json()).resolves.toMatchObject({ rows: [{ local_date: "2026-09-11",
      steps: null, body_mass_kg: 57.6 }] });

    const res = await GET(request("body-data", bCookie));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ rows: [] });
  });

  it("401s the body-profile kind with no session, and hands B none of A's fields", async () => {
    expect((await GET(request("body-profile"))).status).toBe(401);

    const mine = await GET(request("body-profile", aCookie));
    expect(mine.status).toBe(200);
    await expect(mine.json()).resolves.toMatchObject({ rows: [{
      height_cm: 165,
      birth_year: 1996,
      sex: "female",
      body_fat_pct: 25,
    }] });

    const res = await GET(request("body-profile", bCookie));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ rows: [] });
  });

  it("returns zero of user A's meal rows to user B", async () => {
    const res = await GET(request("meals", bCookie));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ rows: [] });
  });
});
