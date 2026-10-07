import { describe, expect, it } from "vitest";
import { MAX_SUBJECT_LENGTH, validateLookupSubject } from "@/lib/coach/lookup-subject";

describe("validateLookupSubject (Phase 13 §3.3, §9 R8)", () => {
  it("passes a clean food, dish, brand or restaurant subject", () => {
    expect(validateLookupSubject("Cheerios")).toBeNull();
    expect(validateLookupSubject("Chick-fil-A grilled chicken sandwich")).toBeNull();
  });

  it("passes a single 8-14 digit product/barcode number", () => {
    expect(validateLookupSubject("016000275867")).toBeNull(); // 12-digit UPC
    expect(validateLookupSubject("Cheerios 12345678")).toBeNull(); // 8-digit, the short end
  });

  it("rejects an empty or whitespace-only subject", () => {
    expect(validateLookupSubject("")).toBe("empty");
    expect(validateLookupSubject("   ")).toBe("empty");
  });

  it("rejects a subject past the 80-character limit", () => {
    expect(validateLookupSubject("a".repeat(MAX_SUBJECT_LENGTH))).toBeNull();
    expect(validateLookupSubject("a".repeat(MAX_SUBJECT_LENGTH + 1))).toBe("too_long");
  });

  it("rejects a digit run that is not a single product number — a weight, dose or age", () => {
    expect(validateLookupSubject("sugar 250mg")).toBe("digits");
    expect(validateLookupSubject("I am 34 years old")).toBe("digits");
    expect(validateLookupSubject("016000275867 and 123456789")).toBe("digits"); // two runs
    expect(validateLookupSubject("a 7-digit code 1234567")).toBe("digits"); // too short for a barcode
    expect(validateLookupSubject("a 15-digit code 123456789012345")).toBe("digits"); // too long
  });

  it("rejects a medical question, reusing the Phase 10 deflection vocabulary", () => {
    expect(validateLookupSubject("am I having a flare")).toBe("medical");
    expect(validateLookupSubject("is this a symptom of something")).toBe("medical");
  });

  it("rejects first-person wording — a fact about the user, not a food", () => {
    expect(validateLookupSubject("my favorite snack")).toBe("first_person");
    expect(validateLookupSubject("I'm eating oatmeal")).toBe("first_person");
  });

  it("rejects the user's own name", () => {
    expect(validateLookupSubject("Sam's protein bar", { userName: "Sam" })).toBe("name");
    expect(validateLookupSubject("Samsung protein bar", { userName: "Sam" })).toBeNull();
  });

  it("rejects a stored condition term", () => {
    expect(validateLookupSubject("colitis crackers", { conditions: ["colitis"] })).toBe("condition");
  });

  it("rejects a stored allergen term", () => {
    expect(validateLookupSubject("peanut butter jar", { allergens: ["peanut"] })).toBe("allergy");
  });

  it("checks digits before medical/first-person/name/condition/allergy", () => {
    // A digit violation is caught first regardless of what else the subject also contains.
    expect(validateLookupSubject("my 250mg supplement", { userName: "my" })).toBe("digits");
  });
});
