/** W125 (T2 D2): the phone holds each entry's signed thumbnail URL (or its absence) for 55 minutes. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { entryThumbnailUrl, resetThumbnailCache } from "@/lib/media/thumbnail-client";
import { resetTestAccount } from "../helpers/account";

const ENTRY = "22222222-2222-4222-8222-222222222222";
const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

beforeEach(async () => { resetThumbnailCache(); await resetTestAccount(); });

describe("entryThumbnailUrl", () => {
  it("asks once, then holds the URL until 55 minutes have passed", async () => {
    let t = 0;
    const fetchImpl = answer({ url: "https://x/s?t=1" });
    const opts = { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t };
    expect(await entryThumbnailUrl(ENTRY, opts)).toBe("https://x/s?t=1");
    t = 54 * 60_000;
    expect(await entryThumbnailUrl(ENTRY, opts)).toBe("https://x/s?t=1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t = 56 * 60_000;
    await entryThumbnailUrl(ENTRY, opts);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("holds 'no picture' for 30 seconds only, so a just-committed photo shows", async () => {
    let t = 0;
    const none = answer({ url: null });
    const opts = { fetchImpl: none as unknown as typeof fetch, now: () => t };
    await entryThumbnailUrl(ENTRY, opts);
    t = 29_000;
    await entryThumbnailUrl(ENTRY, opts);
    expect(none).toHaveBeenCalledTimes(1);
    t = 31_000;
    await entryThumbnailUrl(ENTRY, opts);
    expect(none).toHaveBeenCalledTimes(2);
  });

  it("holds no picture, shows nothing for a non-https URL, and asks again after a failure", async () => {
    const none = answer({ url: null });
    expect(await entryThumbnailUrl(ENTRY, { fetchImpl: none as unknown as typeof fetch })).toBeNull();
    expect(await entryThumbnailUrl(ENTRY, { fetchImpl: none as unknown as typeof fetch })).toBeNull();
    expect(none).toHaveBeenCalledTimes(1);
    resetThumbnailCache();
    expect(await entryThumbnailUrl(ENTRY, { fetchImpl: answer({ url: "javascript:x" }) as unknown as typeof fetch })).toBeNull();
    resetThumbnailCache();
    const failing = answer({}, 503);
    await entryThumbnailUrl(ENTRY, { fetchImpl: failing as unknown as typeof fetch });
    await entryThumbnailUrl(ENTRY, { fetchImpl: failing as unknown as typeof fetch });
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
