import type { BarcodeResponse } from "@/lib/barcode/client";
import type { ProposeResponse } from "@/lib/capture/types";

export const barcodeResponse: Extract<BarcodeResponse, { status: "resolved" }> = {
  status: "resolved",
  gtin14: "00012345678905",
  cached: false,
  match: {
    foodRefId: "11111111-1111-4111-8111-111111111111",
    catalogFoodId: 4,
    revisionId: 9,
    description: "Plain rice crackers",
    brand: "Garden Pantry",
    source: "off",
    qualityClass: "label",
    qualityFlags: [],
    per100g: { energy_kcal: 390, protein: 7, carbohydrate: 82, fat_total: 3 },
    portions: [{ id: 12, description: "6 crackers", gramWeight: 30, isDefault: true }],
    ingredientsText: "Rice, sea salt",
    allergenTags: [],
    attribution: "Open Food Facts",
    policy: { verdict: "unverified" },
  },
};

export const captureProposal: ProposeResponse = {
  draftId: "22222222-2222-4222-8222-222222222222",
  method: "photo",
  items: [{
    seq: 1,
    label: "Roast chicken",
    foodRefId: "33333333-3333-4333-8333-333333333333",
    catalogFoodRevisionId: 23,
    grams: 120,
    qty: 120,
    unit: "g",
    portionId: null,
    confidence: 0.4,
    policy: { verdict: "unverified" },
    alternatives: [{
      foodRefId: "44444444-4444-4444-8444-444444444444",
      label: "Chicken breast",
      score: 0.8,
    }],
    autoResolved: true,
  }],
  notes: ["Check the amount."],
  spend: { usedToday: 1, softCap: 20 },
};
