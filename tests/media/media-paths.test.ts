/**
 * W019 (audit 2026-10-10 F20: A115, A099, A136, P10): every media read is bound to the caller's
 * own `media/<uid>/<uuid>.<ext>` path before a byte is downloaded with the service role, and the
 * sign route reports the upload token's real lifetime.
 *
 * A traversal key (`media/<mine>/../<theirs>/<uuid>.jpg`) passes a first-segment check, and fetch
 * normalises the dot segments in the Storage URL, so it would download another account's object.
 */
import { describe, expect, it, vi } from "vitest";
import { transcribeRequestSchema } from "@/lib/server/coach-transcribe";
import {
  fetchOwnedObject, ownedObjectKey, signedUploadSeconds, signUpload, SIGNED_UPLOAD_MAX_SECONDS,
} from "@/lib/server/media";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const FILE = "3f1b1a2c-0000-4000-8000-000000000030";
const OWN = `media/${A}/${FILE}.jpg`;

/** Every shape a caller could send that is not exactly one of A's own media objects. */
const NOT_OWN = [
  `media/${A}/../${B}/${FILE}.jpg`,
  `media/${A}/./${FILE}.jpg`,
  `media/${A}//${FILE}.jpg`,
  `media/${A}/${FILE}.jpg/../../${B}/${FILE}.jpg`,
  `media/${A}/%2e%2e/${B}/${FILE}.jpg`,
  `media/${A}/..%2F${B}/${FILE}.jpg`,
  `media/${A}\\..\\${B}/${FILE}.jpg`,
  `media/${A}/${FILE}.jpg?x=1`,
  `media/${A}/${FILE}.exe`,
  `media/${A}/not-a-uuid.jpg`,
  `media/${A}/${FILE}`,
  `media/${B}/${FILE}.jpg`,
  `${A}/${FILE}.jpg`,
  `backups/${A}/${FILE}.jpg`,
  `media/${A.toUpperCase()}/${FILE}.jpg`,
  `media/${A}/sub/${FILE}.jpg`,
  "",
];

function fakeBucket() {
  const bucket = {
    download: vi.fn().mockResolvedValue({
      data: new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }), error: null }),
    createSignedUploadUrl: vi.fn(),
  };
  const table = { insert: vi.fn(async () => ({ error: null })),
    update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })) };
  return { bucket, client: { storage: { from: () => bucket }, from: () => table } };
}

describe("ownedObjectKey", () => {
  it("answers the bucket key for the caller's own media path", () => {
    expect(ownedObjectKey(OWN, A)).toBe(`${A}/${FILE}.jpg`);
    for (const ext of ["png", "m4a", "aac", "mp3", "wav", "jpeg"]) {
      expect(ownedObjectKey(`media/${A}/${FILE}.${ext}`, A)).toBe(`${A}/${FILE}.${ext}`);
    }
  });

  it.each(NOT_OWN)("refuses %j", (path) => {
    expect(ownedObjectKey(path, A)).toBeNull();
  });

  it("refuses everything for an empty or odd user id", () => {
    expect(ownedObjectKey(OWN, "")).toBeNull();
    expect(ownedObjectKey(`media/../${FILE}.jpg`, "..")).toBeNull();
  });
});

describe("fetchOwnedObject", () => {
  it.each(NOT_OWN)("403s on %j and downloads nothing", async (path) => {
    const { client, bucket } = fakeBucket();
    await expect(fetchOwnedObject(client as never, A, path))
      .rejects.toMatchObject({ status: 403, code: "media_not_owned" });
    expect(bucket.download).not.toHaveBeenCalled();
  });

  it("downloads the caller's own object by its bucket key", async () => {
    const { client, bucket } = fakeBucket();
    const out = await fetchOwnedObject(client as never, A, OWN);
    expect(bucket.download).toHaveBeenCalledWith(`${A}/${FILE}.jpg`);
    expect(Array.from(out.bytes)).toEqual([1, 2, 3]);
  });
});

describe("POST /api/coach/transcribe body (A136)", () => {
  it("takes only a media path, never a traversal key", () => {
    expect(transcribeRequestSchema.safeParse({ path: `media/${A}/${FILE}.m4a` }).success).toBe(true);
    for (const path of [`media/${A}/../${B}/${FILE}.m4a`, `${A}/${FILE}.m4a`, "x".repeat(40)]) {
      expect(transcribeRequestSchema.safeParse({ path }).success, path).toBe(false);
    }
  });
});

/** A storage upload token as hosted Supabase signs it: a JWT whose payload carries `exp`. */
function tokenUrl(payload: object): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `https://s.test/storage/v1/object/upload/sign/media/${A}/${FILE}.jpg?token=`
    + `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.sig`;
}

describe("the signed upload lifetime (P10)", () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const iat = Math.floor(now / 1000);

  it("reports the token's own expiry, never a fixed 60 s", () => {
    expect(signedUploadSeconds(tokenUrl({ iat, exp: iat + 7_200 }), now)).toBe(7_200);
    expect(signedUploadSeconds(tokenUrl({ iat, exp: iat + 60 }), now)).toBe(60);
  });

  it("falls back to Storage's documented two-hour ceiling when the token cannot be read", () => {
    expect(SIGNED_UPLOAD_MAX_SECONDS).toBe(7_200);
    for (const url of ["https://s.test/upload", "https://s.test/upload?token=not-a-jwt",
      tokenUrl({ iat }), tokenUrl({ exp: "soon" }), tokenUrl({ exp: iat - 5 })]) {
      expect(signedUploadSeconds(url, now), url).toBe(SIGNED_UPLOAD_MAX_SECONDS);
    }
  });

  it("is what signUpload answers", async () => {
    const { client, bucket } = fakeBucket();
    const exp = Math.floor(Date.now() / 1000) + 7_200;
    bucket.createSignedUploadUrl.mockResolvedValue({
      data: { signedUrl: tokenUrl({ exp }), path: "x" }, error: null });
    const out = await signUpload(client as never, A,
      { kind: "image", contentType: "image/jpeg", bytes: 1_000 });
    expect(out.expiresInSeconds).toBeGreaterThan(7_100);
    expect(out.expiresInSeconds).toBeLessThanOrEqual(7_200);
  });
});
