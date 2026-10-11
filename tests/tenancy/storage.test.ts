/**
 * Spec 3.3 (Phase 9 slice 3): the `media` bucket policies keep user A out of user B's folder.
 * W019 (audit 2026-10-10 A055, migration 20261230091900): a signed-in user can read and delete in
 * her own folder but never write there directly; every upload goes through the server-signed URL
 * (`signUpload`), which records its media_objects row first.
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

  it("A cannot upload to her own folder directly: no row, no sweep, no sign limit (A055)", async () => {
    const own = `${aFolder}/canary-${crypto.randomUUID()}.jpg`;
    const { error } = await (await bucketAsA()).upload(own, jpeg(JPEG), OPTS);
    expect(error).not.toBeNull();
    expect((await adminClient().storage.from("media").download(own)).data).toBeNull();
  });

  it("A can still upload through a server-signed URL and read her own object (control)", async () => {
    const own = `${aFolder}/${crypto.randomUUID()}.jpg`;
    const signed = await adminClient().storage.from("media").createSignedUploadUrl(own);
    expect(signed.error).toBeNull();
    const put = await (await bucketAsA()).uploadToSignedUrl(own, signed.data!.token, jpeg(JPEG), OPTS);
    expect(put.error).toBeNull();
    const read = await (await bucketAsA()).download(own);
    expect(read.error).toBeNull();
    expect(new Uint8Array(await read.data!.arrayBuffer())).toEqual(JPEG);
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
