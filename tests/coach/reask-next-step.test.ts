/**
 * 2026-10-17 coach rerun, item 2: a re-ask that held back a food nothing has checked yet offers
 * the way to get it checked (add it to Eats) instead of a dead end. A food a rule blocks, or one
 * already on Eats or Avoid, is never offered, and the reply still recommends nothing.
 */
import { describe, expect, it } from "vitest";
import { isReask, reaskMessage, reaskNextStep, REASK_SOMETHING_ELSE, REASK_TAIL } from "@/lib/coach/reask";

describe("reaskNextStep", () => {
  it("offers Eats for a food nothing checked yet", () => {
    expect(reaskNextStep([{ name: "watermelon", reason: null }], [])).toEqual({
      foods: ["watermelon"], options: ["Add watermelon to Eats", REASK_SOMETHING_ELSE] });
    expect(reaskNextStep([{ name: "salmon", reason: "unchecked_id" }], [])?.foods).toEqual(["salmon"]);
  });

  it("never offers a food a rule blocks", () => {
    expect(reaskNextStep([{ name: "ice cream", reason: "allergen:dairy" }], [])).toBeNull();
    expect(reaskNextStep([{ name: "ice cream", reason: "allergen:dairy" },
      { name: "spaghetti", reason: null }], [])?.foods).toEqual(["spaghetti"]);
  });

  it("never offers a food already on Eats or Avoid", () => {
    expect(reaskNextStep([{ name: "Watermelon", reason: null }], ["watermelon"])).toBeNull();
    expect(reaskNextStep([{ name: "watermelon", reason: null }, { name: "rice", reason: null }],
      [" Watermelon "])?.foods).toEqual(["rice"]);
  });

  it("offers at most two foods, once each, and skips a name too long for a chip", () => {
    const next = reaskNextStep([{ name: "rice", reason: null }, { name: "Rice", reason: null },
      { name: "a very long prepared dish name here", reason: null },
      { name: "chicken", reason: null }, { name: "spaghetti", reason: null }], []);
    expect(next).toEqual({ foods: ["rice", "chicken"],
      options: ["Add rice to Eats", "Add chicken to Eats", REASK_SOMETHING_ELSE] });
  });

  it("offers nothing when the check only could not finish", () => {
    expect(reaskNextStep([{ name: "reply", reason: "reply_check_incomplete" }], [])).toBeNull();
  });
});

describe("reaskMessage with the Eats offer", () => {
  it("says how to get one food checked, and stays a re-ask", () => {
    const text = reaskMessage([{ name: "watermelon", reason: null }], ["watermelon"]);
    expect(text).toBe("I couldn’t check watermelon against your food rules yet, so I left it out. "
      + `Add it to your Eats and it gets checked against your food rules. ${REASK_TAIL}`);
    expect(isReask(text)).toBe(true);
  });

  it("names the offered foods when only some are offered", () => {
    expect(reaskMessage([{ name: "watermelon", reason: null }, { name: "rice", reason: null }], ["rice"]))
      .toBe("I couldn’t check watermelon and rice against your food rules yet, so I left them out. "
        + `Add rice to your Eats and it gets checked against your food rules. ${REASK_TAIL}`);
    expect(reaskMessage([{ name: "watermelon", reason: null }, { name: "rice", reason: null }],
      ["watermelon", "rice"])).toContain("Add watermelon and rice to your Eats and they get checked");
  });

  it("is unchanged without an offer", () => {
    expect(reaskMessage([{ name: "watermelon", reason: null }])).toBe(
      `I couldn’t check watermelon against your food rules yet, so I left it out. ${REASK_TAIL}`);
  });
});
