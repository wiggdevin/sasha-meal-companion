import { describe, expect, it } from "vitest";
import { adminClient, createTestUsers } from "@/tests/helpers/supabase";
import { HAS_BRANCH } from "@/tests/helpers/supabase";

describe.skipIf(!HAS_BRANCH)("media_objects [needs branch]", () => {
  it("is private to its owner and carries the 8 MB bucket limit", async () => {
    const { a, b } = await createTestUsers();
    const path = `media/${a.userId}/11111111-1111-4111-8111-111111111111.jpg`;
    const admin = adminClient();
    await admin.from("media_objects").delete().eq("path", path);
    const insert = await a.client.from("media_objects")
      .insert({ path, user_id: a.userId, kind: "image", bytes: 1234 });
    expect(insert.error).toBeNull();

    const mine = await a.client.from("media_objects").select("path").eq("path", path);
    expect(mine.data).toHaveLength(1);
    const theirs = await b.client.from("media_objects").select("path").eq("path", path);
    expect(theirs.data).toEqual([]);
    const steal = await b.client.from("media_objects").update({ bytes: 1 }).eq("path", path)
      .select("path");
    expect(steal.data ?? []).toEqual([]);

    const bucket = await admin.storage.getBucket("media");
    expect(bucket.error).toBeNull();
    expect(bucket.data?.file_size_limit).toBe(8388608);
    expect(bucket.data?.public).toBe(false);
    await admin.from("media_objects").delete().eq("path", path);
  });

  it("refuses a kind outside image|audio", async () => {
    const { a } = await createTestUsers();
    const { error } = await a.client.from("media_objects").insert({
      path: `media/${a.userId}/22222222-2222-4222-8222-222222222222.bin`,
      user_id: a.userId, kind: "video", bytes: 1,
    });
    expect(error?.code).toBe("23514");
  });
});
