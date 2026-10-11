import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTestUsers, HAS_BRANCH } from "@/tests/helpers/supabase";
import { pointRequestClientAtBranch, seedCatalogFood, sessionCookieFor, uuid }
  from "@/tests/log/fixtures";
import { proposeDraft } from "@/lib/server/capture";
import { applyLogEntry } from "@/lib/server/log";
import { GET as sweep } from "@/app/api/jobs/media-sweep/route";

const runCapture = vi.fn(async () => ({
  items: [{ label: "Egg, whole, raw", grams: 100, qty: 2, unit: "whole", confidence: 0.8 }],
  notes: [] }));

describe.skipIf(!HAS_BRANCH)("propose to commit [needs branch]", () => {
  beforeAll(() => { pointRequestClientAtBranch(); vi.stubEnv("CAPTURE_METHODS", "text"); });

  it("writes one entry and N items with server-computed snapshots, and a second commit changes nothing", async () => {
    const { a, admin } = await createTestUsers();
    const food = await seedCatalogFood(admin, a.userId, {
      sourceId: "egg-1", description: "Egg, whole, raw",
      per100g: { energy_kcal: 143, protein: 12.6, fat_total: 9.5 } });
    const entries = async () => (await admin.from("log_entries")
      .select("id", { count: "exact", head: true }).eq("user_id", a.userId)).count ?? 0;
    const before = await entries();
    const draft = await proposeDraft(a.client, admin, a.userId,
      { method: "text", localDate: "2026-09-11", tz: "UTC", slot: "meal-1", text: "two eggs" },
      { runCapture: runCapture as never });
    expect(draft.items).toHaveLength(1);
    expect(draft.draftId).toBeTruthy();
    expect(await entries()).toBe(before);

    const entryId = uuid(901);
    const request = {
      entry_id: entryId, eaten_at: "2026-09-11T12:00:00.000Z", tz: "UTC",
      local_date: "2026-09-11", slot: "meal-1", method: "text",
      items: [{ id: uuid(902), seq: 0, food_ref_id: food.foodRefId, qty: 2, unit: "whole",
        grams: 100 }],
    };
    const first = await applyLogEntry(a.client, a.userId, request, { admin });
    expect(first.status).toBe("ok");
    expect(first.status === "ok" && first.items[0].snapshot.protein.amount).toBeCloseTo(12.6, 3);

    const again = await applyLogEntry(a.client, a.userId, request, { admin });
    expect(again.status === "ok" && again.rev).toBe(first.status === "ok" && first.rev);
    const rows = await admin.from("log_items").select("id").eq("entry_id", entryId);
    expect(rows.data).toHaveLength(1);
  });

  it("ignores client macros: a tampered payload stores the catalog values", async () => {
    const { a, admin } = await createTestUsers();
    const food = await seedCatalogFood(admin, a.userId, {
      sourceId: "rice-1", description: "Rice, white, cooked", per100g: { energy_kcal: 130 } });
    const entryId = uuid(903);
    const out = await applyLogEntry(a.client, a.userId, {
      entry_id: entryId, eaten_at: "2026-09-11T12:00:00.000Z", tz: "UTC",
      local_date: "2026-09-11", slot: "meal-2", method: "text",
      items: [{ id: uuid(904), seq: 0, food_ref_id: food.foodRefId, qty: 1, unit: "cup",
        grams: 100, snapshot: { energy_kcal: { amount: 1 } } }],
    }, { admin });
    expect(out.status === "ok" && out.items[0].snapshot.energy_kcal.amount).toBe(130);
  });

  it("sweeps a 25-hour-old object and keeps a 23-hour-old one", async () => {
    const { a, admin } = await createTestUsers();
    vi.stubEnv("CRON_SECRET", "s3cret");
    const old = `media/${a.userId}/${uuid(905)}.jpg`;
    const fresh = `media/${a.userId}/${uuid(906)}.jpg`;
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    await admin.from("media_objects").delete().in("path", [old, fresh]);
    await admin.from("media_objects").insert([
      { path: old, user_id: a.userId, kind: "image", bytes: 1, created_at: hoursAgo(25) },
      { path: fresh, user_id: a.userId, kind: "image", bytes: 1, created_at: hoursAgo(23) },
    ]);
    const res = await sweep(new Request("https://a.test/api/jobs/media-sweep",
      { headers: { authorization: "Bearer s3cret" } }));
    expect(res.status).toBe(200);
    const rows = await admin.from("media_objects").select("path, deleted_at")
      .in("path", [old, fresh]);
    const byPath = new Map((rows.data ?? []).map((r) => [r.path as string, r.deleted_at]));
    expect(byPath.get(old)).not.toBeNull();
    expect(byPath.get(fresh)).toBeNull();
    await admin.from("media_objects").delete().in("path", [old, fresh]);
  });

  it("denies another user's media_objects row over the request client", async () => {
    const { a, b, admin } = await createTestUsers();
    const path = `media/${a.userId}/${uuid(907)}.jpg`;
    await admin.from("media_objects").delete().eq("path", path);
    await admin.from("media_objects")
      .insert({ path, user_id: a.userId, kind: "image", bytes: 1 });
    const seen = await b.client.from("media_objects").select("path").eq("path", path);
    expect(seen.data).toEqual([]);
    const cookie = await sessionCookieFor(b.client);
    expect(cookie.length).toBeGreaterThan(0);
    await admin.from("media_objects").delete().eq("path", path);
  });

  it("enforces the media bucket's upload policy: only a server-signed URL writes", async () => {
    const { a, b, admin } = await createTestUsers();
    const bytes = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    const foreignKey = `${a.userId}/${uuid(908)}.jpg`;
    const ownKey = `${a.userId}/${uuid(909)}.jpg`;
    const denied = await b.client.storage.from("media").upload(foreignKey, bytes);
    expect(denied.error).not.toBeNull();
    // W019 (A055): no direct upload with the user's own JWT, even into her own folder.
    const direct = await a.client.storage.from("media").upload(ownKey, bytes);
    expect(direct.error).not.toBeNull();
    const signed = await admin.storage.from("media").createSignedUploadUrl(ownKey);
    expect(signed.error).toBeNull();
    const allowed = await a.client.storage.from("media")
      .uploadToSignedUrl(ownKey, signed.data!.token, bytes);
    expect(allowed.error).toBeNull();
    await admin.storage.from("media").remove([foreignKey, ownKey]);
    await admin.from("media_objects").delete().in("path", [`media/${foreignKey}`, `media/${ownKey}`]);
  });
});
