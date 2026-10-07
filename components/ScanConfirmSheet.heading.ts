import type { BarcodeMatch, BarcodeResponse } from "@/lib/barcode/client";

export function scanHeading(response: BarcodeResponse, match: BarcodeMatch | null): {
  title: string; subtitle: string | undefined;
} {
  return {
    title: match ? match.description
      : response.status === "ambiguous" ? "Which one?" : "Not in the database",
    subtitle: match ? match.brand ?? undefined
      : response.status === "ambiguous" ? "This barcode matches more than one product."
        : "Search for it by what is on the pack.",
  };
}
