/**
 * Phase 18 W5, acceptance 5 (docs/specs/phase-18-open-world-foods.md D2, D15): no AI payload
 * carries `country_code`, sex or birth year. The prior reads them on the server
 * (lib/foods/universe/prior.ts `accountPrior`); no model ever does. Taste dislikes and cuisines
 * stay out of every prompt too (D15: taste data never enters a model prompt).
 *
 * Two halves:
 *   - static: every module that builds or calls a payload builder, and the coach's context and
 *     transcript modules, names none of those fields;
 *   - runtime: the builders and the coach's profile line, handed a whole settings row, emit none of
 *     those values.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { coachTurnPayload, weeklyReviewPayload } from "@/lib/ai/gemini-payloads";
import { intentPayload, prefsPayload, verifyPayload } from "@/lib/ai/payloads";
import { profileLine } from "@/lib/server/coach-context";

const SENSITIVE = /\b(country_code|countryCode|birth_year|birthYear|sex)\b/;
const BUILDER_IMPORT = /from\s+["']@\/lib\/ai\/(payloads|gemini-payloads|openrouter-payloads)["']/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("no AI payload carries country_code, sex or birth year (static)", () => {
  it("the payload builders, every module that calls one, and the coach's context modules name none of them", () => {
    const callers = ["lib", "app", "components"].flatMap(sources)
      .filter((file) => BUILDER_IMPORT.test(readFileSync(file, "utf8")));
    const context = [...sources("lib/server/coach-turn"), "lib/server/coach-context.ts",
      ...sources("lib/ai")];
    const scanned = [...new Set([...callers, ...context])];
    expect(callers.length).toBeGreaterThan(10);
    const hits = scanned.filter((file) => SENSITIVE.test(readFileSync(file, "utf8")))
      .map((file) => file.split(path.sep).join("/"));
    expect(hits).toEqual([]);
  });

  it("the coach's profile read selects no demographic column", () => {
    const source = readFileSync("lib/server/coach-context.ts", "utf8");
    const selects = [...source.matchAll(/from\("user_settings"\)\s*\.select\("([^"]*)"\)/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThan(0);
    for (const columns of selects) expect(columns).not.toMatch(/country_code|birth_year|\bsex\b|cuisines/);
  });
});

describe("no AI payload carries country_code, sex or birth year (runtime)", () => {
  const row = {
    weight_kg: 61, activity_level: "moderate", goal: "recomp",
    diet_prefs: { flags: ["vegetarian"], taste: { dislikes: ["f:okra", "t:slimy"] } },
    sex: "female", birth_year: 1990, country_code: "US", cuisines: ["korean"],
  };
  const leaked = (value: unknown) => {
    const text = JSON.stringify(value);
    return ["country_code", "birth_year", "1990", "\"US\"", "female", "sex", "korean", "okra", "slimy"]
      .filter((needle) => text.includes(needle));
  };

  it("the coach's profile line, given the whole row, says only weight, activity, goal and diet flags", () => {
    const line = profileLine(row as Parameters<typeof profileLine>[0]);
    expect(line).toBe("Profile: 61 kg, moderate activity, goal recomp; prefers: vegetarian");
    expect(leaked(line)).toEqual([]);
  });

  it("the Jev builders drop a smuggled profile row", () => {
    const smuggle = <T extends object>(input: T) => ({ ...input, ...row, profile: row }) as T;
    expect(leaked(prefsPayload(smuggle({ text: "no pork" })))).toEqual([]);
    expect(leaked(intentPayload(smuggle({ message: "log my lunch", now: "2026-10-06T12:00:00Z", numbers: [] }))))
      .toEqual([]);
    expect(leaked(verifyPayload(smuggle({ reply: "Done.", actions: [], toolNames: [] })))).toEqual([]);
  });

  it("the Gemini builders carry only the transcript or prompt they are given", () => {
    const coach = coachTurnPayload(["Hello"]);
    const review = weeklyReviewPayload("A week of meals.");
    expect(leaked(coach)).toEqual([]);
    expect(leaked(review)).toEqual([]);
  });
});
