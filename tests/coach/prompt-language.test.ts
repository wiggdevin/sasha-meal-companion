/**
 * 2026-09-14. Devin: the coach "sometimes speaks in Mandarin Chinese".
 *
 * Nothing in the system prompt named a language. gemini-3.6-flash is multilingual, the coach runs
 * at temperature 0.3 (raised from 0 on 2026-09-13 to stop the degeneration that temperature-0
 * caused), and the only thing pinning the output language was habit.
 *
 * I did not reproduce the Mandarin myself — it is intermittent, and reproducing it would mean
 * burning paid calls until it happened. The missing instruction is verifiable on its own, which is
 * what this asserts: the prompt now says which language to answer in, and says the reply carries
 * only the reply.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt } from "@/lib/coach/prompt";

const prompt = () => buildSystemPrompt({
  constraints: {
    avoid_allergens: ["gluten", "dairy", "apple"], avoid_food_ref_ids: [],
    banned_categories: ["simple_sugars"], conditions: [], notes: null,
  },
  today: "2026-09-14",
});

afterEach(() => vi.unstubAllEnvs());

describe("the system prompt", () => {
  it("says to answer in English", () => {
    expect(prompt()).toMatch(/\bEnglish\b/);
  });

  it("says the reply carries the reply only, not the model's own working", () => {
    expect(prompt()).toMatch(/only the reply|never your reasoning|not your working/i);
  });

  it("still carries her binding constraints — the language rule does not displace them", () => {
    const text = prompt();
    expect(text).toContain("gluten, dairy, apple");
    expect(text).toContain("simple_sugars");
  });

  it.each([undefined, "", "1", "false"])(
    "omits every activity instruction when the activity flag is %s",
    (value) => {
      vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", value);
      const text = prompt();
      for (const activityCopy of [
        "Activity and expenditure",
        "Your device estimates",
        "lower or higher",
        "steps sped up an update",
        "Missing steps or device active kcal",
        "one-tap weekly proposal",
      ]) expect(text).not.toContain(activityCopy);
    },
  );

  it("states the activity evidence and weekly-proposal rules when the flag is on", () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "true");
    const text = prompt();
    expect(text).toMatch(/Your device estimates (?:…|<reported number>)/);
    expect(text).toMatch(/ask about device active calories, burned calories, steps, or eating extra/i);
    expect(text).toMatch(/Do not mention device energy on unrelated turns/i);
    expect(text).toContain("Your device estimates <reported number> active calories.");
    expect(text).toMatch(/does not change your target or create a food allowance/i);
    expect(text).toMatch(/must not appear in the reply, even in a denial/i);
    expect(text).toMatch(/Use the words `one-tap weekly proposal` and `logs and weight`/i);
    expect(text).toMatch(/lower or higher only when the activity context has sufficient coverage/i);
    expect(text).toContain("steps sped up an update that your logs and weight already supported");
    expect(text).toMatch(/Missing steps or device active kcal stay missing/i);
    expect(text).toMatch(/one-tap weekly proposal/i);
    expect(text).toContain("You never propose a change to any target");
  });

  it("mentions forbidden allowance wording only inside a prohibition, never as advice", () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "true");
    const text = prompt();
    for (const phrase of ["earned", "eat back", "extra calories", "you can eat X more"]) {
      const lines = text.split("\n").filter((line) => line.toLowerCase().includes(phrase.toLowerCase()));
      expect(lines.length, phrase).toBeGreaterThan(0);
      expect(lines.every((line) => /never use/i.test(line)), phrase).toBe(true);
    }
  });

  it("forbids claims that steps or device kcal directly changed a target", () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "true");
    expect(prompt()).toMatch(/Never claim that steps or device active kcal directly changed a target/);
  });

  it("does not script the 520-calorie challenge reply", () => {
    vi.stubEnv("COACH_ACTIVITY_CONTEXT_ENABLED", "true");
    expect(prompt()).not.toContain(
      "Your device estimates 520 active calories. That does not change your target or create a food allowance. Review the one-tap weekly proposal based on your logs and weight.",
    );
  });
});
