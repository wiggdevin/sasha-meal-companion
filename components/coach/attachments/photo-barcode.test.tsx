// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { barcodeInPhoto } from "@/components/coach/attachments/photo-barcode";
import { DockIntentReceiver, deliverDockIntent } from "@/components/coach/attachments/dock-handoff";
import type { BarcodeMatch, BarcodeResponse } from "@/lib/barcode/client";

vi.mock("@/lib/capture-client", async (original) => ({
  ...await original<typeof import("@/lib/capture-client")>(),
  signAndUpload: vi.fn(async () => ({ kind: "uploaded", path: "u/1/photo.jpg" })),
}));
vi.mock("@/lib/media/resize", () => ({ resizeImage: vi.fn(async (file: Blob) => file) }));

afterEach(cleanup);

const match = { foodRefId: "f1", catalogFoodId: 1, revisionId: 42, description: "Rice crackers" } as BarcodeMatch;
const resolved: BarcodeResponse = { status: "resolved", gtin14: "04006381333931", cached: false, match };
const ambiguous: BarcodeResponse = { status: "ambiguous", gtin14: "04006381333931", cached: false,
  matches: [match, { ...match, revisionId: 43, description: "Rice crackers, salted" }] };
const photo = new Blob(["jpeg"], { type: "image/jpeg" });
const account = () => ({ userId: "u", epoch: 1 });
const at = () => new Date("2026-10-04T12:00:00Z");

describe("barcodeInPhoto", () => {
  it("sends a known product as the barcode attachment the live scanner sends", async () => {
    const resolve = vi.fn(async () => ({ kind: "resolved" as const, response: resolved }));
    const found = await barcodeInPhoto(photo, { read: async () => "4006381333931", resolve, account, now: at });
    expect(resolve).toHaveBeenCalledWith({ userId: "u", epoch: 1 }, "4006381333931", undefined, undefined);
    expect(found).toMatchObject({ kind: "product", text: "Scanned Rice crackers",
      attachment: { kind: "barcode", v: 1, gtin14: "04006381333931", foodRefId: "f1", revisionId: "42",
        scannedAt: "2026-10-04T12:00:00.000Z" } });
  });

  it("asks which product when the code matches several", async () => {
    const found = await barcodeInPhoto(photo, { read: async () => "4006381333931",
      resolve: async () => ({ kind: "resolved", response: ambiguous }), account });
    expect(found).toEqual({ kind: "choose", response: ambiguous });
  });

  it("leaves the photo to the AI when there is no code, an unknown one, or no answer", async () => {
    const notFound: BarcodeResponse = { status: "not_found", gtin14: "04006381333931", searchHint: {} };
    const cases = [
      { read: async () => null },
      { read: async () => "4006381333931", resolve: async () => ({ kind: "resolved" as const, response: notFound }) },
      { read: async () => "4006381333931", resolve: async () => ({ kind: "offline" as const }) },
      { read: async () => "4006381333931", resolve: async () => ({ kind: "unreadable" as const }) },
      { read: async () => "4006381333931", resolve: async () => { throw new Error("boom"); } },
      { read: async () => "4006381333931", account: () => null },
    ];
    for (const deps of cases) expect(await barcodeInPhoto(photo, { account, ...deps })).toEqual({ kind: "photo" });
  });

  it("does nothing when the account changed while it ran", async () => {
    expect(await barcodeInPhoto(photo, { read: async () => "4006381333931",
      resolve: async () => ({ kind: "gone" }), account })).toEqual({ kind: "gone" });
  });
});

describe("the chat's photo receiver", () => {
  async function deliver(readBarcode: Parameters<typeof DockIntentReceiver>[0]["readBarcode"], scanEnabled = true) {
    const onAttachment = vi.fn(async () => true);
    render(<DockIntentReceiver ready onAttachment={onAttachment} scanEnabled={scanEnabled} readBarcode={readBarcode} />);
    await act(async () => { deliverDockIntent({ kind: "photo", file: new File(["x"], "pack.jpg") }); });
    await act(async () => { await Promise.resolve(); });
    return onAttachment;
  }

  it("sends a barcode read from the photo instead of the photo", async () => {
    const attachment = { kind: "barcode" } as never;
    const onAttachment = await deliver(async () => ({ kind: "product", attachment, text: "Scanned Rice crackers" }));
    expect(onAttachment).toHaveBeenCalledWith(attachment, "Scanned Rice crackers");
  });

  it("uploads the photo when it holds no barcode", async () => {
    const onAttachment = await deliver(async () => ({ kind: "photo" }));
    expect(onAttachment).toHaveBeenCalledWith(expect.objectContaining({ kind: "capture", method: "photo",
      mediaPath: "u/1/photo.jpg" }), "Sent a photo");
  });

  it("asks which product before sending anything", async () => {
    const onAttachment = await deliver(async () => ({ kind: "choose", response: ambiguous as Extract<BarcodeResponse, { status: "ambiguous" }> }));
    expect(onAttachment).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Which one?" })).toBeTruthy();
  });

  it("skips the barcode read when scanning is off", async () => {
    const readBarcode = vi.fn(async () => ({ kind: "photo" as const }));
    const onAttachment = await deliver(readBarcode, false);
    expect(readBarcode).not.toHaveBeenCalled();
    expect(onAttachment).toHaveBeenCalledWith(expect.objectContaining({ kind: "capture" }), "Sent a photo");
  });
});
