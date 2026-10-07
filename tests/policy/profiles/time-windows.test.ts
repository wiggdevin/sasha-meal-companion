/**
 * sol BLOCK (p13-s3 fix round): a profile whose draft JSON limits its rules to a time window
 * (lent_catholic: Fridays in Lent; orthodox_fasting: the user's calendar) must not load as an
 * every-day "never". §9 R5: that prose becomes a typed window, or the rule stays inert.
 */
import { describe, expect, it } from "vitest";
import { PROFILE_DEFINITIONS, profileDefinition } from "@/lib/policy/profiles/catalog";
import { buildProfileInstance, profileDefinitionFrom } from "@/lib/policy/profiles/loader";
import type { RawProfile } from "@/lib/policy/profiles/schema";
import { PROFILE_TIME_WINDOWS } from "@/lib/policy/profiles/time-windows";
import { isActiveHardRule } from "@/lib/policy/profiles/types";
import rawDoc from "@/docs/research/dietary-profiles.draft.json";

const AT = "2026-03-06T12:00:00Z"; // a Friday in Lent 2026
const params = { source: "user_stated" as const, confirmedAt: "2026-02-01T00:00:00Z" };

describe("profile time windows (§9 R5)", () => {
  it("classifies every draft profile that carries a time_window — none is left as prose", () => {
    const windowed = (rawDoc as { profiles: { id: string; time_window: unknown }[] }).profiles
      .filter((p) => p.time_window !== null).map((p) => p.id).sort();
    expect(Object.keys(PROFILE_TIME_WINDOWS).sort()).toEqual(windowed);
    for (const id of windowed) expect(profileDefinition(id)?.timeWindow).toBe(PROFILE_TIME_WINDOWS[id]);
  });

  it("refuses to load a profile whose time_window has no typed classification", () => {
    const lent = rawDoc.profiles.find((p) => p.id === "lent_catholic") as unknown as RawProfile;
    expect(() => profileDefinitionFrom({ ...lent, id: "new_unclassified_fast" }))
      .toThrow(/time_window/);
  });

  it("a confirmed calendar-window hard item without dates stays inert (never every day)", () => {
    for (const id of ["lent_catholic", "orthodox_fasting"]) {
      const def = PROFILE_DEFINITIONS.get(id)!;
      const instance = buildProfileInstance(def, {
        ...params,
        confirmations: def.templates.map((t) => ({ facet: t.facet, confirmed: true })),
      });
      for (const rule of instance.rules) {
        expect(rule.confirmation).toBe("unconfirmed");
        expect(isActiveHardRule(rule, new Date(AT))).toBe(false);
      }
    }
  });

  it("a calendar-window hard item is active only inside the user's own dates", () => {
    const def = PROFILE_DEFINITIONS.get("lent_catholic")!;
    const instance = buildProfileInstance(def, {
      ...params,
      confirmations: [{
        facet: "land_animal_flesh", confirmed: true,
        activeWindows: [{ start: "2026-03-06T00:00:00Z", end: "2026-03-07T00:00:00Z" }],
      }],
    });
    const [rule] = instance.rules;
    expect(rule.confirmation).toBe("confirmed");
    expect(isActiveHardRule(rule, new Date(AT))).toBe(true);
    expect(isActiveHardRule(rule, new Date("2026-03-07T12:00:00Z"))).toBe(false); // Saturday
    expect(isActiveHardRule(rule, new Date("2026-03-05T12:00:00Z"))).toBe(false); // Thursday
  });

  it("an expiry-window hard item confirms only once the end date was asked (a date, or explicitly none)", () => {
    const def = PROFILE_DEFINITIONS.get("metronidazole")!;
    const unasked = buildProfileInstance(def, { ...params, confirmations: [{ facet: "alcohol", confirmed: true }] });
    expect(unasked.rules.find((r) => r.facet === "alcohol")!.confirmation).toBe("unconfirmed");

    const dated = buildProfileInstance(def, {
      ...params, confirmations: [{ facet: "alcohol", confirmed: true, expiresAt: "2026-03-10T00:00:00Z" }],
    });
    const rule = dated.rules.find((r) => r.facet === "alcohol")!;
    expect(rule.confirmation).toBe("confirmed");
    expect(isActiveHardRule(rule, new Date(AT))).toBe(true);
    expect(isActiveHardRule(rule, new Date("2026-03-11T00:00:00Z"))).toBe(false);
  });

  it("kosher's window belongs to its Passover option only: its base rules stay unconditional", () => {
    const def = PROFILE_DEFINITIONS.get("kosher")!;
    expect(def.timeWindow).toBe("option_only");
    const instance = buildProfileInstance(def, {
      ...params, confirmations: [{ facet: "pork", confirmed: true }],
    });
    expect(isActiveHardRule(instance.rules.find((r) => r.facet === "pork")!, new Date(AT))).toBe(true);
  });
});
