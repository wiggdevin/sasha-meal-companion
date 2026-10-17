/**
 * OD06 / W091: the reply text read out of a turn step that is still arriving
 * (lib/coach/draft-text.ts).
 */
import { describe, expect, it } from "vitest";
import { draftTextOf } from "@/lib/coach/draft-text";

const FINAL = JSON.stringify({
  kind: "final", calls: [], actions: [{ kind: "log_meal", items: [{ name: "a \"quoted\" {food}" }] }],
  suggestions: [], text: "Oats with berries.\nThen a walk — 20 min.", memory: [], reason: "",
});

describe("draftTextOf", () => {
  it("reads every prefix of a final step without throwing, and never runs ahead of the text", () => {
    const full = "Oats with berries.\nThen a walk — 20 min.";
    let last = "";
    for (let i = 0; i <= FINAL.length; i += 1) {
      const text = draftTextOf(FINAL.slice(0, i));
      if (text === null) continue;
      expect(full.startsWith(text)).toBe(true);
      expect(text.length).toBeGreaterThanOrEqual(last.length);
      last = text;
    }
    expect(last).toBe(full);
  });

  it("shows nothing for a tool step or an abort", () => {
    const tool = JSON.stringify({ kind: "tool", calls: [{ name: "get_day", args: "{}" }], actions: [],
      suggestions: [], text: "looking it up", memory: [], reason: "" });
    for (let i = 0; i <= tool.length; i += 1) expect(draftTextOf(tool.slice(0, i))).toBeNull();
    expect(draftTextOf(JSON.stringify({ kind: "abort", text: "x", reason: "y" }))).toBeNull();
  });

  it("waits for the kind when the text comes first", () => {
    expect(draftTextOf("{\"text\":\"Hello there\",")).toBeNull();
    expect(draftTextOf("{\"text\":\"Hello there\",\"kind\":\"final\"}")).toBe("Hello there");
  });

  it("drops an escape cut in half, and decodes unicode escapes", () => {
    expect(draftTextOf("{\"kind\":\"final\",\"text\":\"Tea \\")).toBe("Tea ");
    expect(draftTextOf("{\"kind\":\"final\",\"text\":\"Caf\\u00e")).toBe("Caf");
    expect(draftTextOf("{\"kind\":\"final\",\"text\":\"Caf\\u00e9!")).toBe("Café!");
  });

  it("reads past a ```json fence and ignores a nested text key", () => {
    expect(draftTextOf("```json\n{\"kind\":\"final\",\"text\":\"Hi")).toBe("Hi");
    expect(draftTextOf("{\"kind\":\"final\",\"actions\":[{\"text\":\"no\"}],\"text\":\"yes")).toBe("yes");
  });

  it("is null for anything that is not an object", () => {
    expect(draftTextOf("")).toBeNull();
    expect(draftTextOf("Sure! Here is")).toBeNull();
  });
});
