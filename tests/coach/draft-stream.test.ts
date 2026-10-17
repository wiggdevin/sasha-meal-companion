/**
 * OD06 / W091: what the draft stream sends (lib/server/coach-turn/draft.ts) and when it holds
 * (lib/coach/draft-guard.ts).
 */
import { describe, expect, it } from "vitest";
import { draftNamesBlocked, draftsHeldFor } from "@/lib/coach/draft-guard";
import { DRAFT_INTERVAL_MS, draftStream } from "@/lib/server/coach-turn/draft";
import { EMPTY_PROFILE, type ConstraintProfile } from "@/lib/policy/constraints";
import type { EvidenceByName } from "@/lib/coach/policy";

const raw = (text: string, kind = "final") => `{"kind":"${kind}","calls":[],"actions":[],"suggestions":[],"text":"${text}`;

function fakeClock() {
  let t = 0;
  let timers: { at: number; run: () => void }[] = [];
  return {
    now: () => t,
    setTimer: (run: () => void, ms: number) => {
      const timer = { at: t + ms, run };
      timers.push(timer);
      return () => { timers = timers.filter((x) => x !== timer); };
    },
    advance(ms: number) {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      timers = timers.filter((x) => x.at > t);
      due.forEach((x) => x.run());
    },
  };
}

function setup(profile: ConstraintProfile = EMPTY_PROFILE, evidence: EvidenceByName = {}) {
  const sent: string[] = [];
  const clock = fakeClock();
  const stream = draftStream((text) => sent.push(text), profile, () => evidence, clock);
  return { sent, clock, stream };
}

describe("draftStream", () => {
  it("sends the first text at once, then at most one draft per interval, ending on the last text", () => {
    const { sent, clock, stream } = setup();
    stream.onText(raw("Oats"));
    stream.onText(raw("Oats with"));
    stream.onText(raw("Oats with berries"));
    expect(sent).toEqual(["Oats"]);
    clock.advance(DRAFT_INTERVAL_MS);
    expect(sent).toEqual(["Oats", "Oats with berries"]);
  });

  it("flushes the step's last text when the step answers", () => {
    const { sent, stream } = setup();
    stream.onText(raw("Oats"));
    stream.onText(raw("Oats with berries."));
    stream.flush();
    expect(sent).toEqual(["Oats", "Oats with berries."]);
  });

  it("sends nothing for a tool step, and clears the draft when a new step starts", () => {
    const { sent, clock, stream } = setup();
    stream.onText(raw("looking", "tool"));
    expect(sent).toEqual([]);
    stream.onText(raw("I logged it"));
    clock.advance(DRAFT_INTERVAL_MS);
    stream.reset();
    expect(sent).toEqual(["I logged it", ""]);
  });

  it("cleans the draft like the saved reply (tool names never show)", () => {
    const { sent, stream } = setup();
    stream.onText(raw("I can build options using compose_meal for lunch."));
    expect(sent).toEqual(["I can build options for lunch."]);
  });

  it("drops a pending draft once closed", () => {
    const { sent, clock, stream } = setup();
    stream.onText(raw("A"));
    stream.onText(raw("AB"));
    stream.close();
    clock.advance(DRAFT_INTERVAL_MS);
    stream.onText(raw("ABC"));
    expect(sent).toEqual(["A"]);
  });

  it("clears and stops for the rest of the turn when a draft names an avoided allergen", () => {
    const { sent, clock, stream } = setup({ ...EMPTY_PROFILE, avoid_allergens: ["peanut"] });
    stream.onText(raw("Try a"));
    clock.advance(DRAFT_INTERVAL_MS);
    stream.onText(raw("Try a peanut"));
    stream.onText(raw("Try a peanut satay"));
    clock.advance(DRAFT_INTERVAL_MS);
    stream.reset();
    stream.onText(raw("Try oats"));
    stream.flush();
    expect(sent).toEqual(["Try a", ""]);
  });

  it("holds every draft for an account with a rule the guard cannot read from text", () => {
    const { sent, stream } = setup({ ...EMPTY_PROFILE, conditions: ["pregnant"] });
    stream.onText(raw("Hello"));
    stream.flush();
    expect(sent).toEqual([]);
  });

  it("sends nothing without a sink", () => {
    const stream = draftStream(undefined, EMPTY_PROFILE, () => ({}));
    expect(() => { stream.onText(raw("x")); stream.flush(); stream.close(); }).not.toThrow();
  });
});

describe("draft guard", () => {
  it("holds a whole turn for profile rules, conditions or custom rules, not for an empty profile", () => {
    expect(draftsHeldFor(EMPTY_PROFILE)).toBe(false);
    expect(draftsHeldFor({ ...EMPTY_PROFILE, conditions: ["  "] })).toBe(false);
    expect(draftsHeldFor({ ...EMPTY_PROFILE, conditions: ["kidney disease"] })).toBe(true);
    expect(draftsHeldFor({ ...EMPTY_PROFILE,
      profileRules: { items: [{}] as never, asOf: new Date() } })).toBe(true);
    expect(draftsHeldFor({ ...EMPTY_PROFILE, custom_rules: [{}] as never })).toBe(true);
  });

  it("finds an avoided allergen by its keywords and a blocked food this turn looked up", () => {
    const profile = { ...EMPTY_PROFILE, avoid_allergens: ["dairy"] };
    expect(draftNamesBlocked("Add some cheese on top", profile, {})).toBe(true);
    expect(draftNamesBlocked("Add some berries on top", profile, {})).toBe(false);
    const evidence: EvidenceByName = { "Granola bar": { foodRefId: "f1",
      allergenTags: [], category: null, onEatsList: false, onAvoidList: true } };
    expect(draftNamesBlocked("A granola bar works", EMPTY_PROFILE, evidence)).toBe(true);
    expect(draftNamesBlocked("Oats work", EMPTY_PROFILE, evidence)).toBe(false);
  });
});
