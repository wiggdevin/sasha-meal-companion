# Food recall alerts (W159 spike)

Status: research note. Nothing here ships to users yet.

## Source
openFDA food enforcement (`https://api.fda.gov/food/enforcement.json`), free, no key. Each record has
`product_description`, `code_info`, `recalling_firm`, `classification`, `reason_for_recall` and
`report_date`. There is no structured barcode field; UPCs only appear inside the two free-text fields.

## UPC coverage share
**49 % (49 of 100).** Measured on 2026-10-17 from the Mac session with
`pnpm exec tsx scripts/research/recall-spike.ts --limit 100`: the 100 most recent openFDA food
enforcement records (report dates 2026-09-02 to 2026-10-07). 49 carry at least one UPC/GTIN that
passes the label rule and the GS1 check digit below. The raw records are in
`tests/fixtures/recalls/snapshot.json` (public data). So about half of recent recalls can alert on an
exact barcode match; the rest could only be brand + name notes for review. The tests still use
`synthetic-sample.json`, which is hand-written and not real recall data.

## Match rules
- Alert only on exact GTIN-14 equality. UPCs found in text are read only after a UPC/GTIN/EAN label (a bare
  digit run is never read: about 1 in 10 random runs passes the check digit), and kept only with a valid GS1 check digit (`lib/search/gtin.ts`, reused), then padded to
  GTIN-14, so UPC-A and EAN-13 forms agree.
- A brand + name match is recorded as a note for review and never alerts. Brand matches are whole-word, so
  "Kind" does not match "Kindred".
- An item with no valid code never alerts.

Implementation: `lib/shopping/recall-match.ts` (pure), tests in `tests/shopping/recall-match.test.ts`.

## Alert surface
A dismissible card on Today and on the shopping list for a purchased or pantry item whose GTIN matches an
open recall: the product, the reason, the classification, and a link to the FDA notice. Wording states the
facts and says to check the product; it gives no medical advice. A note-only (brand + name) match shows
nowhere.

## Cadence
A daily job fetches records with `report_date` since the last run. Daily is enough: openFDA itself updates
weekly.

## Later follow-up
A shared `food_recalls` table (recall number, indexed GTINs, fields above, fetched at) filled by a cron
route that follows the existing job pattern (cron secret before limiter, bounded passes), and an
owner-scoped read that matches each account's purchased and pantry GTINs on the server. That needs a
migration and a cron entry, so it is a separate PR and a Mac apply.
