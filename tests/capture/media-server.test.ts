import { describe, expect, it, vi } from "vitest";
import { deleteMedia, draftIdFromPath, fetchOwnedObject, signUpload } from "@/lib/server/media";

function fakeStorage(overrides: Record<string, unknown> = {}) {
  const rows: Record<string, unknown>[] = [];
  const bucket = {
    createSignedUploadUrl: vi.fn().mockResolvedValue({
      data: { signedUrl: "https://s.test/upload?token=t", path: "u1/x.jpg" }, error: null }),
    download: vi.fn().mockResolvedValue({
      data: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), error: null }),
    remove: vi.fn().mockResolvedValue({ error: null }),
    ...overrides,
  };
  const table = {
    insert: vi.fn(async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; }),
    update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
  };
  return { rows, bucket, client: { storage: { from: () => bucket }, from: () => table } };
}

describe("signUpload", () => {
  it("mints a path under the caller's uid and records the declared bytes", async () => {
    const { client, rows, bucket } = fakeStorage();
    const out = await signUpload(client as never, "u1",
      { kind: "image", contentType: "image/jpeg", bytes: 400_000 });
    expect(out.path).toMatch(/^media\/u1\/[0-9a-f-]{36}\.jpg$/);
    expect(out.expiresInSeconds).toBe(60);
    expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(out.path.replace("media/", ""));
    expect(rows[0]).toMatchObject({ user_id: "u1", kind: "image", bytes: 400_000, path: out.path });
  });

  it("413s on a declared size over the bucket limit", async () => {
    const { client } = fakeStorage();
    await expect(signUpload(client as never, "u1",
      { kind: "image", contentType: "image/jpeg", bytes: 9_000_000 }))
      .rejects.toMatchObject({ status: 413, code: "too_large" });
  });

  it("415s on a content type the bucket does not allow", async () => {
    const { client } = fakeStorage();
    await expect(signUpload(client as never, "u1",
      { kind: "image", contentType: "image/heic", bytes: 10 }))
      .rejects.toMatchObject({ status: 415, code: "unsupported_media" });
  });

  it("records the row before minting the URL, and tombstones it when signing fails", async () => {
    const { rows, client } = fakeStorage({
      createSignedUploadUrl: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) });
    const table = (client.from() as { update: ReturnType<typeof vi.fn> }).update;
    await expect(signUpload(client as never, "u1",
      { kind: "image", contentType: "image/jpeg", bytes: 400_000 }))
      .rejects.toMatchObject({ status: 500, code: "internal" });
    expect(rows).toHaveLength(1);
    expect(table).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_at: expect.any(String) }));
  });
});

describe("fetchOwnedObject", () => {
  it("403s on another uid and downloads nothing", async () => {
    const { client, bucket } = fakeStorage();
    await expect(fetchOwnedObject(client as never, "u1", "media/u2/a.jpg"))
      .rejects.toMatchObject({ status: 403, code: "media_not_owned" });
    expect(bucket.download).not.toHaveBeenCalled();
  });

  it("downloads the caller's own object by its bucket key", async () => {
    const { client, bucket } = fakeStorage();
    const out = await fetchOwnedObject(client as never, "u1", "media/u1/a.jpg");
    expect(bucket.download).toHaveBeenCalledWith("u1/a.jpg");
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
    expect(out.mimeType).toBe("image/jpeg");
  });

  it("404s when the object is gone", async () => {
    const { client } = fakeStorage({
      download: vi.fn().mockResolvedValue({ data: null, error: { message: "not found" } }) });
    await expect(fetchOwnedObject(client as never, "u1", "media/u1/a.jpg"))
      .rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("deleteMedia and draftIdFromPath", () => {
  it("removes the object and tombstones the row", async () => {
    const { client, bucket } = fakeStorage();
    await deleteMedia(client as never, "media/u1/a.jpg");
    expect(bucket.remove).toHaveBeenCalledWith(["u1/a.jpg"]);
  });

  it("a failed Storage removal throws and leaves the row live for the sweep to retry (S3)",
    async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { client } = fakeStorage({ remove: vi.fn().mockResolvedValue({
        error: { message: "storage 503" } }) });
      const table = (client as unknown as { from: () => { update: ReturnType<typeof vi.fn> } }).from();
      await expect(deleteMedia(client as never, "media/u1/a.jpg")).rejects.toThrow(/delete failed/);
      expect(table.update).not.toHaveBeenCalled();
      spy.mockRestore();
    });

  it("logs, but does not throw, when the tombstone update fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bucket } = fakeStorage();
    const table = {
      insert: vi.fn(),
      update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: { message: "boom" } })) })),
    };
    const client = { storage: { from: () => bucket }, from: () => table };
    await expect(deleteMedia(client as never, "media/u1/a.jpg")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("reads the uuid out of a media path", () => {
    expect(draftIdFromPath("media/u1/11111111-1111-4111-8111-111111111111.m4a"))
      .toBe("11111111-1111-4111-8111-111111111111");
    expect(draftIdFromPath("media/u1/not-a-uuid.jpg")).toBeNull();
  });
});
