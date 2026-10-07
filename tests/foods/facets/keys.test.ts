import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalFacetPayload, foodKey, inputHash } from "@/lib/foods/facet-keys";
import { sha256Hex } from "@/lib/foods/sha256";

describe("facet cache keys", () => {
  it("keys catalog revisions and user-food revisions without merging their identities", () => {
    expect(foodKey({ kind: "catalog_revision", id: 42 })).toBe("catalog_revision:42");
    expect(foodKey({ kind: "user_food", id: "food-1", rev: 7 })).toBe("user_food:food-1:7");
    expect(foodKey({ kind: "user_food", id: "food-1", rev: 8 }))
      .not.toBe(foodKey({ kind: "user_food", id: "food-1", rev: 7 }));
  });

  it("canonicalises case, Unicode, whitespace and absent optional fields", () => {
    const a = inputHash({
      name: "  CAFE\u0301  OATS ", brand: " Acme ", description: "Ready   to eat",
      preparation: " COLD ", ingredientsText: "Oats, Water",
    });
    const b = inputHash({
      name: "caf\u00e9 oats", brand: "acme", description: "ready to eat",
      preparation: "cold", ingredientsText: "oats, water",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(inputHash({ name: "Rice", brand: "" })).toBe(inputHash({ name: "rice" }));
  });

  it.each(["name", "brand", "description", "preparation", "ingredientsText"] as const)(
    "changes when canonical %s changes",
    (field) => {
      const base = { name: "rice", brand: "a", description: "b", preparation: "c", ingredientsText: "d" };
      expect(inputHash({ ...base, [field]: `${base[field]} changed` })).not.toBe(inputHash(base));
    },
  );

  it("excludes user context from both the input hash and its serialized payload", () => {
    const base = { name: "Rice", brand: "Kitchen" };
    const withUserContext = {
      ...base,
      weight: "177.4 lb",
      conditions: ["ulcerative-colitis-private-canary"],
      notes: "private-gut-note-canary",
      diet_prefs: ["private-diet-canary"],
    };
    expect(inputHash(withUserContext)).toBe(inputHash(base));
    const serializedPayload = canonicalFacetPayload(withUserContext);
    expect(inputHash(base)).toBe(`\\x${createHash("sha256").update(serializedPayload, "utf8").digest("hex")}`);
    for (const excluded of ["weight", "conditions", "notes", "diet_prefs", "177.4 lb",
      "ulcerative-colitis-private-canary", "private-gut-note-canary", "private-diet-canary"]) {
      expect(serializedPayload).not.toContain(excluded);
    }

  });
});

describe("sha256Hex", () => {
  it("matches node:crypto for empty, ascii, and multi-byte inputs", () => {
    for (const text of ["", "abc", "Rice, water", "crème brûlée 🍮", "x".repeat(200)]) {
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });
});
