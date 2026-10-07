# Third-party notices

Code or prompt text adapted from other projects is listed here with its license. Add a row when you port something; keep the upstream copyright line.

| Upstream | License | What we adapted | Where |
|---|---|---|---|
| apoorvdarshan/fud-ai — Copyright (c) 2026 Apoorv Darshan | MIT | Open Food Facts v2 field list, identifying `User-Agent` shape, and the "reject only when all four of energy/protein/carbs/fat are absent; never zero-fill a single missing nutrient" rule | `lib/catalog/off.ts`, `lib/catalog/off-map.ts`, `lib/catalog/fdc-map.ts` |
| apoorvdarshan/fud-ai — Copyright (c) 2026 Apoorv Darshan | MIT | Food-analysis prompt shape: one shared item shape across methods, explicit unit per field, per-item grams, "never invent a count from the name", and the photo visible-pieces counting rule | `lib/ai/prompts.ts`, `lib/ai/schemas.ts` |
| apoorvdarshan/fud-ai — Copyright (c) 2026 Apoorv Darshan | MIT | Coach guardrail phrasing ("never treat a missing meal log as fasting") and the pack-eagerly / call-tools-lazily prompt split | `lib/coach/prompt.ts` |
| Open Food Facts contributors | ODbL 1.0 (data) | product/barcode data, cached privately, never re-published | catalog cache-on-miss rows |
| USDA FoodData Central | Public domain | Foundation, SR Legacy, FNDDS data | `catalog_*` |
