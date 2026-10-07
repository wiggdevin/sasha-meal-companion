import { describe, expect, it } from "vitest";
import {
  AUDIO_MIME_TYPES, captureActions, captureMetaFrom, CAPTURE_LABELS, pickAudioMimeType,
  policyCopy, slotForNow, spendNote,
} from "@/lib/capture-client";
import { ACCEPTED_AUDIO_TYPES } from "@/lib/media/validate";

describe("which actions the sheet offers", () => {
  it("offers nothing with every capture flag off", () => {
    expect(captureActions({})).toEqual([]);
  });

  it("offers exactly the enabled methods, in canonical order", () => {
    expect(captureActions({ CAPTURE_METHODS: "text" })).toEqual([
      { method: "text", label: CAPTURE_LABELS.text },
    ]);
    expect(captureActions({ NEXT_PUBLIC_CAPTURE_METHODS: "photo,text" }).map((a) => a.method))
      .toEqual(["text", "photo"]);
  });

  it("has a line of copy for all four methods: text, photo, label and scan", () => {
    expect(Object.keys(CAPTURE_LABELS).sort()).toEqual(["label", "photo", "text", "voice"]);
    for (const label of Object.values(CAPTURE_LABELS)) expect(label).not.toMatch(/!/);
  });
});

describe("the audio container", () => {
  it("prefers mp4, then aac", () => {
    expect(AUDIO_MIME_TYPES).toEqual(["audio/mp4", "audio/aac"]);
    expect(pickAudioMimeType(() => true)).toBe("audio/mp4");
    expect(pickAudioMimeType((t) => t !== "audio/mp4")).toBe("audio/aac");
  });

  // A recorder that only makes webm (Firefox) must hear "unsupported" up front: the bucket,
  // the sign route and validateAudio all refuse webm, so a webm clip was recorded and then lost.
  it("only picks a container the server accepts", () => {
    for (const type of AUDIO_MIME_TYPES) expect(ACCEPTED_AUDIO_TYPES).toContain(type);
    expect(pickAudioMimeType((t) => t === "audio/webm")).toBeNull();
  });

  it("answers null when the browser records none of them", () => {
    expect(pickAudioMimeType(() => false)).toBeNull();
  });
});

describe("policy copy", () => {
  it("says nothing for an allowed item", () => {
    expect(policyCopy({ verdict: "allowed" })).toBeNull();
  });

  it("reads an allergen, an avoid-list hit and a banned category", () => {
    expect(policyCopy({ verdict: "blocked", reason: "allergen:gluten" })).toBe("Has gluten");
    expect(policyCopy({ verdict: "blocked", reason: "avoid_list" })).toBe("On your avoid list");
    expect(policyCopy({ verdict: "blocked", reason: "category:simple_sugars" })).toBe("Simple sugars");
    expect(policyCopy({ verdict: "blocked" })).toBe("Blocked");
  });

  it("names a diet facet instead of saying only blocked", () => {
    expect(policyCopy({ verdict: "blocked", reason: "facet:meat" })).toBe("Meat");
    expect(policyCopy({ verdict: "blocked", reason: "facet:pork" })).toBe("Contains pork");
  });

  it("calls an unverified item not checked", () => {
    expect(policyCopy({ verdict: "unverified" })).toBe("Not checked");
  });
});

describe("the spend note and the Today meta", () => {
  it("reads n of 30 today", () => {
    expect(spendNote({ usedToday: 4, softCap: 30 })).toBe("4 of 30 today");
  });

  it("ignores an entry that was not captured", () => {
    expect(captureMetaFrom({ method: "search", items: [] })).toBeNull();
    expect(captureMetaFrom(undefined)).toBeNull();
  });

  it("reads the method and flags a low-confidence item", () => {
    expect(captureMetaFrom({ method: "voice", items: [{ confidence: 0.9 }, { confidence: 0.41 }] }))
      .toEqual({ method: "voice", lowConfidence: true });
    expect(captureMetaFrom({ method: "voice", items: [{ confidence: 0.9 }] }))
      .toEqual({ method: "voice", lowConfidence: false });
  });

  it("treats a missing confidence as nothing to warn about", () => {
    expect(captureMetaFrom({ method: "text", items: [{ confidence: null }, {}] }))
      .toEqual({ method: "text", lowConfidence: false });
  });

  it("skips a non-object item instead of throwing", () => {
    expect(captureMetaFrom({ method: "voice", items: [null, { confidence: 0.9 }] }))
      .toEqual({ method: "voice", lowConfidence: false });
  });
});

describe("the slot a capture lands in", () => {
  const DAY = [
    { slot: "coffee" as const, time: "07:00" }, { slot: "meal-1" as const, time: "12:00" },
    { slot: "meal-2" as const, time: "16:00" },
  ];
  it("is the last slot whose time has arrived", () => {
    expect(slotForNow(DAY, 13 * 60)).toBe("meal-1");
    expect(slotForNow(DAY, 16 * 60)).toBe("meal-2");
  });
  it("is the first slot before the day starts", () => {
    expect(slotForNow(DAY, 6 * 60)).toBe("coffee");
  });
  it("is meal-1 when the day has no slots", () => {
    expect(slotForNow([], 9 * 60)).toBe("meal-1");
  });
  it("skips a time it cannot read", () => {
    expect(slotForNow([{ slot: "coffee", time: "??" }, { slot: "meal-1", time: "08:00" }], 9 * 60)).toBe("meal-1");
  });
});
