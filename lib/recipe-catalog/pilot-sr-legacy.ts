import { FOOD_DB } from "@/lib/food-db";

/**
 * Reviewed against Backups/usda/sr_legacy/food.csv (data_type=sr_legacy_food).
 * Each of the 30 original pilot FoodDB descriptions has exactly one SR Legacy FDC ID
 * (sirloin-steak-broiled added 2026-10-03, FDC 168635, checked against the same food.csv).
 * The description is a drift guard, never a database join key. This contains public USDA
 * catalog provenance only; it contains no account or personal food data.
 */
const PILOT_SR_LEGACY = [
  ["2-milk", "171267", "Milk, reduced fat, fluid, 2% milkfat, with added vitamin A and vitamin D"],
  ["banana", "173944", "Bananas, raw"],
  ["bell-pepper-red", "170108", "Peppers, sweet, red, raw"],
  ["black-beans-cooked", "173735", "Beans, black, mature seeds, cooked, boiled, without salt"],
  ["broccoli-cooked", "169967", "Broccoli, cooked, boiled, drained, without salt"],
  ["carrot-raw", "170393", "Carrots, raw"],
  ["chicken-breast-roasted", "171477", "Chicken, broilers or fryers, breast, meat only, cooked, roasted"],
  ["chickpeas-cooked", "173757", "Chickpeas (garbanzo beans, bengal gram), mature seeds, cooked, boiled, without salt"],
  ["crushed-tomatoes-canned", "170051", "Tomatoes, red, ripe, canned, packed in tomato juice"],
  ["egg-hard-boiled", "173424", "Egg, whole, cooked, hard-boiled"],
  ["greek-yogurt-plain-nonfat", "171312", "Yogurt, Greek, nonfat, plain, CHOBANI"],
  ["ground-beef-90-10-cooked", "174031", "Beef, ground, 90% lean meat / 10% fat, patty, cooked, broiled"],
  ["lemon", "167746", "Lemons, raw, without peel"],
  ["lentils-cooked", "172421", "Lentils, mature seeds, cooked, boiled, without salt"],
  ["olive-oil", "171413", "Oil, olive, salad or cooking"],
  ["onion-raw", "170000", "Onions, raw"],
  ["parmesan-cheese", "171247", "Cheese, parmesan, grated"],
  ["quinoa-cooked", "168917", "Quinoa, cooked"],
  ["rolled-oats-dry", "173904", "Cereals, oats, regular and quick, not fortified, dry"],
  ["salmon-atlantic-farmed-cooked", "175168", "Fish, salmon, Atlantic, farmed, cooked, dry heat"],
  ["sirloin-steak-broiled", "168635", "Beef, top sirloin, steak, separable lean only, trimmed to 0\" fat, choice, cooked, broiled"],
  ["spinach-cooked", "168463", "Spinach, cooked, boiled, drained, without salt"],
  ["spinach-raw", "168462", "Spinach, raw"],
  ["tofu-firm", "172475", "Tofu, raw, firm, prepared with calcium sulfate"],
  ["tomato-raw", "170457", "Tomatoes, red, ripe, raw, year round average"],
  ["tuna-canned-in-water-light", "171986", "Fish, tuna, light, canned in water, without salt, drained solids"],
  ["water", "174158", "Water, bottled, generic"],
  ["white-rice-cooked", "168935", "Rice, white, long-grain, regular, cooked, unenriched, with salt"],
  ["whole-wheat-bread", "172688", "Bread, whole-wheat, commercially prepared"],
  ["whole-wheat-pasta-cooked", "168910", "Pasta, whole-wheat, cooked (Includes foods for USDA's Food Distribution Program)"],
] as const;

const reviewed = new Map<string, { sourceId: string; description: string }>(
  PILOT_SR_LEGACY.map(([foodDbId, sourceId, description]) =>
    [foodDbId, { sourceId, description }]));
const foods = new Map(FOOD_DB.map((food) => [food.id, food]));

export function pilotSrLegacySource(foodDbId: string): {
  source: "fdc_sr_legacy"; sourceId: string; description: string;
} | null {
  const entry = reviewed.get(foodDbId);
  if (!entry || foods.get(foodDbId)?.sr !== entry.description) return null;
  return { source: "fdc_sr_legacy", sourceId: entry.sourceId,
    description: entry.description };
}

export function reviewedPilotFoodDbIds(): string[] {
  return [...reviewed.keys()];
}
