/**
 * 2026-10-17 coach rerun, item 2: a re-ask that held back a food nothing has checked yet offers
 * the way to get it checked (add it to Eats) instead of a dead end. A food a rule blocks, or one
 * on Eats or Avoid, is never offered, and the reply still recommends nothing.
 */
import { describe, expect, it } from "vitest";
import { isReask, reaskMessage, reaskNextStep, REASK_SOMETHING_ELSE, REASK_TAIL } from "@/lib/coach/reask";

const lists = (names: string[] = [], complete = true) => ({ names, complete });
const open = (name: string, reason: string | null = null) => ({ name, reason, offerEats: true as const });

describe("reaskNextStep", () => {
  it("offers Eats for a food the scan marked offerable", () => {
    expect(reaskNextStep([open("watermelon")], lists())).toEqual({
      foods: ["watermelon"], options: ["Add watermelon to Eats", REASK_SOMETHING_ELSE] });
    expect(reaskNextStep([open("salmon", "unchecked_id")], lists())?.foods).toEqual(["salmon"]);
  });

  it("never offers a food the scan did not mark, or one a rule blocks", () => {
    expect(reaskNextStep([{ name: "pork chops", reason: "unchecked_id" }], lists())).toBeNull();
    expect(reaskNextStep([{ name: "ice cream", reason: "allergen:dairy" }], lists())).toBeNull();
    expect(reaskNextStep([{ name: "ice cream", reason: "allergen:dairy" }, open("spaghetti")], lists())
      ?.foods).toEqual(["spaghetti"]);
  });

  it("never offers a name another failure holds for a rule, in either order", () => {
    expect(reaskNextStep([open("Ice  cream"), { name: "ice cream", reason: "allergen:dairy" }], lists()))
      .toBeNull();
  });

  it("never offers a food on Eats or Avoid, matched by its head words", () => {
    expect(reaskNextStep([open("Watermelon")], lists(["watermelon"]))).toBeNull();
    expect(reaskNextStep([open("watermelon")], lists(["Watermelon, raw"]))).toBeNull();
    expect(reaskNextStep([open("watermelon"), open("rice")], lists(["Watermelon, raw"]))?.foods)
      .toEqual(["rice"]);
  });

  it("offers nothing when the account's lists were not read in full", () => {
    expect(reaskNextStep([open("watermelon")], lists([], false))).toBeNull();
  });

  it("offers nothing when the check could not finish", () => {
    expect(reaskNextStep([open("watermelon"), { name: "reply", reason: "reply_check_incomplete" }],
      lists())).toBeNull();
  });

  it("offers at most two foods, once each, and skips a name too long for a chip", () => {
    const next = reaskNextStep([open("rice"), open("Rice"), open("a very long prepared dish name here"),
      open("chicken"), open("spaghetti")], lists());
    expect(next).toEqual({ foods: ["rice", "chicken"],
      options: ["Add rice to Eats", "Add chicken to Eats", REASK_SOMETHING_ELSE] });
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
