/**
 * Reads a recipe page's schema.org `Recipe` data (JSON-LD) into a title and plain ingredient names.
 * Pure: the page HTML comes in, data goes out, and no instruction in the page is ever followed —
 * the page only supplies strings that the coach then treats as food names.
 */
import { cleanIngredients, dishTitle, type InspireResult } from "@/lib/plan/inspire-types";

// Every quantifier is bounded: the page is untrusted and up to 1.5 MB, so an unclosed tag must not
// make a pattern backtrack across the whole body.
const LD_OPEN = /<script[^>]{0,300}type=["']application\/ld\+json["'][^>]{0,300}>/gi;
const OG_TITLE = /<meta[^>]{0,300}property=["']og:title["'][^>]{0,300}content=["']([^"'<>]{1,300})["']/i;
const TITLE = /<title[^>]{0,100}>([^<]{1,300})<\/title>/i;
const MAX_LD_BLOCKS = 10;
const MAX_LD_CHARS = 300_000;

/** The JSON-LD blocks, found by index rather than a lazy body pattern. */
function ldBlocks(html: string): string[] {
  const blocks: string[] = [];
  for (const open of html.matchAll(LD_OPEN)) {
    const start = (open.index ?? 0) + open[0].length;
    const end = html.indexOf("</script>", start);
    if (end === -1) break;
    if (end - start <= MAX_LD_CHARS) blocks.push(html.slice(start, end));
    if (blocks.length === MAX_LD_BLOCKS) break;
  }
  return blocks;
}

/** Units, counts and prep words removed from "2 cups chopped fresh spinach, packed". */
const QUANTITY = /^[\d\s/.,½¼¾⅓⅔⅛-]+/;
const UNITS = /\b(cups?|tbsps?|tablespoons?|tsps?|teaspoons?|g|grams?|kg|ml|l|oz|ounces?|lbs?|pounds?|pinch|dash|cloves?|cans?|slices?|pieces?|large|medium|small|whole|handful)\b\.?/gi;
const PREP = /\b(chopped|diced|minced|sliced|fresh|freshly|ground|packed|divided|optional|to taste|finely|roughly|peeled|cooked|softened|melted)\b/gi;

export function ingredientName(line: string): string {
  return decode(line.slice(0, 200)).split(/[,(]/)[0]
    .replace(QUANTITY, "").replace(UNITS, "").replace(PREP, "")
    .replace(/\bof\b/gi, "").replace(/\s+/g, " ").trim();
}

function decode(text: string): string {
  return text.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<[^>]+>/g, "");
}

function isRecipe(node: unknown): node is Record<string, unknown> {
  if (!node || typeof node !== "object") return false;
  const type = (node as Record<string, unknown>)["@type"];
  return type === "Recipe" || (Array.isArray(type) && type.includes("Recipe"));
}

function findRecipe(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 5 || !node || typeof node !== "object") return null;
  if (isRecipe(node)) return node;
  const children = Array.isArray(node) ? node
    : [(node as Record<string, unknown>)["@graph"], (node as Record<string, unknown>).mainEntity];
  for (const child of children) {
    const found = findRecipe(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function parseRecipePage(html: string): InspireResult {
  for (const block of ldBlocks(html)) {
    let data: unknown;
    try { data = JSON.parse(block.trim()); } catch { continue; }
    const recipe = findRecipe(data);
    if (!recipe) continue;
    const title = typeof recipe.name === "string" ? dishTitle(decode(recipe.name.slice(0, 300))) : null;
    const lines = Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient
      : Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    const ingredients = cleanIngredients(lines.slice(0, 60)
      .filter((line): line is string => typeof line === "string").map(ingredientName));
    return { kind: "recipe", title, ingredients };
  }
  const fallback = html.match(OG_TITLE)?.[1] ?? html.match(TITLE)?.[1] ?? null;
  const title = fallback ? dishTitle(decode(fallback).split(/\s[|–-]\s/)[0]) : null;
  return { kind: title ? "dish" : "unknown", title, ingredients: [] };
}
