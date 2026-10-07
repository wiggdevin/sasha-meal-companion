import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "@/app/api/recipes/route";
import { seedPilotCatalog } from "@/lib/server/recipe-catalog-seed";
import { loadRecipeCandidates } from "@/lib/server/recipe-candidates";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import { HAS_BRANCH, adminClient, userClient, type TestUser } from "../helpers/supabase";

const fullWish = "can you please search for amazing stew recipes that I can eat for dinner";

describe.skipIf(!HAS_BRANCH)("authenticated recipe search HTTP boundary", () => {
  let user: TestUser;
  let client: SupabaseClient;
  let cookie = "";
  const old = { url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    access: process.env.RECIPE_PLANNING_USER_IDS };

  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_TEST_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_TEST_ANON_KEY;
    const password = `test-${crypto.randomUUID()}`;
    const created = await adminClient().auth.admin.createUser({
      email: `recipe-search-${crypto.randomUUID()}@meal-companion.test`,
      password, email_confirm: true,
    });
    if (created.error || !created.data.user) throw created.error ?? new Error("Test user missing");
    user = { id: created.data.user.id, email: created.data.user.email!, password };
    process.env.RECIPE_PLANNING_USER_IDS = user.id;
    client = await userClient(user);
    await seedPilotCatalog(adminClient());
    const { data } = await client.auth.getSession();
    if (!data.session) throw new Error("Test session missing");
    const seed = new Request("https://app.test/seed");
    await createRequestClient(seed).auth.setSession({
      access_token: data.session.access_token, refresh_token: data.session.refresh_token,
    });
    cookie = cookieJar(seed).map((entry) =>
      `${entry.name}=${encodeURIComponent(entry.value)}`).join("; ");
  });

  afterAll(async () => {
    if (user?.id) await adminClient().auth.admin.deleteUser(user.id);
    for (const [key, value] of Object.entries({
      NEXT_PUBLIC_SUPABASE_URL: old.url,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: old.key,
      RECIPE_PLANNING_USER_IDS: old.access,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function request(query: string): Request {
    return new Request(`https://app.test/api/recipes?${query}`, {
      headers: { cookie, "x-smc-account": user.id },
    });
  }

  it("finds a real eligible stew through service and public HTTP from the full sentence", async () => {
    const candidates = await loadRecipeCandidates(client, user.id, { query: fullWish, limit: 3 });
    expect(candidates.candidates.length).toBeGreaterThan(0);
    // Round 3: words rank, so the stews lead rather than being the only rows.
    expect(candidates.candidates[0].dishTags).toContain("stew");
    expect(candidates.exactMatch).toBe(true);
    const response = await GET(request(new URLSearchParams({ q: fullWish }).toString()));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.recipes[0].dishTags).toContain("stew");
    expect(body.exactMatch).toBe(true);
  });

  it("honors explicit cuisine, time and effort, ranks words, and refuses one-off exclusions", async () => {
    const filtered = await GET(request(new URLSearchParams({ q: fullWish,
      cuisine: "Mediterranean", maxMinutes: "30" }).toString()));
    expect(filtered.status).toBe(200);
    expect((await filtered.json()).recipes[0].name).toBe("Chickpea and spinach stew");
    const inferred = await GET(request(new URLSearchParams({
      q: "Find a Mediterranean stew for dinner under 30 minutes",
    }).toString()));
    expect(inferred.status).toBe(200);
    expect((await inferred.json()).recipes[0].name).toBe("Chickpea and spinach stew");
    const noCook = await GET(request(new URLSearchParams({ q: fullWish,
      effort: "none" }).toString()));
    expect(noCook.status).toBe(200);
    // No no-cook stew exists: the effort filter holds, and the closest no-cook recipes come back
    // flagged as no exact match.
    const noCookBody = await noCook.json();
    expect(noCookBody.recipes.every((row: { effort: string }) => row.effort === "none")).toBe(true);
    expect(noCookBody.exactMatch).toBe(false);
    // A word no recipe carries never empties a search.
    const unknown = await GET(request(new URLSearchParams({ q: "zxqnotfood recipe" }).toString()));
    expect(unknown.status).toBe(200);
    const everything = await GET(request(new URLSearchParams({ q: "" }).toString()));
    const unknownBody = await unknown.json();
    expect(unknownBody.count).toBe((await everything.json()).count);
    expect(unknownBody.exactMatch).toBe(false);
    const exclusion = await GET(request(new URLSearchParams({ q: "stew without onions" }).toString()));
    expect(exclusion.status).toBe(422);
    expect((await exclusion.json()).error).toBe("unsupported_exclusion");
  });

  it("matches a cuisine family and answers a cuisine with no eligible recipe as an empty 200", async () => {
    const italian = await GET(request(new URLSearchParams({ q: "", cuisine: "Italian",
      limit: "10" }).toString()));
    expect(italian.status).toBe(200);
    const italianBody = await italian.json();
    expect(italianBody.recipes.map((row: { name: string }) => row.name))
      .toContain("Tomato and red pepper pasta");
    expect(italianBody.recipes.every((row: { cuisine: string }) => /italian/i.test(row.cuisine)))
      .toBe(true);
    const chinese = await GET(request(new URLSearchParams({ q: "", cuisine: "Chinese" }).toString()));
    expect(chinese.status).toBe(200);
    const chineseBody = await chinese.json();
    expect(chineseBody).toMatchObject({ recipes: [], count: 0 });
    expect(chineseBody.error).toBeUndefined();
    expect(JSON.stringify(chineseBody)).not.toContain("cannot_match_any_requests");
  });
});
