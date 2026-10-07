import { sha256Hex } from "@/lib/foods/sha256";

export type FacetFoodIdentity =
  | { kind: "catalog_revision"; id: string | number | bigint }
  | { kind: "user_food"; id: string; rev: number };

export type FacetFoodInput = {
  name: string;
  brand?: string | null;
  description?: string | null;
  preparation?: string | null;
  ingredientsText?: string | null;
};

/** The fields of a warm-job food that decide its cache identity (lib/foods/catalog-ingredients.ts). */
export type WarmFoodIdentity = {
  identity: FacetFoodIdentity;
  name: string;
  brand?: string | null;
  ingredientsText?: string | null;
  category?: string | null;
  serving?: string | null;
};

/** The canonical hash input the warm job stores a food under: category → description, serving → preparation. */
export function warmFoodHashInput(food: WarmFoodIdentity): FacetFoodInput {
  return { name: food.name, brand: food.brand, description: food.category,
    preparation: food.serving, ingredientsText: food.ingredientsText };
}

/** The exact (food_key, input_hash) the warm job writes for this food, so a reader finds its rows. */
export function warmFoodCacheKey(food: WarmFoodIdentity): { foodKey: string; inputHash: string } {
  return { foodKey: foodKey(food.identity), inputHash: inputHash(warmFoodHashInput(food)) };
}

/** Stable cache identity. A changed user-food revision deliberately gets a new key. */
export function foodKey(food: FacetFoodIdentity): string {
  return food.kind === "catalog_revision"
    ? `catalog_revision:${food.id}`
    : `user_food:${food.id}:${food.rev}`;
}

/**
 * Canonicalisation is field-ordered JSON over NFKC-normalised, lower-cased text. Leading,
 * trailing and repeated whitespace are collapsed, and absent/blank optional fields become null.
 * Punctuation is preserved because it can change ingredient and preparation meaning. The return
 * value is PostgreSQL bytea hex text (`\\x` plus 64 lower-case hex digits).
 */
export function inputHash(food: FacetFoodInput): string {
  return `\\x${sha256Hex(canonicalFacetPayload(food))}`;
}

/** The exact serialized payload `inputHash` digests: the five canonical food fields, nothing else. */
export function canonicalFacetPayload(food: FacetFoodInput): string {
  return JSON.stringify({
    name: canonicalText(food.name) ?? "",
    brand: canonicalText(food.brand),
    description: canonicalText(food.description),
    preparation: canonicalText(food.preparation),
    ingredientsText: canonicalText(food.ingredientsText),
  });
}

/**
 * Cache hashes are canonical PostgreSQL bytea hex (`\\x` plus 64 lower-case hex digits).
 * Supabase bytea reads may arrive in that form or as a 32-byte base64 string; both normalise here.
 */
export function normalizeInputHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^\\x[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (!/^[A-Za-z0-9+/]{43}=?$/.test(value)) return null;
  const padded = value.endsWith("=") ? value : `${value}=`;
  let binary: string;
  try { binary = atob(padded); } catch { return null; }
  if (binary.length !== 32 || btoa(binary) !== padded) return null;
  const hex = Array.from(binary, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `\\x${hex}`;
}

function canonicalText(value: string | null | undefined): string | null {
  const canonical = value?.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() ?? "";
  return canonical === "" ? null : canonical;
}
