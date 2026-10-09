/** Body answers typed the way people say them (owner feedback 2026-10-08), US units in, metric out. */
import { describe, expect, it } from "vitest";
import { heightFromParts, parseAge, parseHeight, parseWeight } from "@/lib/profile/height-parse";

describe("parseHeight", () => {
  it.each([
    ["6 foot", 6, 0, 182.9],
    ["6 ft", 6, 0, 182.9],
    ["6'", 6, 0, 182.9],
    ["6'0\"", 6, 0, 182.9],
    ["6′0″", 6, 0, 182.9],
    ["6’", 6, 0, 182.9],
    ["5 10", 5, 10, 177.8],
    ["5'10", 5, 10, 177.8],
    ["5' 10\"", 5, 10, 177.8],
    ["5'10''", 5, 10, 177.8],
    ["5ft 10in", 5, 10, 177.8],
    ["5 ft. 10 in.", 5, 10, 177.8],
    ["5 foot 10", 5, 10, 177.8],
    ["5 feet 10 inches", 5, 10, 177.8],
    ["5 feet and 10 inches", 5, 10, 177.8],
    ["5-10", 5, 10, 177.8],
    ["  5 10\"  ", 5, 10, 177.8],
    ["70 in", 5, 10, 177.8],
    ["70\"", 5, 10, 177.8],
    ["70 inches", 5, 10, 177.8],
    ["5'10.5", 5, 10.5, 179.1],
    ["4 11", 4, 11, 149.9],
    ["5'10 1/2\"", 5, 10.5, 179.1],
    ["5 10 1/2", 5, 10.5, 179.1],
    ["5 10.5", 5, 10.5, 179.1],
    ["5' 10½", 5, 10.5, 179.1],
    ["5'10½\"", 5, 10.5, 179.1],
    ["5 ft 10 3/4 in", 5, 10.75, 179.7],
    ["6", 6, 0, 182.9],
    ["70", 5, 10, 177.8],
  ])("reads %j", (text, ft, inches, cm) => {
    expect(parseHeight(text)).toEqual({ ft, inches, cm });
  });

  it.each([
    "10 foot", "2", "10", "5 12", "5'13", "9 ft", "2 ft", "12 in", "120 in", "",
    "tall", "five ten", "5ft10cm", "178 cm", "510", "5 10 3", "-5 10", "abc 5'10",
  ])("rejects %j", (text) => {
    expect(parseHeight(text)).toBeNull();
  });

  it("refuses a lone number when bare numbers are off (a list of answers)", () => {
    expect(parseHeight("6", { allowBare: false })).toBeNull();
    expect(parseHeight("70", { allowBare: false })).toBeNull();
    expect(parseHeight("5 10", { allowBare: false })).toEqual({ ft: 5, inches: 10, cm: 177.8 });
  });

  it("reads two separate numbers", () => {
    expect(heightFromParts("5", "10")).toEqual({ ft: 5, inches: 10, cm: 177.8 });
    expect(heightFromParts("6", "")).toEqual({ ft: 6, inches: 0, cm: 182.9 });
    expect(heightFromParts("10", "0")).toBeNull();
    expect(heightFromParts("5", "12")).toBeNull();
    expect(heightFromParts("", "10")).toBeNull();
  });
});

describe("parseWeight", () => {
  it.each([["170", 170, 77.1], ["170 lb", 170, 77.1], ["170lbs", 170, 77.1], ["170 lbs.", 170, 77.1],
    ["170 pounds", 170, 77.1], ["165.5", 165.5, 75.1], ["45", 45, 20.4], ["880 lb", 880, 399.2]])(
    "reads %j", (text, lb, kg) => { expect(parseWeight(text)).toEqual({ lb, kg }); });

  it.each(["", "heavy", "44", "881", "80 kg", "1700", "170 stone"])("rejects %j", (text) => {
    expect(parseWeight(text)).toBeNull();
  });

  it("needs a unit word when bare numbers are off", () => {
    expect(parseWeight("170", { allowBare: false })).toBeNull();
    expect(parseWeight("170 lb", { allowBare: false })).toEqual({ lb: 170, kg: 77.1 });
  });
});

describe("parseAge", () => {
  it.each([["70", 70], ["34", 34], ["34 years", 34], ["34 yrs", 34], ["I'm 34", 34], ["i am 34", 34],
    ["34 years old", 34], ["34-year-old", 34], ["16", 16], ["110", 110]])(
    "reads %j", (text, age) => { expect(parseAge(text)).toBe(age); });

  it.each(["", "1", "12", "111", "40.5", "old", "thirty"])("rejects %j", (text) => {
    expect(parseAge(text)).toBeNull();
  });
});
