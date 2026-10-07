/**
 * Spec 3.3 (Phase 9 slice 3): the `media` bucket policy (`media_own_folder`,
 * supabase/migrations/20260920090100_phase4_media_bucket.sql) keeps user A out of user B's folder.
 */
// Refuses any non-local database before anything else runs (review r8).
import "./local-only";
import { beforeAll, describe, expect, it } from "vitest";
import { HAS_BRANCH, adminClient, ensureUser, userClient } from "../helpers/supabase";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const jpeg = (bytes: Uint8Array<ArrayBuffer>) => new Blob([bytes], { type: "image/jpeg" });
const OPTS = { contentType: "image/jpeg" };

describe.skipIf(!HAS_BRANCH)("media bucket (spec 3.3)", () => {
  let aFolder = "";
  let folder = "";
  let path = "";

  beforeAll(async () => {
    const [a, b] = await Promise.all([ensureUser("a"), ensureUser("b")]);
    aFolder = a.id;
    folder = b.id;
    path = `${folder}/canary-${crypto.randomUUID()}.jpg`;
    const { error } = await adminClient().storage.from("media").upload(path, jpeg(JPEG), OPTS);
    expect(error).toBeNull();
  });

  const bucketAsA = async () => (await userClient(await ensureUser("a"))).storage.from("media");

  it("A can write to her own folder (control)", async () => {
    const own = `${aFolder}/canary-${crypto.randomUUID()}.jpg`;
    const { error } = await (await bucketAsA()).upload(own, jpeg(JPEG), OPTS);
    expect(error).toBeNull();
  });

  it("A cannot download, list, overwrite or delete B's object", async () => {
    const bucket = await bucketAsA();
    expect((await bucket.download(path)).data).toBeNull();
    expect((await bucket.list(folder)).data ?? []).toEqual([]);
    const overwrite = await bucket.upload(path, jpeg(new Uint8Array([1, 2, 3])),
      { ...OPTS, upsert: true });
    expect(overwrite.error).not.toBeNull();
    await bucket.remove([path]);

    const still = await adminClient().storage.from("media").download(path);
    expect(still.error).toBeNull();
    expect(new Uint8Array(await still.data!.arrayBuffer())).toEqual(JPEG);
  });

  it("A cannot create a new object in B's folder", async () => {
    const planted = `${folder}/canary-${crypto.randomUUID()}.jpg`;
    const { error } = await (await bucketAsA()).upload(planted, jpeg(JPEG), OPTS);
    expect(error).not.toBeNull();
    expect((await adminClient().storage.from("media").download(planted)).data).toBeNull();
  });
});
