/**
 * W159 recall matching (research spike, docs/research/2026-10-17-food-recall-alerts.md).
 *
 * Pure. A recall is matched to a bought or pantry item on UPC/GTIN-14 only. A brand + name match is
 * recorded as a `note` for review and never becomes an alert: a shared brand is not the same
 * product, and a false recall alert about food someone eats is worse than a missed one.
 */
import { toGtin14 } from "@/lib/search/gtin";

/** The part of an openFDA food enforcement record this module reads. */
export type RecallRecord = {
  recall_number: string;
  product_description?: string;
  code_info?: string;
  recalling_firm?: string;
  reason_for_recall?: string;
  classification?: string;
  report_date?: string;
};

export type RecallItem = { id: string; gtin14?: string | null; brand?: string | null; name?: string | null };

export type RecallAlert = { itemId: string; recallNumber: string; gtin14: string };
export type RecallNote = { itemId: string; recallNumber: string; reason: "brand_and_name" };

/** A recall with the GTIN-14s found in its text. */
export type IndexedRecall = RecallRecord & { gtin14: string[] };

const UPC_LABELED =
  /\b(?:UPC|U\.P\.C\.|GTIN|EAN)\s*(?:code|no\.?|number|#)?\s*[:#-]?\s*(\d(?:[ -]?\d){6,15})/gi;
const PREFIX_LENGTHS = [14, 13, 12, 8];

/**
 * GTINs named in free text, only after a UPC/GTIN/EAN label (spaces and dashes allowed, as printed
 * "0 12345 67890 5"). A bare digit run is never read: about one random 12-14 digit run in ten passes
 * the check digit, and lot or case numbers would then raise false alerts. Digits run on after the
 * code ("UPC 036000291452 1103") are handled by trying the longest valid prefix.
 */
export function extractGtins(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const m of text.matchAll(UPC_LABELED)) {
    const digits = m[1].replace(/\D/g, "");
    for (const len of PREFIX_LENGTHS) {
      if (digits.length < len) continue;
      const g = toGtin14(digits.slice(0, len));
      if (g) {
        found.add(g);
        break;
      }
    }
  }
  return [...found];
}

/** The recall with its GTIN-14s read from `product_description` and `code_info`. */
export function indexRecall(r: RecallRecord): IndexedRecall {
  const gtin14 = [...new Set([...extractGtins(r.product_description), ...extractGtins(r.code_info)])];
  return { ...r, gtin14 };
}

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function brandAndNameMatch(item: RecallItem, r: RecallRecord): boolean {
  const brand = norm(item.brand);
  const name = norm(item.name);
  if (!brand || !name) return false;
  const hay = ` ${norm(r.recalling_firm)} ${norm(r.product_description)} `;
  // Whole-word brand and whole phrase name: "Kind" does not match "Kindred".
  return hay.includes(` ${brand} `) && hay.includes(` ${name} `);
}

/**
 * Alerts are exact GTIN-14 equality (an item's code is padded the same way, so a UPC-A and its
 * EAN-13 form agree). Notes are brand + name only, never alerts, and only for an item with no
 * alert on that recall.
 */
export function matchRecalls(
  items: RecallItem[],
  recalls: IndexedRecall[]
): { alerts: RecallAlert[]; notes: RecallNote[] } {
  const alerts: RecallAlert[] = [];
  const notes: RecallNote[] = [];
  for (const item of items) {
    const g = item.gtin14 ? toGtin14(item.gtin14) : null;
    for (const r of recalls) {
      if (g && r.gtin14.includes(g)) {
        alerts.push({ itemId: item.id, recallNumber: r.recall_number, gtin14: g });
      } else if (brandAndNameMatch(item, r)) {
        notes.push({ itemId: item.id, recallNumber: r.recall_number, reason: "brand_and_name" });
      }
    }
  }
  return { alerts, notes };
}
