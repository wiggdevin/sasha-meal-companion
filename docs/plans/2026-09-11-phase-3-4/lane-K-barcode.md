# Lane K — Barcode + provider cache (Phase 3): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this lane task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** She points the camera at a packaged pouch and the confirm sheet opens with the product, its ingredients, an allergen badge and a portion — in under five seconds, and with no network at all the second time. A GTIN resolves against `catalog_barcodes` first; a miss is fetched once from Open Food Facts, then FDC Branded, written into the catalog as an ordinary revision, and never fetched again until it is 90 days old. An unknown barcode is an answer (`not_found` with a search hint), not an error, and it is remembered for 7 days so it costs one outbound call, not one per scan.

**Architecture:** Three layers, each testable on its own. (1) Pure mappers — `lib/barcode/gtin.ts`, `lib/barcode/quorum.ts`, `lib/catalog/off-map.ts`, `lib/catalog/fdc-map.ts` — no I/O, fixture-driven. (2) The server path — `lib/catalog/off.ts` and `lib/catalog/fdc.ts` are the only modules that reach the network (allowlisted host, 5 s `AbortController`, `redirect: "error"`, no image URL ever); `lib/server/catalog-writer.ts` is the only request-path writer of `catalog_*` and does its whole write in one `security definer` RPC so a half-written revision cannot exist; `lib/server/barcode.ts` owns the resolution order and the negative cache; `app/api/foods/barcode/route.ts` is the rate-limited edge. (3) The client — a `zxing-wasm` Web Worker decodes frames, `lib/barcode/quorum.ts` refuses a single lucky read, `lib/barcode/scan-cache.ts` keeps the resolved revision in the existing IndexedDB `catalog_revisions` store keyed additionally by GTIN so an airplane-mode repeat resolves locally, and two sheets (`BarcodeScanSheet` → `ScanConfirmSheet`) end at Phase 2's `commitLogEntry`. `app/scan/page.tsx` is the standalone entry so the flow is testable on her phone before Today is wired; the Today wiring is the integration stage's job and ships here as a hand-off diff.

**Tech Stack:** Next.js 16.3.4, React 19, TypeScript, Tailwind 4 (DESIGN.md tokens and `app/globals.css` utilities only), pnpm 11, Node 22, vitest 5 (node environment), Supabase Postgres 17, `zxing-wasm` (pre-lane), `zod` 4, `idb` 8. No new npm dependency; `@testing-library/react` is not installed and none is added.

**Specs:** `docs/specs/phase-3-fast-capture.md` (Data changes, API changes, Engines and logic, Security, Test plan, AC 1–5, 11, 12). Contracts: `docs/plans/2026-09-11-phase-3-4/00-contracts.md` §1 row K, §2, §4, §6, §8, §9; `docs/plans/2026-09-10-phase-0/00-contracts.md` §2, §5, §8; `docs/plans/2026-09-11-phase-1-2/00-contracts.md` §2–§5. Architecture: `docs/architecture.md` §3.1, §3.2, §3.3, §3.6, §4.1, §4.4, §4.6, §5, §7.3. Reference (MIT, read-only): `~/Desktop/Sasha app/04-open-source-bases/E-fud-ai-review.md` §2 — the OFF field list, the `User-Agent` shape and the "reject only when all four of energy/protein/carbs/fat are absent" rule are ported from it and get a `NOTICE.md` row in Task 16.

**Pre-lane state on this checkout (re-verified 2026-09-11):** `lib/capture/types.ts`, `lib/capture/flags.ts` and `lib/policy/constraints.ts` are already landed on this branch (contracts §0 pre-lane setup is complete — confirmed by reading the files directly, not assumed), and `zxing-wasm@2.2.4` is already installed (`package.json` carries the dependency and the `postinstall` line, `node_modules/zxing-wasm` resolves, and its `./reader` export ships exactly the documented 2.x API this lane codes against — `prepareZXingModule`, `readBarcodes`). This lane therefore starts from landed code, not from contract signatures alone, for all three pre-lane files; Task 13 still opens `node_modules/zxing-wasm`'s reader export before writing the import (Task 13's own discipline, not a hedge against the package being absent). `scripts/copy-zxing-wasm.mjs` is pre-lane and is **not** created here.

## Global Constraints

Copied from `docs/plans/2026-09-11-phase-3-4/README.md` "Global Constraints":

Phase 0 §8 and Phase 1–2 §8a (TDD, conventional commits, no AI attribution, request-local clients, `user_id` from `auth.uid()`, rate-limit → identity → body order, files < 400 lines, `null` ≠ `0`) plus: no new npm dependencies beyond the pre-lane `zxing-wasm`; provider and model text is data, never instruction; no draft reaches `log_entries` without her tap; the only request-path writer of `catalog_*` is `lib/server/catalog-writer.ts`; every prompt is temperature 0 with a per-purpose `maxOutputTokens`; gates are measured and reported, never lowered.

Lane-local consequences of those: functions < 50 lines and nesting ≤ 4; no module-level Supabase client anywhere; every error body is `{ error, message }` and never echoes the request body; OFF/FDC product names, brands and ingredient strings are rendered as text and never interpolated into SQL or a prompt; no image or media URL from a provider payload is ever fetched; migrations carry a matching `supabase/migrations/down/<name>.down.sql` that drops only what they created; styling uses only `app/globals.css` utilities and `DESIGN.md` tokens — no new colours.

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260919090100_phase3_barcode_cache.sql` | `catalog_barcode_lookups` (spec DDL verbatim) + `catalog_write_provider_revision` RPC, the one atomic provider write |
| `supabase/migrations/down/20260919090100_phase3_barcode_cache.down.sql` | Drops exactly the table, its index and the function |
| `lib/barcode/gtin.ts` | `normalizeGtin` re-exported from `lib/search/gtin.ts`, plus `gtinCheckDigit`, `isGtin`, `providerCode` |
| `lib/barcode/quorum.ts` | `acceptReading` — the same text ≥ quorum times inside 1500 ms wins; a different text resets |
| `lib/catalog/off.ts` | Typed OFF v2 product fetcher: allowlisted host, 5 s abort, `redirect: "error"`, the fud-ai field list, `OFF_USER_AGENT` |
| `lib/catalog/fdc.ts` | Typed FDC Branded search fetcher: `X-Api-Key` from `FDC_API_KEY`, same allowlist and timeout rules |
| `lib/catalog/off-map.ts` | `offToRevision` + the shared `RevisionDraft` type, Atwater, allergen scan, ingredient splitter |
| `lib/catalog/fdc-map.ts` | `fdcBrandedToRevision` over the FDC nutrient-id table, reusing off-map's shared helpers |
| `lib/server/catalog-writer.ts` | `writeProviderRevision` — the only request-path `catalog_*` writer; one RPC call, one transaction |
| `lib/server/barcode.ts` | `resolveBarcode`: GTIN → `catalog_barcodes` → negative cache → OFF → FDC → write → policy → `BarcodeResponse` |
| `app/api/foods/barcode/route.ts` | `POST /api/foods/barcode`; flag gate, rate limits, body limit, `jsonError` |
| `lib/db/catalog-cache.ts` | *(modify)* `CachedRevision.gtin14?` and `getByGtin(gtin14)` |
| `lib/barcode/scan-cache.ts` | `rememberScan`, `resolveOffline`, the `smc:pending_scans` queue and its `online` replay |
| `lib/barcode/client.ts` | Wire types, `SCAN_FORMATS`, the worker message shapes, `scanGtin`, `ScanUnavailable`, `toCachedRevision` |
| `lib/barcode/worker.ts` | Web Worker module wrapping `zxing-wasm/reader`, wasm served from `/zxing/` |
| `components/BarcodeScanSheet.tsx` | Camera, rAF → offscreen canvas → worker every 150 ms, torch, quorum, 44 px cancel |
| `components/ScanConfirmSheet.tsx` | Resolved / ambiguous / not_found views, allergen badge, portion picker, qty stepper, star, **Log it** |
| `app/scan/page.tsx` | Standalone full-screen entry; `notFound()` when the flag is unset; redirects to `/` after a log |
| `scripts/off-rate-probe.ts` | 30 sequential OFF reads of known GTINs, prints status codes and headers; never in CI |
| `NOTICE.md` | *(modify)* the fud-ai MIT row for the OFF field list and the missing-nutrient rule |
| `tests/barcode/gtin.test.ts` | Four lengths, bad check digit, leading zeros, `providerCode` |
| `tests/barcode/quorum.test.ts` | Quorum met, window expiry, a different text resets |
| `tests/barcode/off.test.ts` | Field list, header, timeout, redirect refusal, 404/429/5xx mapping |
| `tests/barcode/fdc.test.ts` | Key header, GTIN match filter, missing key, failures |
| `tests/barcode/off-map.test.ts` | Apple-in-ingredients pouch, no-nutriments reject, `energy_mismatch`, kJ-only, salt-only |
| `tests/barcode/fdc-map.test.ts` | Nutrient-id table, unit conversion, portions, reject |
| `tests/barcode/fake-client.ts` | The hand-rolled Supabase query-builder double the resolve and route suites share |
| `tests/barcode/resolve.test.ts` | Resolution order, negative cache, ambiguity order, 90-day refresh flag, policy |
| `tests/barcode/route.test.ts` | Flag 404, 400, 401, 429 + `retryAfterMs`, cached zero-fetch, OFF→FDC→not_found, 503 |
| `tests/barcode/scan-cache.test.ts` | `getByGtin`, `rememberScan`, pending queue + replay |
| `tests/barcode/client.test.ts` | `scanGtin` transport mapping, `ScanUnavailable`, `toCachedRevision`, `SCAN_FORMATS` |
| `tests/barcode/confirm.test.ts` | `ScanConfirmSheet`'s exported pure helpers (hint text, grams, badge choice) |
| `tests/barcode/schema.test.ts` | *[needs branch]* table shape, grants, writer atomicity, `authenticated` cannot insert `catalog_barcodes` |

---

## Task 1 — GTIN helpers over the Phase 1 normaliser

**Files**
- Create: `lib/barcode/gtin.ts`
- Test: `tests/barcode/gtin.test.ts`

**Interfaces**
- Consumes: `toGtin14(raw: string): string | null` from `lib/search/gtin.ts` (landed; pads 8/12/13/14 digits to 14 and verifies mod-10 over the padded form).
- Produces:
  ```ts
  export { toGtin14 as normalizeGtin } from "@/lib/search/gtin";
  export function gtinCheckDigit(body13: string): number;
  export function isGtin(raw: string): boolean;
  export function providerCode(gtin14: string): string;
  ```

**Steps**

- [ ] Write the failing test `tests/barcode/gtin.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { gtinCheckDigit, isGtin, normalizeGtin, providerCode } from "@/lib/barcode/gtin";

  describe("normalizeGtin", () => {
    it.each([
      ["EAN-8", "96385074", "00000096385074"],
      ["UPC-A", "036000291452", "00036000291452"],
      ["EAN-13", "4006381333931", "04006381333931"],
      ["GTIN-14", "10036000291459", "10036000291459"],
    ])("pads a valid %s to 14 digits", (_label, raw, expected) => {
      expect(normalizeGtin(raw)).toBe(expected);
    });

    it("keeps leading zeros that are part of the code", () => {
      expect(normalizeGtin("0036000291452")).toBe("00036000291452");
    });

    it("returns null for a bad check digit", () => {
      expect(normalizeGtin("4006381333932")).toBeNull();
    });

    it("returns null for a length that is not a GTIN", () => {
      expect(normalizeGtin("12345")).toBeNull();
      expect(normalizeGtin("123456789012345")).toBeNull();
    });

    it("returns null for all zeros", () => {
      expect(normalizeGtin("00000000")).toBeNull();
    });
  });

  describe("gtinCheckDigit", () => {
    it("computes the mod-10 digit over 13 digits", () => {
      expect(gtinCheckDigit("0400638133393")).toBe(1);
      expect(gtinCheckDigit("0003600029145")).toBe(2);
    });

    it("refuses a body that is not 13 digits", () => {
      expect(() => gtinCheckDigit("123")).toThrow(RangeError);
      expect(() => gtinCheckDigit("040063813339x")).toThrow(RangeError);
    });
  });

  describe("isGtin", () => {
    it("is true exactly when normalizeGtin returns a value", () => {
      expect(isGtin("4006381333931")).toBe(true);
      expect(isGtin("4006381333932")).toBe(false);
      expect(isGtin("hello")).toBe(false);
    });
  });

  describe("providerCode", () => {
    it("drops the GTIN-14 padding down to the EAN-13 form providers store", () => {
      expect(providerCode("04006381333931")).toBe("4006381333931");
      expect(providerCode("00036000291452")).toBe("0036000291452");
      expect(providerCode("00000096385074")).toBe("0000096385074");
    });

    it("leaves a true ITF-14 alone", () => {
      expect(providerCode("10036000291459")).toBe("10036000291459");
    });
  });
  ```
- [ ] Run it: `pnpm test tests/barcode/gtin.test.ts` — expect `Failed to resolve import "@/lib/barcode/gtin"`.
- [ ] Write `lib/barcode/gtin.ts`:
  ```ts
  /**
   * GTIN helpers for the scan path. `normalizeGtin` is NOT reimplemented here: Phase 1's
   * lib/search/gtin.ts already pads 8/12/13/14 digits to GTIN-14 and verifies the mod-10 digit
   * against the padded form, and two copies of a check-digit loop is one copy too many
   * (contracts §2, "reuse it, never duplicate the check-digit code").
   */
  import { toGtin14 } from "@/lib/search/gtin";

  export { toGtin14 as normalizeGtin } from "@/lib/search/gtin";

  /** The mod-10 digit for the first 13 digits of a GTIN-14. Weights 3,1,3,1… from the left. */
  export function gtinCheckDigit(body13: string): number {
    if (!/^[0-9]{13}$/.test(body13)) {
      throw new RangeError("gtinCheckDigit needs exactly 13 digits");
    }
    let sum = 0;
    for (let i = 0; i < 13; i += 1) {
      sum += Number(body13[i]) * (i % 2 === 0 ? 3 : 1);
    }
    return (10 - (sum % 10)) % 10;
  }

  export function isGtin(raw: string): boolean {
    return toGtin14(raw) !== null;
  }

  /**
   * The form OFF and FDC store. Both keep barcodes as printed and normalise UPC-A to EAN-13, so a
   * lookup sends the 13-digit form and only a real ITF-14 keeps its 14th digit. The GTIN-14 stays
   * the single key on our side — this value never reaches the database.
   */
  export function providerCode(gtin14: string): string {
    const significant = gtin14.replace(/^0+/, "");
    return significant.length <= 13 ? significant.padStart(13, "0") : gtin14;
  }
  ```
- [ ] Run it: `pnpm test tests/barcode/gtin.test.ts` — expect PASS (17 assertions, 0 failed).
- [ ] Commit: `git add lib/barcode/gtin.ts tests/barcode/gtin.test.ts && git commit -m "feat(barcode): GTIN-14 helpers over the Phase 1 normaliser"`

---

## Task 2 — Quorum over repeated readings

**Files**
- Create: `lib/barcode/quorum.ts`
- Test: `tests/barcode/quorum.test.ts`

**Interfaces**
- Consumes: nothing.
- Produces:
  ```ts
  export type Reading = { text: string; format: string; at: number };
  export const QUORUM_WINDOW_MS = 1500;
  export const DEFAULT_QUORUM = 2;
  export function acceptReading(history: Reading[], next: Reading, quorum?: number): string | null;
  export function pruneHistory(history: Reading[], now: number, keep?: number): Reading[];
  ```

**Steps**

- [ ] Write the failing test `tests/barcode/quorum.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { acceptReading, pruneHistory, type Reading } from "@/lib/barcode/quorum";

  const read = (text: string, at: number): Reading => ({ text, format: "EAN-13", at });

  describe("acceptReading", () => {
    it("refuses a single lucky read", () => {
      expect(acceptReading([], read("4006381333931", 1000))).toBeNull();
    });

    it("accepts the second identical read inside the window", () => {
      const history = [read("4006381333931", 1000)];
      expect(acceptReading(history, read("4006381333931", 1400))).toBe("4006381333931");
    });

    it("refuses when the earlier read is older than 1500 ms", () => {
      const history = [read("4006381333931", 1000)];
      expect(acceptReading(history, read("4006381333931", 2600))).toBeNull();
    });

    it("resets when a different text lands between two matches", () => {
      const history = [read("4006381333931", 1000), read("0036000291452", 1100)];
      expect(acceptReading(history, read("4006381333931", 1200))).toBeNull();
    });

    it("honours a higher quorum", () => {
      const history = [read("9", 1000), read("9", 1100)];
      expect(acceptReading(history, read("9", 1200), 3)).toBe("9");
      expect(acceptReading([read("9", 1000)], read("9", 1100), 3)).toBeNull();
    });
  });

  describe("pruneHistory", () => {
    it("drops readings outside the window and caps the tail", () => {
      const history = [read("a", 100), read("b", 1900), read("c", 1950)];
      expect(pruneHistory(history, 2000)).toEqual([read("b", 1900), read("c", 1950)]);
      expect(pruneHistory([read("a", 1), read("b", 2), read("c", 3)], 3, 2))
        .toEqual([read("b", 2), read("c", 3)]);
    });
  });
  ```
- [ ] Run it: `pnpm test tests/barcode/quorum.test.ts` — expect `Failed to resolve import "@/lib/barcode/quorum"`.
- [ ] Write `lib/barcode/quorum.ts`:
  ```ts
  /**
   * A scanner that trusts one frame reads the wrong digit off a curved pouch. This is the whole
   * defence: the same text has to come back at least `quorum` times inside 1500 ms, and any
   * different text in between starts the run over (spec "Engines and logic").
   *
   * Pure: the caller owns the history array, so the sheet can keep it in a ref and this file
   * stays unit-testable with no timers.
   */
  export type Reading = { text: string; format: string; at: number };

  export const QUORUM_WINDOW_MS = 1500;
  export const DEFAULT_QUORUM = 2;

  /**
   * The text when the trailing run of identical readings (including `next`) reaches the quorum
   * inside the window, otherwise null. The walk stops at the first reading that disagrees, which
   * is what "a different text resets" means.
   */
  export function acceptReading(
    history: Reading[],
    next: Reading,
    quorum: number = DEFAULT_QUORUM
  ): string | null {
    let count = 1;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const prior = history[i];
      if (prior.text !== next.text) break;
      if (next.at - prior.at > QUORUM_WINDOW_MS) break;
      count += 1;
      if (count >= quorum) return next.text;
    }
    return count >= quorum ? next.text : null;
  }

  /** Keep the history bounded: inside the window, and at most `keep` entries. */
  export function pruneHistory(history: Reading[], now: number, keep = 10): Reading[] {
    const fresh = history.filter((r) => now - r.at <= QUORUM_WINDOW_MS);
    return fresh.length > keep ? fresh.slice(fresh.length - keep) : fresh;
  }
  ```
- [ ] Run it: `pnpm test tests/barcode/quorum.test.ts` — expect PASS (6 tests).
- [ ] Commit: `git add lib/barcode/quorum.ts tests/barcode/quorum.test.ts && git commit -m "feat(barcode): quorum over repeated barcode readings"`

---

## Task 3 — The Open Food Facts fetcher

**Files**
- Create: `lib/catalog/off.ts`
- Test: `tests/barcode/off.test.ts`

**Interfaces**
- Consumes: `providerCode(gtin14)` from `lib/barcode/gtin.ts` (Task 1).
- Produces:
  ```ts
  export const OFF_HOST = "world.openfoodfacts.org";
  export const OFF_USER_AGENT = "SashaMealCompanion/0.1 (https://sasha-meal-companion.vercel.app)";
  export const OFF_FIELDS: readonly string[];
  export const PROVIDER_TIMEOUT_MS = 5000;
  export type ProviderFailure = { status: number | "timeout" };
  export type OffNutriments = Record<string, number | string | undefined>;
  export type OffProduct = {
    product_name?: string; brands?: string; quantity?: string; serving_size?: string;
    serving_quantity?: number | string; ingredients_text?: string; allergens_tags?: string[];
    traces_tags?: string[]; categories_tags?: string[]; nutriments?: OffNutriments;
  };
  export function isProviderFailure(r: unknown): r is ProviderFailure;
  export async function fetchOffProduct(gtin14: string, deps?: { fetchFn?: typeof fetch }): Promise<OffProduct | ProviderFailure>;
  ```
  Contracts §2 writes the failure union as `{ status: 404 | 429 | 5xx | "timeout" }`; `5xx` is not a TypeScript literal, so it is spelled `number | "timeout"` here. Same meaning, no rename.

**Steps**

- [ ] Write the failing test `tests/barcode/off.test.ts`:
  ```ts
  import { describe, expect, it, vi } from "vitest";
  import { fetchOffProduct, isProviderFailure, OFF_FIELDS, OFF_USER_AGENT } from "@/lib/catalog/off";

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  const PRODUCT = { product_name: "Dark chocolate bar", brands: "Kind", nutriments: { "energy-kcal_100g": 560 } };

  describe("fetchOffProduct", () => {
    it("asks world.openfoodfacts.org for exactly the reviewed field list", async () => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 1, product: PRODUCT }));
      const got = await fetchOffProduct("04006381333931", { fetchFn: fetchFn as unknown as typeof fetch });
      expect(got).toEqual(PRODUCT);
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        `https://world.openfoodfacts.org/api/v2/product/4006381333931.json?fields=${OFF_FIELDS.join(",")}`
      );
      expect(OFF_FIELDS).toEqual([
        "nutriments", "serving_quantity", "serving_size", "product_name", "brands",
        "quantity", "ingredients_text", "allergens_tags", "traces_tags", "categories_tags",
      ]);
      expect(OFF_FIELDS).not.toContain("image_front_url");
      expect((init.headers as Record<string, string>)["user-agent"]).toBe(OFF_USER_AGENT);
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("treats OFF's status:0 body as a 404", async () => {
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 0 }));
      expect(await fetchOffProduct("04006381333931", { fetchFn: fetchFn as unknown as typeof fetch }))
        .toEqual({ status: 404 });
    });

    it.each([[404], [429], [503]])("passes a %i through as a failure", async (status) => {
      const fetchFn = vi.fn().mockResolvedValue(new Response("", { status }));
      expect(await fetchOffProduct("04006381333931", { fetchFn: fetchFn as unknown as typeof fetch }))
        .toEqual({ status });
    });

    it("reports a thrown fetch (timeout, abort, DNS, refused redirect) as a timeout", async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error("aborted"));
      expect(await fetchOffProduct("04006381333931", { fetchFn: fetchFn as unknown as typeof fetch }))
        .toEqual({ status: "timeout" });
    });

    it("reports an unparseable body as 502 rather than throwing", async () => {
      const fetchFn = vi.fn().mockResolvedValue(new Response("<html>", { status: 200 }));
      expect(await fetchOffProduct("04006381333931", { fetchFn: fetchFn as unknown as typeof fetch }))
        .toEqual({ status: 502 });
    });

    it("isProviderFailure separates the two arms", () => {
      expect(isProviderFailure({ status: 404 })).toBe(true);
      expect(isProviderFailure(PRODUCT)).toBe(false);
    });
  });
  ```
- [ ] Run it: `pnpm test tests/barcode/off.test.ts` — expect `Failed to resolve import "@/lib/catalog/off"`.
- [ ] Write `lib/catalog/off.ts`:
  ```ts
  /**
   * One of the two modules in this repository that reach a provider (spec "Security": egress is an
   * allowlist). Everything that keeps that promise lives here: the host is a constant, the URL is
   * built from it plus 14 validated digits, redirects off the host are refused by fetch itself,
   * the request dies after 5 s, and no image or media URL from the payload is ever requested —
   * the field list does not even ask for one.
   *
   * OFF etiquette (architecture §7.3): cache first, one read at a time, an identifying User-Agent
   * naming the app and a contact address.
   */
  import { providerCode } from "@/lib/barcode/gtin";

  export const OFF_HOST = "world.openfoodfacts.org";
  export const OFF_USER_AGENT = "SashaMealCompanion/0.1 (https://sasha-meal-companion.vercel.app)";
  export const PROVIDER_TIMEOUT_MS = 5000;

  /** fud-ai review §2, minus every image and score field we have no use for. */
  export const OFF_FIELDS = [
    "nutriments", "serving_quantity", "serving_size", "product_name", "brands",
    "quantity", "ingredients_text", "allergens_tags", "traces_tags", "categories_tags",
  ] as const;

  export type ProviderFailure = { status: number | "timeout" };
  export type OffNutriments = Record<string, number | string | undefined>;

  export type OffProduct = {
    product_name?: string; brands?: string; quantity?: string; serving_size?: string;
    serving_quantity?: number | string; ingredients_text?: string; allergens_tags?: string[];
    traces_tags?: string[]; categories_tags?: string[]; nutriments?: OffNutriments;
  };

  export function isProviderFailure(r: unknown): r is ProviderFailure {
    return typeof r === "object" && r !== null && "status" in r;
  }

  export async function fetchOffProduct(
    gtin14: string,
    deps: { fetchFn?: typeof fetch } = {}
  ): Promise<OffProduct | ProviderFailure> {
    const doFetch = deps.fetchFn ?? fetch;
    const url =
      `https://${OFF_HOST}/api/v2/product/${providerCode(gtin14)}.json?fields=${OFF_FIELDS.join(",")}`;
    if (new URL(url).host !== OFF_HOST) return { status: 400 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(url, {
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
        headers: { "user-agent": OFF_USER_AGENT, accept: "application/json" },
      });
    } catch {
      return { status: "timeout" };
    } finally {
      clearTimeout(timer);
    }
    if (res.status !== 200) return { status: res.status };
    let body: { status?: number; product?: OffProduct };
    try {
      body = (await res.json()) as { status?: number; product?: OffProduct };
    } catch {
      return { status: 502 };
    }
    if (body.status !== 1 || !body.product) return { status: 404 };
    return body.product;
  }
  ```
- [ ] Run it: `pnpm test tests/barcode/off.test.ts` — expect PASS (8 tests).
- [ ] Commit: `git add lib/catalog/off.ts tests/barcode/off.test.ts && git commit -m "feat(catalog): typed Open Food Facts fetcher on an allowlisted host"`

---

## Task 4 — The FDC Branded fetcher

**Files**
- Create: `lib/catalog/fdc.ts`
- Test: `tests/barcode/fdc.test.ts`

**Interfaces**
- Consumes: `normalizeGtin`, `providerCode` (Task 1); `ProviderFailure`, `PROVIDER_TIMEOUT_MS`, `isProviderFailure` from `lib/catalog/off.ts` (Task 3); `process.env.FDC_API_KEY` (contracts §6).
- Produces:
  ```ts
  export const FDC_HOST = "api.nal.usda.gov";
  export type FdcNutrient = { nutrientId: number; nutrientName?: string; unitName?: string; value?: number };
  export type FdcBrandedFood = {
    fdcId: number; description: string; brandOwner?: string; brandName?: string; gtinUpc?: string;
    ingredients?: string; servingSize?: number; servingSizeUnit?: string;
    householdServingFullText?: string; publishedDate?: string; foodNutrients?: FdcNutrient[];
  };
  export async function fetchFdcBranded(gtin14: string, deps?: { fetchFn?: typeof fetch }): Promise<FdcBrandedFood | ProviderFailure>;
  ```

**Steps**

- [ ] Write the failing test `tests/barcode/fdc.test.ts`:
  ```ts
  import { afterEach, describe, expect, it, vi } from "vitest";
  import { fetchFdcBranded } from "@/lib/catalog/fdc";

  const FOOD = {
    fdcId: 123456, description: "DARK CHOCOLATE NUTS & SEA SALT", brandName: "KIND",
    gtinUpc: "0602652171000", foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 560 }],
  };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  afterEach(() => { delete process.env.FDC_API_KEY; vi.restoreAllMocks(); });

  describe("fetchFdcBranded", () => {
    it("searches Branded by the provider code and sends the key as a header", async () => {
      process.env.FDC_API_KEY = "test-key";
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ foods: [FOOD] }));
      const got = await fetchFdcBranded("00602652171000", { fetchFn: fetchFn as unknown as typeof fetch });
      expect(got).toEqual(FOOD);
      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "https://api.nal.usda.gov/fdc/v1/foods/search?query=0602652171000&dataType=Branded&pageSize=5"
      );
      expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
      expect(url).not.toContain("api_key");
      expect(init.redirect).toBe("error");
    });

    it("keeps only a food whose gtinUpc normalises to the same GTIN-14", async () => {
      process.env.FDC_API_KEY = "test-key";
      const other = { ...FOOD, fdcId: 9, gtinUpc: "4006381333931" };
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ foods: [other, FOOD] }));
      expect(await fetchFdcBranded("00602652171000", { fetchFn: fetchFn as unknown as typeof fetch }))
        .toEqual(FOOD);
    });

    it("is a 404 when no returned food carries that GTIN", async () => {
      process.env.FDC_API_KEY = "test-key";
      const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ foods: [] }));
      expect(await fetchFdcBranded("00602652171000", { fetchFn: fetchFn as unknown as typeof fetch }))
        .toEqual({ status: 404 });
    });

    it("is a 401 with no FDC_API_KEY, and never calls out", async () => {
      const fetchFn = vi.fn();
      expect(await fetchFdcBranded("00602652171000", { fetchFn: fetchFn as unknown as typeof fetch }))
        .toEqual({ status: 401 });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("maps a throw to a timeout and a non-200 to its status", async () => {
      process.env.FDC_API_KEY = "test-key";
      const thrower = vi.fn().mockRejectedValue(new Error("aborted"));
      expect(await fetchFdcBranded("00602652171000", { fetchFn: thrower as unknown as typeof fetch }))
        .toEqual({ status: "timeout" });
      const failing = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
      expect(await fetchFdcBranded("00602652171000", { fetchFn: failing as unknown as typeof fetch }))
        .toEqual({ status: 429 });
    });
  });
  ```
- [ ] Run it: `pnpm test tests/barcode/fdc.test.ts` — expect `Failed to resolve import "@/lib/catalog/fdc"`.
- [ ] Write `lib/catalog/fdc.ts`:
  ```ts
  /**
   * The second and last module that reaches a provider. Same rules as lib/catalog/off.ts: one
   * constant host, a URL built from it plus validated digits, refused redirects, a 5 s abort, no
   * media URL ever fetched.
   *
   * The key travels in the X-Api-Key header, not the api_key query parameter FDC also accepts, so
   * it never lands in an access log or a referrer. It is read from the environment on every call
   * and is never logged (contracts §6).
   */
  import { normalizeGtin, providerCode } from "@/lib/barcode/gtin";
  import { PROVIDER_TIMEOUT_MS, type ProviderFailure } from "@/lib/catalog/off";

  export const FDC_HOST = "api.nal.usda.gov";

  export type FdcNutrient = {
    nutrientId: number; nutrientName?: string; unitName?: string; value?: number;
  };

  export type FdcBrandedFood = {
    fdcId: number; description: string; brandOwner?: string; brandName?: string; gtinUpc?: string;
    ingredients?: string; servingSize?: number; servingSizeUnit?: string;
    householdServingFullText?: string; publishedDate?: string; foodNutrients?: FdcNutrient[];
  };

  export async function fetchFdcBranded(
    gtin14: string,
    deps: { fetchFn?: typeof fetch } = {}
  ): Promise<FdcBrandedFood | ProviderFailure> {
    const key = process.env.FDC_API_KEY;
    if (!key) return { status: 401 };
    const doFetch = deps.fetchFn ?? fetch;
    const url =
      `https://${FDC_HOST}/fdc/v1/foods/search?query=${providerCode(gtin14)}&dataType=Branded&pageSize=5`;
    if (new URL(url).host !== FDC_HOST) return { status: 400 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(url, {
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
        headers: { "x-api-key": key, accept: "application/json" },
      });
    } catch {
      return { status: "timeout" };
    } finally {
      clearTimeout(timer);
    }
    if (res.status !== 200) return { status: res.status };
    let body: { foods?: FdcBrandedFood[] };
    try {
      body = (await res.json()) as { foods?: FdcBrandedFood[] };
    } catch {
      return { status: 502 };
    }
    const hit = (body.foods ?? []).find((f) => normalizeGtin(f.gtinUpc ?? "") === gtin14);
    return hit ?? { status: 404 };
  }
  ```
- [ ] Run it: `pnpm test tests/barcode/fdc.test.ts` — expect PASS (5 tests).
- [ ] Commit: `git add lib/catalog/fdc.ts tests/barcode/fdc.test.ts && git commit -m "feat(catalog): typed FDC Branded fetcher behind the X-Api-Key header"`

---

## Task 5 — OFF product → RevisionDraft

**Files**
- Create: `lib/catalog/off-map.ts`
- Test: `tests/barcode/off-map.test.ts`

**Interfaces**
- Consumes: `OffProduct`, `OffNutriments` from `lib/catalog/off.ts` (Task 3); `NutrientCode`, `NUTRIENT_CODES` from `lib/nutrients/codes.ts` (landed, Phase 1–2 contracts §2).
- Produces (contracts §2, verbatim shape):
  ```ts
  export type RevisionDraft = {
    description: string; brand: string | null; qualityClass: "crowd" | "label";
    per100g: Record<NutrientCode, number | null>;
    portions: { description: string; gramWeight: number }[];
    ingredients: { seq: number; name: string; allergenTags: string[] }[];
    ingredientsText: string | null;
    qualityFlags: string[]; sourceId: string; publishedAt: string;
  };
  export function emptyPer100g(): Record<NutrientCode, number | null>;
  export function atwaterKcal(p: Record<NutrientCode, number | null>): { kcal: number | null; complete: boolean };
  export function splitIngredients(text: string | null): string[];
  export function scanAllergens(text: string): string[];
  export function energyFlags(reported: number | null, calc: number | null): string[];
  export function offToRevision(p: OffProduct, fetchedAt: string): RevisionDraft | { reject: string };
  ```
  `lib/catalog/fdc-map.ts` re-exports `RevisionDraft` from here rather than declaring a second copy (contracts §2 lists the type under both files; one declaration, two exports).

**Steps**

- [ ] Write the failing test `tests/barcode/off-map.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { atwaterKcal, emptyPer100g, offToRevision, scanAllergens, splitIngredients } from "@/lib/catalog/off-map";
  import type { OffProduct } from "@/lib/catalog/off";

  const FETCHED = "2026-09-19T12:00:00.000Z";

  const POUCH: OffProduct = {
    product_name: "Apple & blueberry pouch",
    brands: "Ella's Kitchen, Ellas",
    serving_quantity: "90",
    serving_size: "1 pouch (90 g)",
    ingredients_text: "Apple juice concentrate, blueberry puree, water",
    allergens_tags: [],
    nutriments: {
      "energy-kcal_100g": 60, proteins_100g: 0.4, carbohydrates_100g: 13.5,
      fat_100g: 0.2, fiber_100g: 1.4, sugars_100g: 12.6, salt_100g: 0.03,
    },
  };

  describe("offToRevision", () => {
    it("tags apple from the ingredient text even when OFF declares no allergen", () => {
      const draft = offToRevision(POUCH, FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.ingredients[0]).toEqual({
        seq: 1, name: "Apple juice concentrate", allergenTags: ["apple"],
      });
      expect(draft.ingredientsText).toBe("Apple juice concentrate, blueberry puree, water");
      expect(draft.description).toBe("Apple & blueberry pouch");
      expect(draft.brand).toBe("Ella's Kitchen");
      expect(draft.qualityClass).toBe("crowd");
      expect(draft.portions).toEqual([{ description: "1 pouch (90 g)", gramWeight: 90 }]);
    });

    it("rejects a product with no energy and no macros", () => {
      expect(offToRevision({ product_name: "Mystery", nutriments: {} }, FETCHED))
        .toEqual({ reject: "no_nutrition" });
      expect(offToRevision({ product_name: "Mystery" }, FETCHED))
        .toEqual({ reject: "no_nutrition" });
    });

    it("converts kJ-only energy and flags where the number came from", () => {
      const draft = offToRevision(
        { product_name: "Bar", nutriments: { energy_100g: 2343, proteins_100g: 10 } }, FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.per100g.energy_kcal).toBe(559.977);
      expect(draft.qualityFlags).toContain("off_energy_from_kj");
    });

    it("derives sodium from salt when sodium is absent", () => {
      const draft = offToRevision(
        { product_name: "Crisps", nutriments: { salt_100g: 1.25, proteins_100g: 6 } }, FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.per100g.sodium).toBe(500);
      expect(draft.qualityFlags).toContain("sodium_from_salt");
    });

    it("prefers a reported sodium over salt and leaves absent micros null, never 0", () => {
      const draft = offToRevision(
        { product_name: "Crisps", nutriments: { sodium_100g: 0.4, salt_100g: 1.25, proteins_100g: 6 } },
        FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.per100g.sodium).toBe(400);
      expect(draft.per100g.iron).toBeNull();
      expect(draft.per100g.vitamin_d).toBeNull();
      expect(draft.qualityFlags).not.toContain("sodium_from_salt");
    });

    it("flags energy_mismatch when the label kcal and Atwater disagree by over 10 %", () => {
      const draft = offToRevision({
        product_name: "Suspicious bar",
        nutriments: {
          "energy-kcal_100g": 250, proteins_100g: 10, carbohydrates_100g: 40,
          fat_100g: 20, fiber_100g: 0,
        },
      }, FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.per100g.energy_kcal_calc).toBe(380);
      expect(draft.qualityFlags).toContain("energy_mismatch");
    });

    it("does not flag a mismatch when Atwater is incomplete", () => {
      const draft = offToRevision(
        { product_name: "Bar", nutriments: { "energy-kcal_100g": 250, proteins_100g: 10 } }, FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.per100g.energy_kcal_calc).toBeNull();
      expect(draft.qualityFlags).toContain("atwater_incomplete");
      expect(draft.qualityFlags).not.toContain("energy_mismatch");
    });

    it("carries OFF's own allergen and trace tags as a seq-0 row", () => {
      const draft = offToRevision({
        product_name: "Cookie", allergens_tags: ["en:gluten", "en:milk"], traces_tags: ["en:nuts"],
        ingredients_text: "Wheat flour, butter",
        nutriments: { "energy-kcal_100g": 480, proteins_100g: 6 },
      }, FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.ingredients[0]).toEqual({
        seq: 0, name: "Contains: gluten, dairy, nuts", allergenTags: ["gluten", "dairy", "nuts"],
      });
      expect(draft.ingredients[1]).toEqual({ seq: 1, name: "Wheat flour", allergenTags: ["gluten"] });
      expect(draft.qualityFlags).toContain("allergens_from_tags");
      expect(draft.sourceId).toBe("");
      expect(draft.publishedAt).toBe(FETCHED);
    });
  });

  describe("scanAllergens", () => {
    it.each([
      ["Wheat flour", ["gluten"]],
      ["Whey protein concentrate", ["dairy"]],
      ["Sodium caseinate", ["dairy"]],
      ["Apple juice concentrate", ["apple"]],
      ["Pineapple juice", []],
      ["Malic acid", []],
      ["Almond milk", []],
      ["Gluten-free oats", []],
      ["Sunflower seed butter", []],
    ])("reads %s as %j", (text, expected) => {
      expect(scanAllergens(text)).toEqual(expected);
    });
  });

  describe("splitIngredients", () => {
    it("splits on top-level commas only and drops empties", () => {
      expect(splitIngredients("Oats, chocolate (cocoa mass, sugar), salt"))
        .toEqual(["Oats", "chocolate (cocoa mass, sugar)", "salt"]);
      expect(splitIngredients(null)).toEqual([]);
      expect(splitIngredients("  ,  ")).toEqual([]);
    });
  });

  describe("atwaterKcal", () => {
    it("uses available carbohydrate when fiber is reported", () => {
      const p = emptyPer100g();
      p.protein = 10; p.carbohydrate = 40; p.fat_total = 20; p.fiber_total = 5;
      expect(atwaterKcal(p)).toEqual({ kcal: 360, complete: true });
    });

    it("is incomplete when any of protein, carbohydrate or fat is null", () => {
      const p = emptyPer100g();
      p.protein = 10; p.carbohydrate = 40;
      expect(atwaterKcal(p)).toEqual({ kcal: null, complete: false });
    });
  });
  ```
- [ ] Run it: `pnpm test tests/barcode/off-map.test.ts` — expect `Failed to resolve import "@/lib/catalog/off-map"`.
- [ ] Write `lib/catalog/off-map.ts`:
  ```ts
  /**
   * OFF product → RevisionDraft. Three rules decide everything in this file.
   *
   * 1. `null` is not `0` (architecture §3.1). A nutrient OFF did not report stays null, and the
   *    rest of the app reads that as "not measured", never as a measured zero.
   * 2. A product with no energy AND no protein AND no carbohydrate AND no fat is useless as a log
   *    line, so it is rejected rather than written half-empty (fud-ai review §2, same rule).
   * 3. The apple trap in targets.md §5 is why the ingredient text is scanned as well as the
   *    allergens field: an OFF pouch with apple juice concentrate in the list often declares no
   *    allergen at all, and she has to see it before she logs it.
   *
   * Provider text is data, never instruction (contracts §10): every string here is stored and
   * rendered as text and is never interpolated into SQL or a prompt.
   */
  import type { OffNutriments, OffProduct } from "@/lib/catalog/off";
  import { NUTRIENT_CODES, type NutrientCode } from "@/lib/nutrients/codes";

  export type RevisionDraft = {
    description: string;
    brand: string | null;
    qualityClass: "crowd" | "label";
    per100g: Record<NutrientCode, number | null>;
    portions: { description: string; gramWeight: number }[];
    ingredients: { seq: number; name: string; allergenTags: string[] }[];
    ingredientsText: string | null;
    qualityFlags: string[];
    sourceId: string;
    publishedAt: string;
  };

  export function emptyPer100g(): Record<NutrientCode, number | null> {
    const out = {} as Record<NutrientCode, number | null>;
    for (const code of NUTRIENT_CODES) out[code] = null;
    return out;
  }

  export function round4(n: number): number {
    return Math.round(n * 10_000) / 10_000;
  }

  function num(v: number | string | undefined): number | null {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v !== "string" || v.trim() === "") return null;
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** OFF reports grams per 100 g; our canonical unit is mg for minerals and µg for D, B12, A, folate. */
  const OFF_DIRECT: { code: NutrientCode; key: string; factor: number }[] = [
    { code: "protein", key: "proteins_100g", factor: 1 },
    { code: "carbohydrate", key: "carbohydrates_100g", factor: 1 },
    { code: "fat_total", key: "fat_100g", factor: 1 },
    { code: "fiber_total", key: "fiber_100g", factor: 1 },
    { code: "sugars_total", key: "sugars_100g", factor: 1 },
    { code: "saturated_fat", key: "saturated-fat_100g", factor: 1 },
    { code: "cholesterol", key: "cholesterol_100g", factor: 1000 },
    { code: "potassium", key: "potassium_100g", factor: 1000 },
    { code: "calcium", key: "calcium_100g", factor: 1000 },
    { code: "iron", key: "iron_100g", factor: 1000 },
    { code: "magnesium", key: "magnesium_100g", factor: 1000 },
    { code: "zinc", key: "zinc_100g", factor: 1000 },
    { code: "vitamin_c", key: "vitamin-c_100g", factor: 1000 },
    { code: "vitamin_d", key: "vitamin-d_100g", factor: 1_000_000 },
    { code: "vitamin_b12", key: "vitamin-b12_100g", factor: 1_000_000 },
    { code: "folate_dfe", key: "folates_100g", factor: 1_000_000 },
    { code: "vitamin_a_rae", key: "vitamin-a_100g", factor: 1_000_000 },
  ];

  const KJ_TO_KCAL = 0.239;

  function readNutriments(n: OffNutriments): { per100g: Record<NutrientCode, number | null>; flags: string[] } {
    const per100g = emptyPer100g();
    const flags: string[] = [];
    for (const { code, key, factor } of OFF_DIRECT) {
      const value = num(n[key]);
      if (value !== null) per100g[code] = round4(value * factor);
    }
    const kcal = num(n["energy-kcal_100g"]);
    const kj = num(n.energy_100g);
    if (kcal !== null) {
      per100g.energy_kcal = round4(kcal);
    } else if (kj !== null) {
      per100g.energy_kcal = round4(kj * KJ_TO_KCAL);
      flags.push("off_energy_from_kj");
    }
    const sodium = num(n.sodium_100g);
    const salt = num(n.salt_100g);
    if (sodium !== null) {
      per100g.sodium = round4(sodium * 1000);
    } else if (salt !== null) {
      per100g.sodium = round4((salt / 2.5) * 1000);
      flags.push("sodium_from_salt");
    }
    if (per100g.folate_dfe !== null) flags.push("folate_not_dfe");
    if (per100g.vitamin_a_rae !== null) flags.push("vitamin_a_not_rae");
    return { per100g, flags };
  }

  /** Architecture §3.1: 4/4/9 on protein, available carbohydrate and fat. Incomplete stays null. */
  export function atwaterKcal(
    p: Record<NutrientCode, number | null>
  ): { kcal: number | null; complete: boolean } {
    const { protein, carbohydrate, fat_total: fat, fiber_total: fiber } = p;
    if (protein === null || carbohydrate === null || fat === null) {
      return { kcal: null, complete: false };
    }
    const available = fiber === null ? carbohydrate : Math.max(carbohydrate - fiber, 0);
    return { kcal: Math.round(4 * protein + 4 * available + 9 * fat), complete: true };
  }

  /** `energy_mismatch` only when both numbers exist: an incomplete Atwater is excluded (§3.1). */
  export function energyFlags(reported: number | null, calc: number | null): string[] {
    if (calc === null) return ["atwater_incomplete"];
    if (reported === null) return [];
    return Math.abs(calc - reported) / Math.max(reported, 1) > 0.1 ? ["energy_mismatch"] : [];
  }

  /** Top-level commas only, so "chocolate (cocoa mass, sugar)" stays one ingredient. */
  export function splitIngredients(text: string | null): string[] {
    if (!text) return [];
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of text) {
      if (ch === "(" || ch === "[") depth += 1;
      if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    parts.push(current);
    return parts.map((p) => p.trim()).filter((p) => p.length > 0).slice(0, 60);
  }

  /* The three she cannot eat (targets.md §5, architecture §4.4 default profile). The `_OK` lists
     are the same exclusions lib/catalog-client.ts uses, so a scanned row and a searched row mark
     the same food the same way. "Malic acid" is deliberately not an apple word. */
  const GLUTEN = /\b(gluten|wheat|barley|rye|spelt|semolina|farro|malt extract)\b/i;
  const GLUTEN_OK = /\b(gluten[- ]free|rice noodles|corn tortilla|buckwheat|quinoa)\b/i;
  const DAIRY = /\b(milk|whey|casein|caseinate|lactose|cheese|yogurt|cream|butterfat|ghee)\b/i;
  const DAIRY_OK =
    /\b(almond milk|oat milk|soy milk|rice milk|coconut milk|coconut cream|peanut butter|almond butter|cashew butter|sunflower seed butter|cocoa butter|shea butter)\b/i;
  const APPLE = /\bapple/i;

  export function scanAllergens(text: string): string[] {
    const out: string[] = [];
    if (GLUTEN.test(text) && !GLUTEN_OK.test(text)) out.push("gluten");
    if (DAIRY.test(text) && !DAIRY_OK.test(text)) out.push("dairy");
    if (APPLE.test(text)) out.push("apple");
    return out;
  }

  /** "en:milk" → "dairy"; anything outside our vocabulary keeps its bare OFF name. */
  const TAG_ALIASES: Record<string, string> = {
    milk: "dairy", lactose: "dairy", wheat: "gluten", barley: "gluten", rye: "gluten",
    spelt: "gluten", kamut: "gluten", "en:milk": "dairy", "en:gluten": "gluten",
  };

  export function mapAllergenTags(tags: readonly string[]): string[] {
    const out: string[] = [];
    for (const raw of tags) {
      const bare = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
      const mapped = TAG_ALIASES[bare] ?? bare;
      if (mapped.length > 0 && !out.includes(mapped)) out.push(mapped);
    }
    return out;
  }

  /**
   * Ingredient rows. Seq 0, when present, is the provider's own declared-allergen line — it reads
   * like the "Contains:" line on a label and gives the policy something to judge when the product
   * ships no ingredient text at all. Real ingredients start at seq 1.
   */
  export function ingredientRows(
    ingredientsText: string | null,
    declaredTags: string[]
  ): { rows: RevisionDraft["ingredients"]; flags: string[] } {
    const rows: RevisionDraft["ingredients"] = [];
    const flags: string[] = [];
    if (declaredTags.length > 0) {
      rows.push({ seq: 0, name: `Contains: ${declaredTags.join(", ")}`, allergenTags: declaredTags });
      flags.push("allergens_from_tags");
    }
    splitIngredients(ingredientsText).forEach((name, i) => {
      rows.push({ seq: i + 1, name, allergenTags: scanAllergens(name) });
    });
    return { rows, flags };
  }

  function firstBrand(brands: string | undefined): string | null {
    const first = (brands ?? "").split(",")[0]?.trim();
    return first && first.length > 0 ? first : null;
  }

  export function offToRevision(p: OffProduct, fetchedAt: string): RevisionDraft | { reject: string } {
    const { per100g, flags } = readNutriments(p.nutriments ?? {});
    if (
      per100g.energy_kcal === null && per100g.protein === null &&
      per100g.carbohydrate === null && per100g.fat_total === null
    ) {
      return { reject: "no_nutrition" };
    }
    const atwater = atwaterKcal(per100g);
    per100g.energy_kcal_calc = atwater.kcal;
    if (atwater.complete && per100g.fiber_total === null) flags.push("carb_basis_total");
    flags.push(...energyFlags(per100g.energy_kcal, atwater.kcal));

    const declared = mapAllergenTags([...(p.allergens_tags ?? []), ...(p.traces_tags ?? [])]);
    const ingredientsText = p.ingredients_text?.trim() || null;
    const { rows, flags: rowFlags } = ingredientRows(ingredientsText, declared);

    const servingGrams = num(p.serving_quantity);
    const portions =
      servingGrams !== null && servingGrams > 0
        ? [{ description: p.serving_size?.trim() || `${servingGrams} g`, gramWeight: round4(servingGrams) }]
        : [];

    return {
      description: p.product_name?.trim() || firstBrand(p.brands) || "Scanned product",
      brand: firstBrand(p.brands),
      qualityClass: "crowd",
      per100g,
      portions,
      ingredients: rows,
      ingredientsText,
      qualityFlags: [...new Set([...flags, ...rowFlags])],
      sourceId: "",
      publishedAt: fetchedAt,
    };
  }
  ```
  `sourceId` is filled by `lib/server/barcode.ts` with the GTIN-14 before the draft reaches the writer — the mapper never sees the key, so a provider payload can never choose an identity.
- [ ] Run it: `pnpm test tests/barcode/off-map.test.ts` — expect PASS (8 + 9 + 3 + 2 assertions across 4 describes).
- [ ] Commit: `git add lib/catalog/off-map.ts tests/barcode/off-map.test.ts && git commit -m "feat(catalog): map an OFF product to a revision draft"`

---

## Task 6 — FDC Branded food → RevisionDraft

**Files**
- Create: `lib/catalog/fdc-map.ts`
- Test: `tests/barcode/fdc-map.test.ts`

**Interfaces**
- Consumes: `FdcBrandedFood`, `FdcNutrient` (Task 4); `RevisionDraft`, `emptyPer100g`, `atwaterKcal`, `energyFlags`, `ingredientRows`, `round4` (Task 5); `NutrientCode`.
- Produces:
  ```ts
  export type { RevisionDraft } from "@/lib/catalog/off-map";
  export const FDC_NUTRIENT_CODES: Record<number, NutrientCode>;
  export function convertAmount(value: number, unitName: string, code: NutrientCode): number | null;
  export function fdcBrandedToRevision(f: FdcBrandedFood, fetchedAt: string): RevisionDraft | { reject: string };
  ```

**Steps**

- [ ] Write the failing test `tests/barcode/fdc-map.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { convertAmount, fdcBrandedToRevision } from "@/lib/catalog/fdc-map";
  import type { FdcBrandedFood } from "@/lib/catalog/fdc";

  const FETCHED = "2026-09-19T12:00:00.000Z";

  const BAR: FdcBrandedFood = {
    fdcId: 123456, description: "DARK CHOCOLATE NUTS & SEA SALT", brandName: "KIND",
    brandOwner: "KIND LLC", gtinUpc: "0602652171000", publishedDate: "2026-04-01",
    ingredients: "ALMONDS, WHEY PROTEIN, CHICORY ROOT FIBER", servingSize: 40,
    servingSizeUnit: "g", householdServingFullText: "1 bar",
    foodNutrients: [
      { nutrientId: 1008, unitName: "KCAL", value: 500 },
      { nutrientId: 1003, unitName: "G", value: 15 },
      { nutrientId: 1005, unitName: "G", value: 40 },
      { nutrientId: 1004, unitName: "G", value: 30 },
      { nutrientId: 1079, unitName: "G", value: 17.5 },
      { nutrientId: 1093, unitName: "MG", value: 350 },
      { nutrientId: 1089, unitName: "MG", value: 4 },
      { nutrientId: 1114, unitName: "UG", value: 2.5 },
      { nutrientId: 9999, unitName: "G", value: 1 },
    ],
  };

  describe("fdcBrandedToRevision", () => {
    it("maps the nutrient-id table, keeps the label class and reads the household portion", () => {
      const draft = fdcBrandedToRevision(BAR, FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.qualityClass).toBe("label");
      expect(draft.description).toBe("DARK CHOCOLATE NUTS & SEA SALT");
      expect(draft.brand).toBe("KIND");
      expect(draft.per100g.energy_kcal).toBe(500);
      expect(draft.per100g.protein).toBe(15);
      expect(draft.per100g.sodium).toBe(350);
      expect(draft.per100g.iron).toBe(4);
      expect(draft.per100g.vitamin_d).toBe(2.5);
      expect(draft.per100g.energy_kcal_calc).toBe(520);
      expect(draft.per100g.zinc).toBeNull();
      expect(draft.portions).toEqual([{ description: "1 bar", gramWeight: 40 }]);
      expect(draft.publishedAt).toBe("2026-04-01");
    });

    it("tags dairy from the ingredient list", () => {
      const draft = fdcBrandedToRevision(BAR, FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.ingredients[1]).toEqual({ seq: 2, name: "WHEY PROTEIN", allergenTags: ["dairy"] });
      expect(draft.ingredientsText).toBe("ALMONDS, WHEY PROTEIN, CHICORY ROOT FIBER");
    });

    it("rejects a food with none of the four", () => {
      expect(fdcBrandedToRevision({ fdcId: 1, description: "X", foodNutrients: [] }, FETCHED))
        .toEqual({ reject: "no_nutrition" });
    });

    it("ignores a serving size that is not grams and falls back to fetchedAt", () => {
      const draft = fdcBrandedToRevision(
        { ...BAR, servingSizeUnit: "ml", publishedDate: undefined }, FETCHED);
      if ("reject" in draft) throw new Error(draft.reject);
      expect(draft.portions).toEqual([]);
      expect(draft.publishedAt).toBe(FETCHED);
    });
  });

  describe("convertAmount", () => {
    it.each([
      [1, "G", "sodium", 1000],
      [1000, "UG", "sodium", 1],
      [2, "MG", "vitamin_d", 2000],
      [5, "G", "protein", 5],
      [5, "IU", "vitamin_d", null],
    ])("converts %s %s for %s", (value, unit, code, expected) => {
      expect(convertAmount(value as number, unit as string, code as never)).toBe(expected);
    });
  });
  ```
- [ ] Run it: `pnpm test tests/barcode/fdc-map.test.ts` — expect `Failed to resolve import "@/lib/catalog/fdc-map"`.
- [ ] Write `lib/catalog/fdc-map.ts`:
  ```ts
  /**
   * FDC Branded → RevisionDraft. Branded rows already carry per-100 g values, so the only work is
   * the nutrient-id table, a unit conversion into our canonical units, and the same three rules
   * off-map.ts follows: null is not zero, all four absent is a reject, ingredients are scanned.
   *
   * The RevisionDraft type and every shared helper come from off-map.ts — one declaration, so the
   * two mappers can never drift apart.
   */
  import type { FdcBrandedFood, FdcNutrient } from "@/lib/catalog/fdc";
  import {
    atwaterKcal, emptyPer100g, energyFlags, ingredientRows, round4, type RevisionDraft,
  } from "@/lib/catalog/off-map";
  import { NUTRIENT_UNITS, type NutrientCode } from "@/lib/nutrients/codes";

  export type { RevisionDraft } from "@/lib/catalog/off-map";

  /** FDC nutrient ids, FoodData Central's own numbering. 1190 (DFE) wins over 1177 (total). */
  export const FDC_NUTRIENT_CODES: Record<number, NutrientCode> = {
    1008: "energy_kcal", 1003: "protein", 1005: "carbohydrate", 1004: "fat_total",
    1079: "fiber_total", 2000: "sugars_total", 1063: "sugars_total", 1093: "sodium",
    1092: "potassium", 1087: "calcium", 1089: "iron", 1090: "magnesium", 1095: "zinc",
    1162: "vitamin_c", 1114: "vitamin_d", 1178: "vitamin_b12", 1177: "folate_dfe",
    1190: "folate_dfe", 1106: "vitamin_a_rae", 1258: "saturated_fat", 1253: "cholesterol",
  };

  const SCALE: Record<string, number> = { G: 1, MG: 1e-3, UG: 1e-6, KCAL: 1 };
  const TARGET: Record<string, number> = { kcal: 1, g: 1, mg: 1e-3, "µg": 1e-6 };

  /** Value in FDC's unit → the unit lib/nutrients/codes.ts pins for that code. `IU` is refused. */
  export function convertAmount(value: number, unitName: string, code: NutrientCode): number | null {
    const from = SCALE[unitName.toUpperCase()];
    const to = TARGET[NUTRIENT_UNITS[code]];
    if (from === undefined || to === undefined) return null;
    return round4((value * from) / to);
  }

  function readNutrients(list: FdcNutrient[]): Record<NutrientCode, number | null> {
    const per100g = emptyPer100g();
    for (const n of list) {
      const code = FDC_NUTRIENT_CODES[n.nutrientId];
      if (!code || typeof n.value !== "number" || !Number.isFinite(n.value)) continue;
      if (code === "folate_dfe" && n.nutrientId === 1177 && per100g.folate_dfe !== null) continue;
      const amount = convertAmount(n.value, n.unitName ?? "G", code);
      if (amount !== null) per100g[code] = amount;
    }
    return per100g;
  }

  export function fdcBrandedToRevision(
    f: FdcBrandedFood,
    fetchedAt: string
  ): RevisionDraft | { reject: string } {
    const per100g = readNutrients(f.foodNutrients ?? []);
    if (
      per100g.energy_kcal === null && per100g.protein === null &&
      per100g.carbohydrate === null && per100g.fat_total === null
    ) {
      return { reject: "no_nutrition" };
    }
    const flags: string[] = [];
    const atwater = atwaterKcal(per100g);
    per100g.energy_kcal_calc = atwater.kcal;
    if (atwater.complete && per100g.fiber_total === null) flags.push("carb_basis_total");
    flags.push(...energyFlags(per100g.energy_kcal, atwater.kcal));

    const ingredientsText = f.ingredients?.trim() || null;
    const { rows, flags: rowFlags } = ingredientRows(ingredientsText, []);

    const grams =
      typeof f.servingSize === "number" && f.servingSize > 0 &&
      (f.servingSizeUnit ?? "").toLowerCase().startsWith("g")
        ? round4(f.servingSize)
        : null;

    return {
      description: f.description.trim() || "Scanned product",
      brand: f.brandName?.trim() || f.brandOwner?.trim() || null,
      qualityClass: "label",
      per100g,
      portions: grams === null
        ? []
        : [{ description: f.householdServingFullText?.trim() || `${grams} g`, gramWeight: grams }],
      ingredients: rows,
      ingredientsText,
      qualityFlags: [...new Set([...flags, ...rowFlags])],
      sourceId: "",
      publishedAt: f.publishedDate?.trim() || fetchedAt,
    };
  }
  ```
- [ ] Run it: `pnpm test tests/barcode/fdc-map.test.ts` — expect PASS (4 + 5 cases).
- [ ] Commit: `git add lib/catalog/fdc-map.ts tests/barcode/fdc-map.test.ts && git commit -m "feat(catalog): map an FDC Branded food to a revision draft"`

---

## Task 7 — The lookup ledger and the atomic provider-write RPC

**Files**
- Create: `supabase/migrations/20260919090100_phase3_barcode_cache.sql`
- Create: `supabase/migrations/down/20260919090100_phase3_barcode_cache.down.sql`
- Test: `tests/barcode/schema.test.ts` *[needs branch]*

**Interfaces**
- Consumes: `catalog_versions`, `catalog_foods`, `catalog_food_revisions`, `catalog_food_nutrients`, `catalog_portions`, `catalog_ingredients`, `catalog_barcodes`, `catalog_nutrients` (Phase 0 `20260911000100_catalog_shell.sql`); `catalog_search_doc(text, text, text)` (`20260912090000`); `get_or_create_food_ref(uuid, text, bigint, uuid)` (`20260911000600`).
- Produces: table `catalog_barcode_lookups`, index `catalog_barcode_lookups_stale`, function `catalog_write_provider_revision(p_user_id uuid, p_source text, p_gtin14 text, p_draft jsonb) returns jsonb`.

**Steps**

- [ ] Write the failing test `tests/barcode/schema.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { hasBranch, psql, psqlExpectError } from "@/tests/catalog/helpers";

  const DRAFT = JSON.stringify({
    description: "Apple & blueberry pouch", brand: "Ella''s Kitchen", qualityClass: "crowd",
    per100g: { energy_kcal: 60, protein: 0.4, carbohydrate: 13.5, fat_total: 0.2, iron: null },
    portions: [{ description: "1 pouch (90 g)", gramWeight: 90 }],
    ingredients: [{ seq: 1, name: "Apple juice concentrate", allergenTags: ["apple"] }],
    ingredientsText: "Apple juice concentrate, blueberry puree", qualityFlags: ["energy_mismatch"],
    sourceId: "04006381333931", publishedAt: "2026-09-19T12:00:00Z",
  });

  const GTIN = "04006381333931";

  function seedUser(): string {
    return psql(`select id from auth.users order by created_at limit 1;`);
  }

  function clean(): void {
    psql(`delete from catalog_barcode_lookups where gtin14 = '${GTIN}';
          delete from food_refs where catalog_food_id in (select id from catalog_foods where source_id = '${GTIN}');
          delete from catalog_barcodes where gtin14 = '${GTIN}';
          delete from catalog_food_revisions where catalog_food_id in (select id from catalog_foods where source_id = '${GTIN}');
          delete from catalog_foods where source_id = '${GTIN}';
          delete from catalog_versions where version_label like 'off-%' or version_label like 'fdc_branded-%';`);
  }

  describe.skipIf(!hasBranch)("phase 3 barcode cache", () => {
    it("creates catalog_barcode_lookups with the spec's constraints and no RLS", () => {
      expect(psql(`select count(*) from information_schema.columns
                    where table_name = 'catalog_barcode_lookups';`)).toBe("7");
      expect(psql(`select relrowsecurity from pg_class where relname = 'catalog_barcode_lookups';`))
        .toBe("f");
      expect(psql(`select indexname from pg_indexes
                    where tablename = 'catalog_barcode_lookups' and indexname like '%stale';`))
        .toBe("catalog_barcode_lookups_stale");
      expect(psqlExpectError(
        `insert into catalog_barcode_lookups (gtin14, status) values ('0400638133393x', 'miss');`
      )).toContain("violates check constraint");
    });

    it("lets authenticated read the ledger and write nothing", () => {
      expect(psql(`set local role authenticated;
                   select count(*) from catalog_barcode_lookups;`)).toContain("SET");
      expect(psqlExpectError(`set local role authenticated;
        insert into catalog_barcode_lookups (gtin14, status) values ('${GTIN}', 'miss');`))
        .toContain("permission denied for table catalog_barcode_lookups");
      expect(psqlExpectError(`set local role authenticated;
        insert into catalog_barcodes (gtin14, catalog_food_id, source) values ('${GTIN}', 1, 'off');`))
        .toContain("permission denied for table catalog_barcodes");
    });

    it("writes version, food, revision, children, barcode and food_ref in one call", () => {
      clean();
      const userId = seedUser();
      const out = psql(
        `select catalog_write_provider_revision('${userId}'::uuid, 'off', '${GTIN}', '${DRAFT}'::jsonb);`);
      expect(out).toContain('"version_label"');
      expect(psql(`select count(*) from catalog_foods where source = 'off' and source_id = '${GTIN}';`)).toBe("1");
      expect(psql(`select count(*) from catalog_food_revisions r join catalog_foods f
                     on f.id = r.catalog_food_id where f.source_id = '${GTIN}' and r.is_active;`)).toBe("1");
      expect(psql(`select count(*) from catalog_barcodes where gtin14 = '${GTIN}';`)).toBe("1");
      expect(psql(`select count(*) from catalog_portions p join catalog_food_revisions r
                     on r.id = p.food_revision_id join catalog_foods f on f.id = r.catalog_food_id
                    where f.source_id = '${GTIN}' and p.is_default;`)).toBe("1");
      expect(psql(`select count(*) from food_refs fr join catalog_foods f on f.id = fr.catalog_food_id
                    where f.source_id = '${GTIN}';`)).toBe("1");
      expect(psql(`select count(*) from catalog_versions where is_active and source = 'off';`)).toBe("0");
    });

    it("rolls the whole write back when one child row is bad", () => {
      clean();
      const userId = seedUser();
      const bad = DRAFT.replace('"gramWeight": 90', '"gramWeight": "not-a-number"');
      psqlExpectError(
        `select catalog_write_provider_revision('${userId}'::uuid, 'off', '${GTIN}', '${bad}'::jsonb);`);
      expect(psql(`select count(*) from catalog_foods where source_id = '${GTIN}';`)).toBe("0");
      clean();
    });

    it("refuses a bad source, a bad gtin and a call from authenticated", () => {
      const userId = seedUser();
      expect(psqlExpectError(
        `select catalog_write_provider_revision('${userId}'::uuid, 'off', 'abc', '${DRAFT}'::jsonb);`))
        .toContain("bad_gtin");
      expect(psqlExpectError(
        `select catalog_write_provider_revision('${userId}'::uuid, 'oops', '${GTIN}', '${DRAFT}'::jsonb);`))
        .toContain("bad_source");
      expect(psqlExpectError(`set local role authenticated;
        select catalog_write_provider_revision('${userId}'::uuid, 'off', '${GTIN}', '${DRAFT}'::jsonb);`))
        .toContain("permission denied for function catalog_write_provider_revision");
      clean();
    });
  });
  ```
- [ ] Run it: `SUPABASE_TEST_URL= pnpm test tests/barcode/schema.test.ts` — expect the suite to SKIP (no branch). With a branch: `pnpm db:push && pnpm test tests/barcode/schema.test.ts` — expect `function catalog_write_provider_revision(...) does not exist`. **[needs branch]** — skip condition: `SUPABASE_TEST_URL` unset.
- [ ] Write `supabase/migrations/20260919090100_phase3_barcode_cache.sql`:
  ```sql
  -- Phase 3, Lane K. Two things: the ledger that stops a miss from becoming a repeated outbound
  -- fetch (spec "Data changes", verbatim), and the one function allowed to write catalog_* from a
  -- request path. Both are additive; no Phase 0-2 table is altered.

  -- Holds no user data, so no RLS and no write grant (spec "Data changes").
  create table if not exists catalog_barcode_lookups (
    gtin14 char(14) primary key check (gtin14 ~ '^[0-9]{14}$'),
    status text not null check (status in ('hit','miss','error')),
    source text check (source in ('off','fdc_branded')),
    http_status integer, attempts integer not null default 1,
    first_seen_at timestamptz not null default now(),
    last_fetched_at timestamptz not null default now());
  create index if not exists catalog_barcode_lookups_stale
    on catalog_barcode_lookups (last_fetched_at);
  revoke all on table catalog_barcode_lookups from public, anon, authenticated;
  grant select on catalog_barcode_lookups to authenticated;
  grant all on table catalog_barcode_lookups to service_role;

  -- The whole provider write in one transaction, so a half-written revision cannot exist and a
  -- retry cannot leave an orphan identity (contracts §2). security definer + service_role only:
  -- `authenticated` holds select on catalog_* and no write grant, and that stays true.
  --
  -- Version rows are per (source, UTC fetch date) and stay is_active = false: a provider row is
  -- not the bulk import, and catalog_versions_one_active_per_source must keep belonging to the
  -- bulk version. catalog_search's active test is per revision, so the REVISION is is_active.
  -- A re-fetch of a known identity activates a new revision and deactivates the old one; the
  -- catalog_foods identity (source, source_id = gtin14) is never rewritten.
  create or replace function catalog_write_provider_revision(
    p_user_id uuid, p_source text, p_gtin14 text, p_draft jsonb)
  returns jsonb language plpgsql security definer set search_path = public as $$
  declare
    v_label   text;
    v_ver_id  bigint;
    v_food_id bigint;
    v_rev_id  bigint;
    v_desc    text;
    v_brand   text;
    v_pub     timestamptz;
  begin
    if p_user_id is null then raise exception 'user_required' using errcode = '22023'; end if;
    if p_source not in ('off','fdc_branded') then
      raise exception 'bad_source' using errcode = '22023';
    end if;
    if p_gtin14 is null or p_gtin14 !~ '^[0-9]{14}$' then
      raise exception 'bad_gtin' using errcode = '22023';
    end if;
    if p_draft->'per100g' is null then raise exception 'bad_draft' using errcode = '22023'; end if;

    v_desc  := coalesce(nullif(trim(p_draft->>'description'), ''), 'Barcode ' || p_gtin14);
    v_brand := nullif(trim(coalesce(p_draft->>'brand', '')), '');
    v_pub   := coalesce((p_draft->>'publishedAt')::timestamptz, now());
    v_label := p_source || '-' || to_char((now() at time zone 'utc')::date, 'YYYY-MM-DD');

    insert into catalog_versions (source, version_label, is_active)
      values (p_source, v_label, false) on conflict (source, version_label) do nothing;
    select id into v_ver_id from catalog_versions
      where source = p_source and version_label = v_label;

    insert into catalog_foods (source, source_id) values (p_source, p_gtin14)
      on conflict (source, source_id) do nothing;
    select id into v_food_id from catalog_foods
      where source = p_source and source_id = p_gtin14;

    update catalog_food_revisions set is_active = false, valid_to = now()
     where catalog_food_id = v_food_id and is_active and catalog_version_id <> v_ver_id;

    insert into catalog_food_revisions (catalog_food_id, catalog_version_id, description, brand,
        quality_class, quality_flags, search_doc, content_hash, is_active, valid_from, valid_to)
    values (v_food_id, v_ver_id, v_desc, v_brand,
        coalesce(p_draft->>'qualityClass', 'crowd'),
        coalesce(array(select jsonb_array_elements_text(p_draft->'qualityFlags')), '{}'::text[]),
        catalog_search_doc(v_desc, v_brand, null),
        encode(sha256(convert_to(p_draft::text, 'UTF8')), 'hex'), true, now(), null)
    on conflict (catalog_food_id, catalog_version_id) do update
      set description = excluded.description, brand = excluded.brand,
          quality_class = excluded.quality_class, quality_flags = excluded.quality_flags,
          search_doc = excluded.search_doc, content_hash = excluded.content_hash,
          is_active = true, valid_from = now(), valid_to = null
    returning id into v_rev_id;

    delete from catalog_food_nutrients where food_revision_id = v_rev_id;
    insert into catalog_food_nutrients (food_revision_id, nutrient_code, amount_per_100g)
    select v_rev_id, kv.key, nullif(kv.value, 'null'::jsonb)::numeric
      from jsonb_each(p_draft->'per100g') kv
     where exists (select 1 from catalog_nutrients c where c.code = kv.key);

    delete from catalog_portions where food_revision_id = v_rev_id;
    insert into catalog_portions (food_revision_id, description, gram_weight, seq, is_default)
    select v_rev_id, p.value->>'description', (p.value->>'gramWeight')::numeric,
           p.ord::int, p.ord = 1
      from jsonb_array_elements(coalesce(p_draft->'portions', '[]'::jsonb))
           with ordinality as p(value, ord);

    -- seq 1 carries the product's verbatim ingredients_text; later rows carry their own fragment
    -- in `name` and no raw_text. resolveBarcode reads BarcodeMatch.ingredientsText back from it.
    delete from catalog_ingredients where food_revision_id = v_rev_id;
    insert into catalog_ingredients (food_revision_id, seq, name, allergen_tags, raw_text)
    select v_rev_id, (i.value->>'seq')::int, i.value->>'name',
           coalesce(array(select jsonb_array_elements_text(i.value->'allergenTags')), '{}'::text[]),
           case when (i.value->>'seq')::int = 1 then p_draft->>'ingredientsText' else null end
      from jsonb_array_elements(coalesce(p_draft->'ingredients', '[]'::jsonb)) as i(value);

    insert into catalog_barcodes (gtin14, catalog_food_id, source, published_at)
         values (p_gtin14, v_food_id, p_source, v_pub)
    on conflict (gtin14, catalog_food_id, source) do update set published_at = excluded.published_at;

    perform get_or_create_food_ref(p_user_id, 'catalog', v_food_id, null);

    return jsonb_build_object('catalog_food_id', v_food_id, 'revision_id', v_rev_id,
                              'version_label', v_label);
  end; $$;

  revoke all on function catalog_write_provider_revision(uuid, text, text, jsonb) from public;
  revoke all on function catalog_write_provider_revision(uuid, text, text, jsonb) from anon, authenticated;
  grant execute on function catalog_write_provider_revision(uuid, text, text, jsonb) to service_role;
  ```
- [ ] Write `supabase/migrations/down/20260919090100_phase3_barcode_cache.down.sql`:
  ```sql
  -- Down for supabase/migrations/20260919090100_phase3_barcode_cache.sql. Lives in down/ for the
  -- reason 20260912090200_catalog_grants.down.sql gives: `supabase db reset` applies every
  -- top-level <digits>_<name>.sql and does not descend into subdirectories.
  --
  -- Drops only what 090100 created. The cached OFF and FDC catalog rows are derived data and are
  -- left in place: dropping them costs a re-fetch, and log_items keep their own snapshots either
  -- way (spec "Rollout and rollback").
  drop function if exists catalog_write_provider_revision(uuid, text, text, jsonb);
  drop index if exists catalog_barcode_lookups_stale;
  drop table if exists catalog_barcode_lookups;
  ```
- [ ] Run it **[needs branch]**: `pnpm db:push && pnpm test tests/barcode/schema.test.ts` — expect PASS (5 tests). With `SUPABASE_TEST_URL` unset: SKIPPED.
- [ ] Commit: `git add supabase/migrations/20260919090100_phase3_barcode_cache.sql supabase/migrations/down/20260919090100_phase3_barcode_cache.down.sql tests/barcode/schema.test.ts && git commit -m "feat(db): barcode lookup ledger and the atomic provider revision writer"`

---

## Task 8 — writeProviderRevision, the only request-path catalog writer

**Files**
- Create: `lib/server/catalog-writer.ts`
- Test: `tests/barcode/catalog-writer.test.ts`
- Modify: `docs/plans/2026-09-11-phase-3-4/00-contracts.md` §2 (one line; the contract's own rule is that a change lands there first — see the first step below)

**Interfaces**
- Consumes: `catalog_write_provider_revision` (Task 7); `HttpError` from `lib/server/auth.ts`; `RevisionDraft` (Task 5); `SupabaseClient` from `@supabase/supabase-js`.
- Produces:
  ```ts
  export async function writeProviderRevision(
    admin: SupabaseClient, source: "off" | "fdc_branded", gtin14: string,
    draft: RevisionDraft, userId: string
  ): Promise<{ catalogFoodId: number; revisionId: number; versionLabel: string }>;
  ```
  Contracts §2 froze the first four parameters only; `userId` is a real widening of that signature, not an implementation detail, so it lands as its own contract-change commit (below) before this task's implementation commit — the same order Lane M uses for `StructuredArgs`. This resolves Open question 2.

**Steps**

- [ ] Commit the contract line first, in `00-contracts.md` §2, widening the frozen signature to carry the caller's id:
  ```ts
  export async function writeProviderRevision(admin: SupabaseClient, source: "off" | "fdc_branded", gtin14: string,
    draft: RevisionDraft, userId: string): Promise<{ catalogFoodId: number; revisionId: number; versionLabel: string }>;
  // userId is appended, never renamed or reordered ahead of the existing four: get_or_create_food_ref
  // asserts a caller (_sync_assert_caller) and raises user_required on a null, and Phase 0 contracts §2
  // makes p_user_id the first argument of every RPC in this repository — so the RPC becomes
  // (p_user_id uuid, p_source text, p_gtin14 text, p_draft jsonb) and this wrapper matches it.
  ```
  **Already landed in `00-contracts.md` (2026-09-11)** — read the contract section and confirm it says this; do not commit a contract change (docs: phase-3-4 contract change — writeProviderRevision carries userId)
- [ ] Write the failing test `tests/barcode/catalog-writer.test.ts`:
  ```ts
  import { describe, expect, it, vi } from "vitest";
  import { writeProviderRevision } from "@/lib/server/catalog-writer";
  import type { RevisionDraft } from "@/lib/catalog/off-map";
  import { emptyPer100g } from "@/lib/catalog/off-map";

  const DRAFT: RevisionDraft = {
    description: "Apple & blueberry pouch", brand: "Ella's Kitchen", qualityClass: "crowd",
    per100g: { ...emptyPer100g(), energy_kcal: 60, protein: 0.4 },
    portions: [{ description: "1 pouch (90 g)", gramWeight: 90 }],
    ingredients: [{ seq: 1, name: "Apple juice concentrate", allergenTags: ["apple"] }],
    ingredientsText: "Apple juice concentrate", qualityFlags: [],
    sourceId: "04006381333931", publishedAt: "2026-09-19T12:00:00.000Z",
  };

  function adminWith(result: { data: unknown; error: unknown }) {
    const rpc = vi.fn().mockResolvedValue(result);
    return { admin: { rpc } as never, rpc };
  }

  describe("writeProviderRevision", () => {
    it("sends the draft to the one RPC and returns camelCase ids", async () => {
      const { admin, rpc } = adminWith({
        data: { catalog_food_id: 12, revision_id: 34, version_label: "off-2026-09-19" }, error: null,
      });
      expect(await writeProviderRevision(admin, "off", "04006381333931", DRAFT, "user-a")).toEqual({
        catalogFoodId: 12, revisionId: 34, versionLabel: "off-2026-09-19",
      });
      expect(rpc).toHaveBeenCalledWith("catalog_write_provider_revision", {
        p_user_id: "user-a", p_source: "off", p_gtin14: "04006381333931", p_draft: DRAFT,
      });
    });

    it("throws a 502 with no provider detail when the RPC fails", async () => {
      const { admin } = adminWith({ data: null, error: { message: "duplicate key value 42P01" } });
      await expect(writeProviderRevision(admin, "off", "04006381333931", DRAFT, "user-a"))
        .rejects.toMatchObject({ status: 502, code: "catalog_write_failed" });
    });

    it("throws a 502 when the RPC answers nothing", async () => {
      const { admin } = adminWith({ data: null, error: null });
      await expect(writeProviderRevision(admin, "off", "04006381333931", DRAFT, "user-a"))
        .rejects.toMatchObject({ status: 502 });
    });
  });
  ```
- [ ] Run it: `pnpm test tests/barcode/catalog-writer.test.ts` — expect `Failed to resolve import "@/lib/server/catalog-writer"`.
- [ ] Write `lib/server/catalog-writer.ts`:
  ```ts
  /**
   * The ONLY module that writes catalog_* from a request path (spec "Security", contracts §8).
   * A review-blocking defect is any other module importing it, and any module other than this one
   * importing lib/server/admin.ts to write a catalog row.
   *
   * It accepts only a RevisionDraft the mappers built from a provider response — never a field
   * from a request body — and the GTIN, which is 14 validated digits by the time it arrives. The
   * whole write is one RPC call so it is one transaction: version, identity, revision,
   * nutrients, portions, ingredients, barcode and food_ref land together or not at all.
   */
  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { RevisionDraft } from "@/lib/catalog/off-map";
  import { HttpError } from "@/lib/server/auth";

  if (typeof window !== "undefined") {
    throw new Error("lib/server/catalog-writer.ts is server-only and must never reach the browser bundle.");
  }

  type WriteRow = { catalog_food_id: number; revision_id: number; version_label: string };

  export async function writeProviderRevision(
    admin: SupabaseClient,
    source: "off" | "fdc_branded",
    gtin14: string,
    draft: RevisionDraft,
    userId: string
  ): Promise<{ catalogFoodId: number; revisionId: number; versionLabel: string }> {
    const { data, error } = await admin.rpc("catalog_write_provider_revision", {
      p_user_id: userId, p_source: source, p_gtin14: gtin14, p_draft: draft,
    });
    if (error) {
      // The provider and the database both speak in detail we never hand back to the client.
      console.error("[catalog-writer] provider write failed", source, error);
      throw new HttpError(502, "catalog_write_failed", "That product could not be cached.");
    }
    const row = (Array.isArray(data) ? data[0] : data) as WriteRow | null;
    if (!row) throw new HttpError(502, "catalog_write_failed", "That product could not be cached.");
    return {
      catalogFoodId: Number(row.catalog_food_id),
      revisionId: Number(row.revision_id),
      versionLabel: row.version_label,
    };
  }
  ```
- [ ] Run it: `pnpm test tests/barcode/catalog-writer.test.ts` — expect PASS (3 tests).
- [ ] Commit: `git add lib/server/catalog-writer.ts tests/barcode/catalog-writer.test.ts && git commit -m "feat(catalog): writeProviderRevision, the only request-path catalog writer"`

---

## Task 9 — resolveBarcode and the resolution order

**Files**
- Create: `lib/server/barcode.ts`
- Create: `tests/barcode/fake-client.ts`
- Test: `tests/barcode/resolve.test.ts`

**Interfaces**
- Consumes: `normalizeGtin` (Task 1); `fetchOffProduct`, `isProviderFailure` (Task 3); `fetchFdcBranded` (Task 4); `offToRevision` (Task 5); `fdcBrandedToRevision` (Task 6); `writeProviderRevision` (Task 8); `attributionFor`, `type CatalogSource` from `lib/server/catalog.ts`; `HttpError` from `lib/server/auth.ts`; `evaluatePolicy`, `loadProfile`, `type PolicyVerdict` from `lib/policy/constraints.ts` (pre-lane, contracts §4); wire types from `lib/barcode/client.ts` (Task 12, `import type` only — erased at compile time, so the server never pulls a browser module at runtime).
- Produces:
  ```ts
  export const NEGATIVE_CACHE_DAYS = 7;
  export const REFRESH_AFTER_DAYS = 90;
  export type ProviderDeps = {
    fetchOff?: typeof fetchOffProduct;
    fetchFdc?: typeof fetchFdcBranded;
    now?: () => Date;
    onOutbound?: () => Promise<void>;
    scheduleRefresh?: (gtin14: string) => void;
  };
  export async function resolveBarcode(
    client: SupabaseClient, admin: SupabaseClient, userId: string,
    req: BarcodeRequest, deps?: ProviderDeps
  ): Promise<BarcodeResponse>;
  ```

**Steps**

- [ ] Write `tests/barcode/fake-client.ts` (the shared double; no assertions of its own):
  ```ts
  /**
   * A hand-rolled PostgREST query-builder double. @testing-library and a Supabase mock library are
   * both absent by contract, and resolveBarcode only ever calls .from().select().eq()… .maybeSingle()
   * or awaits the builder, so this is the whole surface.
   */
  import { vi } from "vitest";

  export type TableRows = Record<string, Record<string, unknown>[]>;

  type Filter = { column: string; value: unknown };

  function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
    return filters.every((f) => String(row[f.column]) === String(f.value));
  }

  export function fakeClient(tables: TableRows, rpcResults: Record<string, unknown> = {}) {
    const rpc = vi.fn(async (name: string) => ({ data: rpcResults[name] ?? null, error: null }));
    const upserts: { table: string; rows: unknown }[] = [];
    const from = vi.fn((table: string) => {
      const filters: Filter[] = [];
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq(column: string, value: unknown) { filters.push({ column, value }); return builder; },
        in(column: string, values: unknown[]) {
          filters.push({ column, value: values[0] });
          return builder;
        },
        upsert(rows: unknown) { upserts.push({ table, rows }); return Promise.resolve({ error: null }); },
        maybeSingle: async () => ({ data: (tables[table] ?? []).find((r) => matches(r, filters)) ?? null, error: null }),
        then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
          return Promise.resolve({ data: (tables[table] ?? []).filter((r) => matches(r, filters)), error: null })
            .then(resolve);
        },
      };
      return builder;
    });
    return { client: { from, rpc } as never, from, rpc, upserts };
  }
  ```
- [ ] Write the failing test `tests/barcode/resolve.test.ts`:
  ```ts
  import { describe, expect, it, vi } from "vitest";
  import { resolveBarcode } from "@/lib/server/barcode";
  import { fakeClient } from "./fake-client";

  const GTIN = "04006381333931";
  const NOW = new Date("2026-09-19T12:00:00.000Z");

  const PRODUCT = {
    product_name: "Apple & blueberry pouch", brands: "Ella's Kitchen",
    ingredients_text: "Apple juice concentrate, blueberry puree",
    serving_quantity: 90, serving_size: "1 pouch (90 g)",
    nutriments: { "energy-kcal_100g": 60, proteins_100g: 0.4, carbohydrates_100g: 13.5, fat_100g: 0.2 },
  };

  function cached(overrides: Record<string, unknown> = {}) {
    return fakeClient({
      catalog_barcodes: [{ gtin14: GTIN, catalog_food_id: 12, source: "off", published_at: "2026-09-01T00:00:00Z" }],
      catalog_food_revisions: [{
        id: 34, catalog_food_id: 12, description: "Apple & blueberry pouch", brand: "Ella's Kitchen",
        quality_class: "crowd", quality_flags: [], is_active: true,
        catalog_versions: { version_label: "off-2026-09-01", imported_at: "2026-09-01T00:00:00Z" },
        catalog_food_nutrients: [{ nutrient_code: "energy_kcal", amount_per_100g: 60 }],
        catalog_portions: [{ id: 5, description: "1 pouch (90 g)", gram_weight: 90, is_default: true, seq: 1 }],
        catalog_ingredients: [{ seq: 1, name: "Apple juice concentrate", allergen_tags: ["apple"], raw_text: "Apple juice concentrate, blueberry puree" }],
        ...overrides,
      }],
      constraint_profiles: [], user_food_prefs: [], catalog_barcode_lookups: [],
    }, { get_or_create_food_ref: "11111111-1111-4111-8111-111111111111" });
  }

  describe("resolveBarcode", () => {
    it("400s on a bad check digit before any I/O", async () => {
      const { client } = cached();
      const fetchOff = vi.fn();
      await expect(resolveBarcode(client, client, "user-a", { gtin: "4006381333932" }, { fetchOff }))
        .rejects.toMatchObject({ status: 400, code: "invalid_gtin" });
      expect(fetchOff).not.toHaveBeenCalled();
    });

    it("serves a cached barcode with cached:true and no outbound call", async () => {
      const { client } = cached();
      const fetchOff = vi.fn();
      const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { fetchOff, now: () => NOW });
      expect(res.status).toBe("resolved");
      if (res.status !== "resolved") return;
      expect(res.cached).toBe(true);
      expect(res.match.revisionId).toBe(34);
      expect(res.match.attribution).toBe("Data from Open Food Facts (ODbL)");
      expect(res.match.allergenTags).toEqual(["apple"]);
      expect(res.match.ingredientsText).toBe("Apple juice concentrate, blueberry puree");
      expect(res.match.policy).toEqual({ verdict: "blocked", reason: "allergen:apple" });
      expect(res.match.portions).toEqual([{ id: 5, description: "1 pouch (90 g)", gramWeight: 90, isDefault: true }]);
      expect(fetchOff).not.toHaveBeenCalled();
    });

    it("flags a hit older than 90 days for the next request and still answers from cache", async () => {
      const { client } = cached({
        catalog_versions: { version_label: "off-2026-01-01", imported_at: "2026-01-01T00:00:00Z" },
      });
      const scheduleRefresh = vi.fn();
      const fetchOff = vi.fn();
      const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN },
        { fetchOff, now: () => NOW, scheduleRefresh });
      expect(res.status).toBe("resolved");
      expect(scheduleRefresh).toHaveBeenCalledWith(GTIN);
      expect(fetchOff).not.toHaveBeenCalled();
    });

    it("makes no outbound call for a miss row younger than 7 days", async () => {
      const { client } = fakeClient({
        catalog_barcodes: [], constraint_profiles: [], catalog_food_revisions: [],
        catalog_barcode_lookups: [{ gtin14: GTIN, status: "miss", attempts: 1, last_fetched_at: "2026-09-15T00:00:00Z" }],
      });
      const fetchOff = vi.fn();
      const res = await resolveBarcode(client, client, "user-a",
        { gtin: GTIN, hint: { brand: "Ella's" } }, { fetchOff, now: () => NOW });
      expect(res).toEqual({ status: "not_found", gtin14: GTIN, searchHint: { brand: "Ella's" } });
      expect(fetchOff).not.toHaveBeenCalled();
    });

    it("falls OFF 404 → FDC 404 → not_found, and records the miss", async () => {
      const { client, upserts } = fakeClient({
        catalog_barcodes: [], constraint_profiles: [], catalog_food_revisions: [], catalog_barcode_lookups: [],
      });
      const fetchOff = vi.fn().mockResolvedValue({ status: 404 });
      const fetchFdc = vi.fn().mockResolvedValue({ status: 404 });
      const onOutbound = vi.fn().mockResolvedValue(undefined);
      const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN },
        { fetchOff, fetchFdc, onOutbound, now: () => NOW });
      expect(res.status).toBe("not_found");
      expect(onOutbound).toHaveBeenCalledTimes(1);
      expect(upserts[0]).toEqual({
        table: "catalog_barcode_lookups",
        rows: { gtin14: GTIN, status: "miss", source: null, http_status: 404, attempts: 1,
                last_fetched_at: NOW.toISOString() },
      });
    });

    it("falls through an OFF timeout to FDC and writes the revision", async () => {
      const { client, rpc } = fakeClient({
        catalog_barcodes: [], constraint_profiles: [], catalog_barcode_lookups: [],
        catalog_food_revisions: [],
      }, { catalog_write_provider_revision: { catalog_food_id: 12, revision_id: 34, version_label: "fdc_branded-2026-09-19" } });
      const fetchOff = vi.fn().mockResolvedValue({ status: "timeout" });
      const fetchFdc = vi.fn().mockResolvedValue({
        fdcId: 1, description: "POUCH", gtinUpc: "4006381333931",
        foodNutrients: [{ nutrientId: 1008, unitName: "KCAL", value: 60 }],
      });
      const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN },
        { fetchOff, fetchFdc, now: () => NOW });
      expect(res.status).toBe("resolved");
      if (res.status !== "resolved") return;
      expect(res.cached).toBe(false);
      expect(res.match.source).toBe("fdc_branded");
      expect(rpc).toHaveBeenCalledWith("catalog_write_provider_revision", expect.objectContaining({
        p_source: "fdc_branded", p_gtin14: GTIN,
      }));
    });

    it("503s when both providers fail transport and nothing is cached", async () => {
      const { client } = fakeClient({
        catalog_barcodes: [], constraint_profiles: [], catalog_food_revisions: [], catalog_barcode_lookups: [],
      });
      await expect(resolveBarcode(client, client, "user-a", { gtin: GTIN }, {
        fetchOff: vi.fn().mockResolvedValue({ status: "timeout" }),
        fetchFdc: vi.fn().mockResolvedValue({ status: 503 }),
        now: () => NOW,
      })).rejects.toMatchObject({ status: 503, code: "upstream_unavailable" });
    });

    it("returns at most three candidates ranked by quality_class then published_at", async () => {
      const { client } = fakeClient({
        catalog_barcodes: [
          { gtin14: GTIN, catalog_food_id: 1, source: "off", published_at: "2026-09-10T00:00:00Z" },
          { gtin14: GTIN, catalog_food_id: 2, source: "fdc_branded", published_at: "2026-01-01T00:00:00Z" },
        ],
        catalog_food_revisions: [
          { id: 10, catalog_food_id: 1, description: "Crowd row", brand: null, quality_class: "crowd",
            quality_flags: [], is_active: true, catalog_versions: { version_label: "off-2026-09-10", imported_at: "2026-09-10T00:00:00Z" },
            catalog_food_nutrients: [], catalog_portions: [], catalog_ingredients: [] },
          { id: 20, catalog_food_id: 2, description: "Label row", brand: null, quality_class: "label",
            quality_flags: [], is_active: true, catalog_versions: { version_label: "fdc_branded-2026-01-01", imported_at: "2026-01-01T00:00:00Z" },
            catalog_food_nutrients: [], catalog_portions: [], catalog_ingredients: [] },
        ],
        constraint_profiles: [], catalog_barcode_lookups: [],
      }, { get_or_create_food_ref: "11111111-1111-4111-8111-111111111111" });
      const res = await resolveBarcode(client, client, "user-a", { gtin: GTIN }, { now: () => NOW });
      expect(res.status).toBe("ambiguous");
      if (res.status !== "ambiguous") return;
      expect(res.matches.map((m) => m.revisionId)).toEqual([20, 10]);
    });
  });
  ```
  The `in()` shortcut in `fake-client.ts` filters on the first id only, so the ambiguity fixture keeps both revisions in `catalog_food_revisions` and `resolveBarcode` does its own id filter after the read — assert that behaviour holds when the code is written.
- [ ] Run it: `pnpm test tests/barcode/resolve.test.ts` — expect `Failed to resolve import "@/lib/server/barcode"`.
- [ ] Write `lib/server/barcode.ts`:
  ```ts
  /**
   * The resolution order of the Phase 3 spec's "API changes", in one place:
   *
   *   normalise to GTIN-14 and verify the check digit  → 400 invalid_gtin
   *   catalog_barcodes hit                             → return, cached: true, no network
   *   catalog_barcode_lookups 'miss' younger than 7 d  → not_found, no network
   *   OFF → FDC Branded → write → return               → cached: false
   *   both providers failed and nothing cached         → 503 upstream_unavailable
   *
   * A hit older than 90 days is served immediately and flagged for the NEXT request (architecture
   * §7.3) — the refresh never runs on the hot path. `status: 'not_found'` is a 200, because "we do
   * not know this barcode" is an answer, not an error, and a provider failure after a cache hit is
   * invisible to her.
   */
  import type { SupabaseClient } from "@supabase/supabase-js";
  import type { BarcodeMatch, BarcodeRequest, BarcodeResponse } from "@/lib/barcode/client";
  import { normalizeGtin } from "@/lib/barcode/gtin";
  import { fetchFdcBranded } from "@/lib/catalog/fdc";
  import { fdcBrandedToRevision } from "@/lib/catalog/fdc-map";
  import { fetchOffProduct, isProviderFailure } from "@/lib/catalog/off";
  import { offToRevision, type RevisionDraft } from "@/lib/catalog/off-map";
  import { evaluatePolicy, loadProfile, type ConstraintProfile } from "@/lib/policy/constraints";
  import { HttpError } from "@/lib/server/auth";
  import { attributionFor, type CatalogSource } from "@/lib/server/catalog";
  import { writeProviderRevision } from "@/lib/server/catalog-writer";

  export const NEGATIVE_CACHE_DAYS = 7;
  export const REFRESH_AFTER_DAYS = 90;
  const DAY_MS = 86_400_000;
  const QUALITY_RANK: Record<string, number> = { analytical: 0, survey: 1, label: 2, crowd: 3 };

  export type ProviderDeps = {
    fetchOff?: typeof fetchOffProduct;
    fetchFdc?: typeof fetchFdcBranded;
    now?: () => Date;
    /** The 20/min outbound budget. Awaited immediately before the first provider call. */
    onOutbound?: () => Promise<void>;
    /** Fire-and-forget: the refresh is the NEXT request's job, never this one's. */
    scheduleRefresh?: (gtin14: string) => void;
  };

  const REVISION_SELECT = `
    id, catalog_food_id, description, brand, quality_class, quality_flags,
    catalog_versions!inner ( version_label, imported_at ),
    catalog_food_nutrients ( nutrient_code, amount_per_100g ),
    catalog_portions ( id, description, gram_weight, is_default, seq ),
    catalog_ingredients ( seq, name, allergen_tags, raw_text )`;

  type RevisionRow = {
    id: number; catalog_food_id: number; description: string; brand: string | null;
    quality_class: BarcodeMatch["qualityClass"]; quality_flags: string[];
    catalog_versions: { version_label: string; imported_at: string };
    catalog_food_nutrients: { nutrient_code: string; amount_per_100g: number | null }[];
    catalog_portions: { id: number; description: string; gram_weight: number; is_default: boolean; seq: number }[];
    catalog_ingredients: { seq: number; name: string; allergen_tags: string[] | null; raw_text: string | null }[];
  };

  type BarcodeRow = { catalog_food_id: number; source: CatalogSource; published_at: string | null };

  async function loadProfileFor(client: SupabaseClient, userId: string): Promise<ConstraintProfile> {
    const { data } = await client.from("constraint_profiles")
      .select("avoid_allergens, avoid_food_ref_ids, banned_categories")
      .eq("user_id", userId).maybeSingle();
    return loadProfile(data as Partial<ConstraintProfile> | null);
  }

  async function foodRefFor(client: SupabaseClient, userId: string, catalogFoodId: number): Promise<string> {
    const { data, error } = await client.rpc("get_or_create_food_ref", {
      p_user_id: userId, p_kind: "catalog", p_catalog_food_id: catalogFoodId, p_user_food_id: null,
    });
    if (error || typeof data !== "string") {
      throw new HttpError(500, "food_ref_failed", "That product could not be prepared for logging.");
    }
    return data;
  }

  async function onEatsList(client: SupabaseClient, userId: string, foodRefId: string): Promise<boolean> {
    const { data } = await client.from("user_food_prefs").select("status")
      .eq("user_id", userId).eq("food_ref_id", foodRefId).maybeSingle();
    return (data as { status?: string } | null)?.status === "eats";
  }

  async function toMatch(
    client: SupabaseClient, userId: string, profile: ConstraintProfile,
    row: RevisionRow, source: CatalogSource
  ): Promise<BarcodeMatch> {
    const per100g: Record<string, number | null> = {};
    for (const n of row.catalog_food_nutrients ?? []) per100g[n.nutrient_code] = n.amount_per_100g;
    const ingredients = [...(row.catalog_ingredients ?? [])].sort((a, b) => a.seq - b.seq);
    const allergenTags = [...new Set(ingredients.flatMap((i) => i.allergen_tags ?? []))];
    const foodRefId = await foodRefFor(client, userId, row.catalog_food_id);
    const evidence = {
      foodRefId,
      allergenTags: ingredients.length > 0 ? allergenTags : null,
      category: null,
      onEatsList: await onEatsList(client, userId, foodRefId),
    };
    return {
      foodRefId, catalogFoodId: row.catalog_food_id, revisionId: row.id,
      description: row.description, brand: row.brand, source,
      qualityClass: row.quality_class, per100g,
      portions: [...(row.catalog_portions ?? [])].sort((a, b) => a.seq - b.seq).map((p) => ({
        id: p.id, description: p.description, gramWeight: Number(p.gram_weight), isDefault: p.is_default,
      })),
      ingredientsText: ingredients.find((i) => i.seq === 1)?.raw_text ?? null,
      allergenTags,
      attribution: attributionFor(source, row.catalog_versions.version_label),
      policy: evaluatePolicy(profile, evidence),
    };
  }

  /** §4.1: several catalog_barcodes rows for one GTIN rank by quality_class then published_at. */
  function rank(a: { row: RevisionRow; at: string | null }, b: { row: RevisionRow; at: string | null }): number {
    const byQuality = QUALITY_RANK[a.row.quality_class] - QUALITY_RANK[b.row.quality_class];
    if (byQuality !== 0) return byQuality;
    return Date.parse(b.at ?? "") - Date.parse(a.at ?? "");
  }

  async function cachedMatches(
    client: SupabaseClient, userId: string, profile: ConstraintProfile, gtin14: string, now: Date
  ): Promise<{ matches: BarcodeMatch[]; stale: boolean }> {
    const { data: barcodeData } = await client.from("catalog_barcodes")
      .select("catalog_food_id, source, published_at").eq("gtin14", gtin14);
    const barcodes = (barcodeData ?? []) as BarcodeRow[];
    if (barcodes.length === 0) return { matches: [], stale: false };
    const { data: revisionData } = await client.from("catalog_food_revisions")
      .select(REVISION_SELECT)
      .in("catalog_food_id", barcodes.map((b) => b.catalog_food_id))
      .eq("is_active", true);
    const ids = new Set(barcodes.map((b) => b.catalog_food_id));
    const rows = ((revisionData ?? []) as unknown as RevisionRow[])
      .filter((r) => ids.has(r.catalog_food_id));
    const paired = rows
      .map((row) => {
        const barcode = barcodes.find((b) => b.catalog_food_id === row.catalog_food_id);
        return { row, at: barcode?.published_at ?? null, source: barcode?.source ?? "off" };
      })
      .sort(rank)
      .slice(0, 3);
    const stale = paired.some(
      (p) => now.getTime() - Date.parse(p.row.catalog_versions.imported_at) > REFRESH_AFTER_DAYS * DAY_MS
    );
    const matches: BarcodeMatch[] = [];
    for (const p of paired) matches.push(await toMatch(client, userId, profile, p.row, p.source));
    return { matches, stale };
  }

  type LookupRow = { status: string; attempts: number; last_fetched_at: string };

  async function recordLookup(
    admin: SupabaseClient, gtin14: string, prior: LookupRow | null,
    status: "hit" | "miss" | "error", source: "off" | "fdc_branded" | null,
    httpStatus: number | null, now: Date
  ): Promise<void> {
    await admin.from("catalog_barcode_lookups").upsert({
      gtin14, status, source, http_status: httpStatus,
      attempts: (prior?.attempts ?? 0) + 1, last_fetched_at: now.toISOString(),
    });
  }

  /** A clean "not this one" (404, or a draft the mapper rejected) is a miss; anything else is an outage. */
  function isOutage(status: number | "timeout" | null): boolean {
    return status !== null && status !== 404;
  }

  async function fetchDraft(
    gtin14: string, now: Date, deps: ProviderDeps
  ): Promise<{ source: "off" | "fdc_branded"; draft: RevisionDraft } | { failed: (number | "timeout" | null)[] }> {
    const fetchedAt = now.toISOString();
    const failures: (number | "timeout" | null)[] = [];
    const off = await (deps.fetchOff ?? fetchOffProduct)(gtin14);
    if (isProviderFailure(off)) {
      failures.push(off.status);
    } else {
      const draft = offToRevision(off, fetchedAt);
      if ("reject" in draft) failures.push(404);
      else return { source: "off", draft: { ...draft, sourceId: gtin14 } };
    }
    const fdc = await (deps.fetchFdc ?? fetchFdcBranded)(gtin14);
    if (isProviderFailure(fdc)) {
      failures.push(fdc.status);
    } else {
      const draft = fdcBrandedToRevision(fdc, fetchedAt);
      if ("reject" in draft) failures.push(404);
      else return { source: "fdc_branded", draft: { ...draft, sourceId: gtin14 } };
    }
    return { failed: failures };
  }

  export async function resolveBarcode(
    client: SupabaseClient, admin: SupabaseClient, userId: string,
    req: BarcodeRequest, deps: ProviderDeps = {}
  ): Promise<BarcodeResponse> {
    const gtin14 = normalizeGtin(req.gtin);
    if (gtin14 === null) throw new HttpError(400, "invalid_gtin", "That is not a barcode we can read.");
    const now = (deps.now ?? (() => new Date()))();
    const profile = await loadProfileFor(client, userId);

    const cached = await cachedMatches(client, userId, profile, gtin14, now);
    if (cached.matches.length > 0) {
      if (cached.stale) deps.scheduleRefresh?.(gtin14);
      return cached.matches.length === 1
        ? { status: "resolved", gtin14, cached: true, match: cached.matches[0] }
        : { status: "ambiguous", gtin14, cached: true, matches: cached.matches };
    }

    const { data: lookupData } = await client.from("catalog_barcode_lookups")
      .select("status, attempts, last_fetched_at").eq("gtin14", gtin14).maybeSingle();
    const prior = lookupData as LookupRow | null;
    const fresh = prior !== null &&
      now.getTime() - Date.parse(prior.last_fetched_at) < NEGATIVE_CACHE_DAYS * DAY_MS;
    if (prior?.status === "miss" && fresh) {
      return { status: "not_found", gtin14, searchHint: req.hint ?? {} };
    }

    await deps.onOutbound?.();
    const fetched = await fetchDraft(gtin14, now, deps);
    if ("failed" in fetched) {
      const outage = fetched.failed.some(isOutage);
      await recordLookup(admin, gtin14, prior, outage ? "error" : "miss", null,
        typeof fetched.failed[0] === "number" ? fetched.failed[0] : null, now);
      if (outage) {
        throw new HttpError(503, "upstream_unavailable", "The food databases are not answering. Try again in a minute.");
      }
      return { status: "not_found", gtin14, searchHint: req.hint ?? {} };
    }

    await writeProviderRevision(admin, fetched.source, gtin14, fetched.draft, userId);
    await recordLookup(admin, gtin14, prior, "hit", fetched.source, 200, now);
    const written = await cachedMatches(client, userId, profile, gtin14, now);
    if (written.matches.length === 0) {
      throw new HttpError(503, "upstream_unavailable", "The food databases are not answering. Try again in a minute.");
    }
    return written.matches.length === 1
      ? { status: "resolved", gtin14, cached: false, match: written.matches[0] }
      : { status: "ambiguous", gtin14, cached: false, matches: written.matches };
  }
  ```
  `attribution` is set for every source, not only OFF: `attributionFor` already returns the ODbL line for `off` and the USDA line otherwise, and the wire type allows a string. The `null` arm stays in the type for a source that has no notice.
- [ ] Run it: `pnpm test tests/barcode/resolve.test.ts` — expect PASS (8 tests). Task 12 lands `lib/barcode/client.ts`; until then the `import type` line resolves against the stub written in that task, so run Tasks 9 and 12 together if the type-only import cannot resolve yet.
- [ ] Commit: `git add lib/server/barcode.ts tests/barcode/fake-client.ts tests/barcode/resolve.test.ts && git commit -m "feat(barcode): resolveBarcode with the cache-first resolution order"`

---

## Task 10 — POST /api/foods/barcode

**Files**
- Create: `app/api/foods/barcode/route.ts`
- Test: `tests/barcode/route.test.ts`

**Interfaces**
- Consumes: `requireUser`, `HttpError` (`lib/server/auth.ts`); `jsonError`, `readJson` (`lib/server/http.ts`); `enforceRateLimit` (`lib/server/ratelimit.ts`); `clientIp`, `withRetryAfter` (`lib/server/catalog.ts`); `adminClient` (`lib/server/admin.ts`); `resolveBarcode` (Task 9).
- Produces: `export async function POST(req: Request): Promise<Response>`, `export const runtime = "nodejs"`, `export const dynamic = "force-dynamic"`.

**Steps**

- [ ] Write the failing test `tests/barcode/route.test.ts`:
  ```ts
  import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
  import { HttpError, requireUser } from "@/lib/server/auth";
  import { resolveBarcode } from "@/lib/server/barcode";
  import { resetRateLimits } from "@/lib/server/ratelimit";
  import { POST } from "@/app/api/foods/barcode/route";

  vi.mock("@/lib/server/auth", async (orig) => ({
    ...(await orig<typeof import("@/lib/server/auth")>()), requireUser: vi.fn(),
  }));
  vi.mock("@/lib/server/barcode", async (orig) => ({
    ...(await orig<typeof import("@/lib/server/barcode")>()), resolveBarcode: vi.fn(),
  }));
  vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({}) }));

  const mockedUser = vi.mocked(requireUser);
  const mockedResolve = vi.mocked(resolveBarcode);
  const GTIN = "04006381333931";
  const NOT_FOUND = { status: "not_found" as const, gtin14: GTIN, searchHint: {} };

  function req(body: unknown, ip = "3.3.3.3"): Request {
    return new Request("https://app.test/api/foods/barcode", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
  }

  beforeEach(() => {
    resetRateLimits();
    process.env.NEXT_PUBLIC_FEATURE_SCAN = "1";
    mockedUser.mockReset();
    mockedResolve.mockReset();
    mockedUser.mockResolvedValue({ userId: "user-a", client: {} as never });
    mockedResolve.mockResolvedValue(NOT_FOUND);
  });

  afterEach(() => { delete process.env.NEXT_PUBLIC_FEATURE_SCAN; });

  describe("POST /api/foods/barcode", () => {
    it("404s with the flag unset, without touching identity", async () => {
      delete process.env.NEXT_PUBLIC_FEATURE_SCAN;
      const res = await POST(req({ gtin: GTIN }));
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("not_found");
      expect(mockedUser).not.toHaveBeenCalled();
    });

    it("resolves for an authenticated caller and passes the hint through", async () => {
      const res = await POST(req({ gtin: "4006381333931", hint: { brand: "Ella's" } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(NOT_FOUND);
      expect(mockedResolve).toHaveBeenCalledWith({}, {}, "user-a",
        { gtin: "4006381333931", hint: { brand: "Ella's" } }, expect.any(Object));
    });

    it("400s on an invalid GTIN raised by the resolver", async () => {
      mockedResolve.mockRejectedValue(new HttpError(400, "invalid_gtin", "That is not a barcode we can read."));
      const res = await POST(req({ gtin: "4006381333932" }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_gtin");
    });

    it("400s on a body that is not a BarcodeRequest", async () => {
      expect((await POST(req({}))).status).toBe(400);
      expect((await POST(req({ gtin: 42 }))).status).toBe(400);
      expect(mockedResolve).not.toHaveBeenCalled();
    });

    it("401s with no session", async () => {
      mockedUser.mockRejectedValue(new HttpError(401, "unauthorized", "Sign in to continue."));
      expect((await POST(req({ gtin: GTIN }))).status).toBe(401);
      expect(mockedResolve).not.toHaveBeenCalled();
    });

    it("429s past 120 a minute with Retry-After", async () => {
      for (let i = 0; i < 120; i += 1) expect((await POST(req({ gtin: GTIN }))).status).toBe(200);
      const res = await POST(req({ gtin: GTIN }));
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect((await res.json()).error).toBe("rate_limited");
    });

    it("429s the outbound budget after 20 provider calls in a minute", async () => {
      mockedResolve.mockImplementation(async (_c, _a, _u, _r, deps) => {
        await deps?.onOutbound?.();
        return NOT_FOUND;
      });
      for (let i = 0; i < 20; i += 1) expect((await POST(req({ gtin: GTIN }))).status).toBe(200);
      expect((await POST(req({ gtin: GTIN }))).status).toBe(429);
    });

    it("503s when the resolver reports both providers down", async () => {
      mockedResolve.mockRejectedValue(
        new HttpError(503, "upstream_unavailable", "The food databases are not answering. Try again in a minute."));
      const res = await POST(req({ gtin: GTIN }));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("upstream_unavailable");
    });

    it("413s on a body over 8 KB", async () => {
      expect((await POST(req({ gtin: GTIN, hint: { name: "x".repeat(9000) } }))).status).toBe(413);
    });

    it("never echoes an internal message on a 500", async () => {
      mockedResolve.mockRejectedValue(new Error("relation catalog_barcodes does not exist"));
      const res = await POST(req({ gtin: GTIN }));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal", message: "Something went wrong." });
    });
  });
  ```
- [ ] Run it: `pnpm test tests/barcode/route.test.ts` — expect `Failed to resolve import "@/app/api/foods/barcode/route"`.
- [ ] Write `app/api/foods/barcode/route.ts`:
  ```ts
  import { z } from "zod";
  import { HttpError, requireUser } from "@/lib/server/auth";
  import { adminClient } from "@/lib/server/admin";
  import { resolveBarcode } from "@/lib/server/barcode";
  import { clientIp, withRetryAfter } from "@/lib/server/catalog";
  import { jsonError, readJson } from "@/lib/server/http";
  import { enforceRateLimit } from "@/lib/server/ratelimit";

  export const runtime = "nodejs";
  export const dynamic = "force-dynamic";

  const MAX_BODY_BYTES = 8 * 1024;
  const WINDOW_SECONDS = 60;

  const Body = z.object({
    gtin: z.string().min(6).max(32),
    hint: z.object({ brand: z.string().max(120).optional(), name: z.string().max(120).optional() }).optional(),
  });

  /**
   * Contracts §2 orders this route "rate limit → identity → body". The per-user limit needs a user
   * id, so the first limiter is per IP exactly as /api/foods/search does it, and the 120/min/user
   * limit lands the moment requireUser returns. The 20/min outbound budget is injected into
   * resolveBarcode and is spent only on the branch that actually reaches a provider.
   */
  export async function POST(req: Request): Promise<Response> {
    try {
      // Read at request time, never a module const: the flag gates the route, and a test flips it.
      if (process.env.NEXT_PUBLIC_FEATURE_SCAN !== "1") {
        throw new HttpError(404, "not_found", "That is not available.");
      }
      await enforceRateLimit(`barcode:ip:${clientIp(req)}`, 600, WINDOW_SECONDS);
      const { userId, client } = await requireUser(req);
      await enforceRateLimit(`barcode:${userId}`, 120, WINDOW_SECONDS);
      const body = await readJson(req, Body, MAX_BODY_BYTES);
      const answer = await resolveBarcode(client, adminClient(), userId, body, {
        onOutbound: () => enforceRateLimit(`barcode:out:${userId}`, 20, WINDOW_SECONDS),
      });
      return Response.json(answer);
    } catch (e) {
      const res = jsonError(e);
      return res.status === 429 ? withRetryAfter(res, WINDOW_SECONDS) : res;
    }
  }
  ```
  The client reads `retryAfterMs` from the `Retry-After` header (`seconds × 1000`) rather than the body, so `BarcodeError.retryAfterMs` stays a client-side derivation of the header the route already sets — Task 12 does that conversion.
- [ ] Run it: `pnpm test tests/barcode/route.test.ts` — expect PASS (10 tests).
- [ ] Commit: `git add app/api/foods/barcode/route.ts tests/barcode/route.test.ts && git commit -m "feat(api): POST /api/foods/barcode behind NEXT_PUBLIC_FEATURE_SCAN"`

---

## Task 11 — Cache a scanned revision by GTIN, and queue offline scans

**Files**
- Modify: `lib/db/catalog-cache.ts` — `CachedRevision` at line 17, and a new `getByGtin` after `getRevision` (line 32)
- Create: `lib/barcode/scan-cache.ts`
- Test: `tests/barcode/scan-cache.test.ts`

**Interfaces**
- Consumes: `CATALOG_STORE`, `openSmcDb` (`lib/sync/idb.ts`); `getRevision`, `putRevision`, `CachedRevision` (`lib/db/catalog-cache.ts`).
- Produces:
  ```ts
  // lib/db/catalog-cache.ts
  export type CachedRevision = { …; gtin14?: string };
  export async function getByGtin(gtin14: string): Promise<CachedRevision | undefined>;
  // lib/barcode/scan-cache.ts
  export const PENDING_SCANS_KEY = "smc:pending_scans";
  export type PendingScan = { gtin14: string; at: string };
  export async function rememberScan(gtin14: string, revision: CachedRevision): Promise<void>;
  export async function resolveOffline(gtin14: string): Promise<CachedRevision | null>;
  export function readPendingScans(): PendingScan[];
  export function addPendingScan(gtin14: string, at?: string): void;
  export function clearPendingScan(gtin14: string): void;
  export function startPendingScanReplay(replay: (gtin14: string) => Promise<void>): () => void;
  ```

**Steps**

- [ ] Write the failing test `tests/barcode/scan-cache.test.ts`:
  ```ts
  import "fake-indexeddb/auto";
  import { IDBFactory } from "fake-indexeddb";
  import { beforeEach, describe, expect, it, vi } from "vitest";
  import { getByGtin, type CachedRevision } from "@/lib/db/catalog-cache";
  import {
    addPendingScan, clearPendingScan, PENDING_SCANS_KEY, readPendingScans,
    rememberScan, resolveOffline, startPendingScanReplay,
  } from "@/lib/barcode/scan-cache";
  import { closeSmcDb } from "@/lib/sync/idb";

  const GTIN = "04006381333931";

  function revision(id: number): CachedRevision {
    return {
      revision_id: id, catalog_food_id: id * 10, description: "Apple & blueberry pouch",
      brand: "Ella's Kitchen", source: "off", version_label: "off-2026-09-19",
      per_100g: { energy_kcal: 60, iron: null }, portions: [], cached_at: "2026-09-19T12:00:00.000Z",
    };
  }

  const store = new Map<string, string>();
  beforeEach(async () => {
    await closeSmcDb();
    globalThis.indexedDB = new IDBFactory();
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });

  describe("the scan cache", () => {
    it("stores the revision under its GTIN and reads it back offline", async () => {
      await rememberScan(GTIN, revision(34));
      expect((await getByGtin(GTIN))?.revision_id).toBe(34);
      expect((await resolveOffline(GTIN))?.description).toBe("Apple & blueberry pouch");
      expect(await resolveOffline("00000096385074")).toBeNull();
    });

    it("keeps the revision_id key, so a searched and a scanned row are one row", async () => {
      await rememberScan(GTIN, revision(34));
      await rememberScan(GTIN, { ...revision(34), description: "Renamed" });
      expect((await getByGtin(GTIN))?.description).toBe("Renamed");
    });
  });

  describe("the pending scan queue", () => {
    it("queues one row per GTIN and clears it", () => {
      addPendingScan(GTIN, "2026-09-19T12:00:00.000Z");
      addPendingScan(GTIN, "2026-09-19T12:00:05.000Z");
      expect(readPendingScans()).toEqual([{ gtin14: GTIN, at: "2026-09-19T12:00:00.000Z" }]);
      expect(store.get(PENDING_SCANS_KEY)).toContain(GTIN);
      clearPendingScan(GTIN);
      expect(readPendingScans()).toEqual([]);
    });

    it("survives unparseable storage", () => {
      store.set(PENDING_SCANS_KEY, "{{{");
      expect(readPendingScans()).toEqual([]);
    });

    it("replays every queued scan on the online event and unsubscribes", async () => {
      const listeners: Record<string, EventListener[]> = {};
      vi.stubGlobal("window", {
        addEventListener: (t: string, fn: EventListener) => { (listeners[t] ??= []).push(fn); },
        removeEventListener: (t: string, fn: EventListener) => {
          listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
        },
      });
      addPendingScan(GTIN, "2026-09-19T12:00:00.000Z");
      const replay = vi.fn().mockResolvedValue(undefined);
      const stop = startPendingScanReplay(replay);
      listeners.online[0](new Event("online"));
      await vi.waitFor(() => expect(replay).toHaveBeenCalledWith(GTIN));
      expect(readPendingScans()).toEqual([]);
      stop();
      expect(listeners.online).toEqual([]);
    });
  });
  ```
- [ ] Run it: `pnpm test tests/barcode/scan-cache.test.ts` — expect `getByGtin is not a function` / unresolved `@/lib/barcode/scan-cache`.
- [ ] Modify `lib/db/catalog-cache.ts`. Add the field to `CachedRevision` (after `portions` at line 26):
  ```ts
    portions: CachedPortion[];
    /** Phase 3: the GTIN this revision was last scanned under, so an offline repeat resolves. */
    gtin14?: string;
    cached_at: string;
  ```
  and the lookup after `getRevision` (line 32):
  ```ts
  /**
   * Revision for a GTIN-14. A full scan of the store, not an index: the cache holds at most ~500
   * rows (spec "Offline"), an index would need another DB_VERSION bump, and DB_VERSION belongs to
   * Lane L this wave.
   */
  export async function getByGtin(gtin14: string): Promise<CachedRevision | undefined> {
    const rows = (await (await openSmcDb()).getAll(CATALOG_STORE)) as CachedRevision[];
    return rows.find((row) => row.gtin14 === gtin14);
  }
  ```
- [ ] Write `lib/barcode/scan-cache.ts`:
  ```ts
  /**
   * The offline half of the scan path (spec "Client changes" → Offline, AC 5). Every resolved
   * barcode is written into the existing catalog_revisions store with its GTIN attached, so a
   * repeat scan in airplane mode resolves from the phone and logs. A scan we could not resolve is
   * queued under localStorage rather than failing silently, and replayed when the link returns.
   */
  import { getByGtin, putRevision, type CachedRevision } from "@/lib/db/catalog-cache";

  export const PENDING_SCANS_KEY = "smc:pending_scans";
  export type PendingScan = { gtin14: string; at: string };

  export async function rememberScan(gtin14: string, revision: CachedRevision): Promise<void> {
    await putRevision({ ...revision, gtin14 });
  }

  export async function resolveOffline(gtin14: string): Promise<CachedRevision | null> {
    return (await getByGtin(gtin14)) ?? null;
  }

  export function readPendingScans(): PendingScan[] {
    try {
      const raw = localStorage.getItem(PENDING_SCANS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed as PendingScan[]) : [];
    } catch {
      return [];
    }
  }

  function writePendingScans(rows: PendingScan[]): void {
    try {
      localStorage.setItem(PENDING_SCANS_KEY, JSON.stringify(rows));
    } catch {
      /* private browsing: the queue is a convenience, never the log itself */
    }
  }

  /** One row per GTIN; the first sighting keeps its timestamp. */
  export function addPendingScan(gtin14: string, at: string = new Date().toISOString()): void {
    const rows = readPendingScans();
    if (rows.some((r) => r.gtin14 === gtin14)) return;
    writePendingScans([...rows, { gtin14, at }]);
  }

  export function clearPendingScan(gtin14: string): void {
    writePendingScans(readPendingScans().filter((r) => r.gtin14 !== gtin14));
  }

  /** Replay on reconnect. Returns the unsubscribe the sheet calls on unmount. */
  export function startPendingScanReplay(replay: (gtin14: string) => Promise<void>): () => void {
    if (typeof window === "undefined") return () => {};
    const onOnline = (): void => {
      for (const row of readPendingScans()) {
        void replay(row.gtin14).then(
          () => clearPendingScan(row.gtin14),
          () => {/* still unreachable: the row stays queued for the next online event */}
        );
      }
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }
  ```
- [ ] Run it: `pnpm test tests/barcode/scan-cache.test.ts` — expect PASS (5 tests). Also `pnpm test lib/db/catalog-cache.test.ts` — expect the landed Lane I suite still PASS (the new field is optional).
- [ ] Commit: `git add lib/db/catalog-cache.ts lib/barcode/scan-cache.ts tests/barcode/scan-cache.test.ts && git commit -m "feat(db): cache a scanned revision by GTIN and queue offline scans"`

---

## Task 12 — Wire types, scanGtin and the BarcodeMatch cache mapper

**Files**
- Create: `lib/barcode/client.ts`
- Test: `tests/barcode/client.test.ts`

**Interfaces**
- Consumes: `CachedRevision` (`lib/db/catalog-cache.ts`); `resolveOffline` (Task 11); `PolicyVerdict` (`lib/policy/constraints.ts`, pre-lane); `CatalogSource` is re-declared here rather than imported, because `lib/server/catalog.ts` throws in a browser bundle.
- Produces (wire types exactly as the Phase 3 spec's "API changes"):
  ```ts
  export type BarcodeRequest = { gtin: string; hint?: { brand?: string; name?: string } };
  export type BarcodeMatch = {
    foodRefId: string; catalogFoodId: number; revisionId: number;
    description: string; brand: string | null;
    source: "fdc_foundation" | "fdc_sr_legacy" | "fdc_fndds" | "fdc_branded" | "off";
    qualityClass: "analytical" | "survey" | "label" | "crowd";
    per100g: Record<string, number | null>;
    portions: { id: number; description: string; gramWeight: number; isDefault: boolean }[];
    ingredientsText: string | null; allergenTags: string[];
    attribution: string | null; policy: PolicyVerdict;
  };
  export type BarcodeResponse =
    | { status: "resolved";  gtin14: string; cached: boolean; match: BarcodeMatch }
    | { status: "ambiguous"; gtin14: string; cached: boolean; matches: BarcodeMatch[] }
    | { status: "not_found"; gtin14: string; searchHint: { brand?: string; name?: string } };
  export type BarcodeError = {
    error: "invalid_gtin" | "unauthorized" | "rate_limited" | "upstream_unavailable";
    retryAfterMs?: number;
  };
  export const SCAN_FORMATS: readonly string[];
  export type ScanRequest = { id: number; data: ImageData };
  export type ScanReply = { id: number; results: { text: string; format: string }[] };
  export class ScanUnavailable extends Error { constructor(public gtin14: string, public retryAfterMs?: number) }
  export async function scanGtin(req: BarcodeRequest, opts?: { fetchImpl?: typeof fetch }): Promise<BarcodeResponse>;
  export function toCachedRevision(match: BarcodeMatch, gtin14: string, now?: number): CachedRevision;
  export { resolveOffline } from "@/lib/barcode/scan-cache";
  ```
  Contracts §2 puts `resolveOffline` on `lib/barcode/client.ts` and this lane's brief puts it on `lib/barcode/scan-cache.ts`. It is implemented once, in `scan-cache.ts`, and re-exported here, so both spellings resolve to the same function.

**Steps**

- [ ] Write the failing test `tests/barcode/client.test.ts`:
  ```ts
  import { describe, expect, it, vi } from "vitest";
  import { SCAN_FORMATS, ScanUnavailable, scanGtin, toCachedRevision, type BarcodeMatch } from "@/lib/barcode/client";

  const GTIN = "04006381333931";

  const MATCH: BarcodeMatch = {
    foodRefId: "11111111-1111-4111-8111-111111111111", catalogFoodId: 12, revisionId: 34,
    description: "Apple & blueberry pouch", brand: "Ella's Kitchen", source: "off",
    qualityClass: "crowd", per100g: { energy_kcal: 60, iron: null },
    portions: [{ id: 5, description: "1 pouch (90 g)", gramWeight: 90, isDefault: true }],
    ingredientsText: "Apple juice concentrate", allergenTags: ["apple"],
    attribution: "Data from Open Food Facts (ODbL)", policy: { verdict: "blocked", reason: "allergen:apple" },
  };

  const RESOLVED = { status: "resolved" as const, gtin14: GTIN, cached: true, match: MATCH };

  function res(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  describe("scanGtin", () => {
    it("posts the request and returns the response body", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(res(RESOLVED));
      expect(await scanGtin({ gtin: GTIN }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
        .toEqual(RESOLVED);
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("/api/foods/barcode");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ gtin: GTIN });
    });

    it("throws ScanUnavailable with the Retry-After in ms on a 429", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        res({ error: "rate_limited", message: "slow down" }, 429, { "retry-after": "60" }));
      await expect(scanGtin({ gtin: GTIN }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
        .rejects.toMatchObject({ gtin14: GTIN, retryAfterMs: 60_000 });
    });

    it.each([[503], [500], [404]])("throws ScanUnavailable on a %i", async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue(res({ error: "upstream_unavailable" }, status));
      await expect(scanGtin({ gtin: GTIN }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
        .rejects.toBeInstanceOf(ScanUnavailable);
    });

    it("throws ScanUnavailable when the network is gone", async () => {
      const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      await expect(scanGtin({ gtin: GTIN }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
        .rejects.toBeInstanceOf(ScanUnavailable);
    });

    it("does NOT swallow a 400: a bad barcode is an answer the sheet must show", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(res({ error: "invalid_gtin" }, 400));
      await expect(scanGtin({ gtin: "abc" }, { fetchImpl: fetchImpl as unknown as typeof fetch }))
        .rejects.toMatchObject({ name: "BarcodeRejected" });
    });
  });

  describe("toCachedRevision", () => {
    it("flattens a match into the shape buildCommitRequest takes", () => {
      const row = toCachedRevision(MATCH, GTIN, Date.parse("2026-09-19T12:00:00.000Z"));
      expect(row).toEqual({
        revision_id: 34, catalog_food_id: 12, description: "Apple & blueberry pouch",
        brand: "Ella's Kitchen", source: "off", version_label: "Data from Open Food Facts (ODbL)",
        per_100g: { energy_kcal: 60, iron: null },
        portions: [{ id: 5, description: "1 pouch (90 g)", gramWeight: 90, isDefault: true }],
        gtin14: GTIN, cached_at: "2026-09-19T12:00:00.000Z",
      });
      expect(row.per_100g.iron).toBeNull();
    });
  });

  describe("SCAN_FORMATS", () => {
    it("is the six symbologies on a grocery package", () => {
      expect(SCAN_FORMATS).toEqual(["EAN-8", "UPC-A", "UPC-E", "EAN-13", "ITF", "Code128"]);
    });
  });
  ```
- [ ] Run it: `pnpm test tests/barcode/client.test.ts` — expect `Failed to resolve import "@/lib/barcode/client"`.
- [ ] Write `lib/barcode/client.ts`:
  ```ts
  /**
   * The browser half of the barcode path, plus the wire types both halves share (the server reads
   * them with `import type`, so nothing browser-shaped reaches the server bundle).
   *
   * scanGtin distinguishes three outcomes on purpose. A BarcodeResponse is an answer, including
   * `not_found`. A transport failure, a 429 or a 5xx is ScanUnavailable — the sheet falls back to
   * the IndexedDB cache and, failing that, queues the scan. A 400 is BarcodeRejected: the camera
   * read something that is not a GTIN, and she has to see that rather than a silent retry.
   */
  import type { CachedRevision } from "@/lib/db/catalog-cache";
  import type { PolicyVerdict } from "@/lib/policy/constraints";

  export { resolveOffline } from "@/lib/barcode/scan-cache";

  export type BarcodeRequest = { gtin: string; hint?: { brand?: string; name?: string } };

  export type BarcodeMatch = {
    foodRefId: string; catalogFoodId: number; revisionId: number;
    description: string; brand: string | null;
    source: "fdc_foundation" | "fdc_sr_legacy" | "fdc_fndds" | "fdc_branded" | "off";
    qualityClass: "analytical" | "survey" | "label" | "crowd";
    /** null = not measured, 0 = measured zero (architecture §3.3). */
    per100g: Record<string, number | null>;
    portions: { id: number; description: string; gramWeight: number; isDefault: boolean }[];
    ingredientsText: string | null;
    allergenTags: string[];
    attribution: string | null;
    policy: PolicyVerdict;
  };

  export type BarcodeResponse =
    | { status: "resolved"; gtin14: string; cached: boolean; match: BarcodeMatch }
    | { status: "ambiguous"; gtin14: string; cached: boolean; matches: BarcodeMatch[] }
    | { status: "not_found"; gtin14: string; searchHint: { brand?: string; name?: string } };

  export type BarcodeError = {
    error: "invalid_gtin" | "unauthorized" | "rate_limited" | "upstream_unavailable";
    retryAfterMs?: number;
  };

  /** The six symbologies on a grocery package. zxing-wasm spells Code 128 "Code128". */
  export const SCAN_FORMATS = ["EAN-8", "UPC-A", "UPC-E", "EAN-13", "ITF", "Code128"] as const;

  export type ScanRequest = { id: number; data: ImageData };
  export type ScanReply = { id: number; results: { text: string; format: string }[] };

  export class ScanUnavailable extends Error {
    constructor(public gtin14: string, public retryAfterMs?: number) {
      super("The scan service is unreachable.");
      this.name = "ScanUnavailable";
    }
  }

  export class BarcodeRejected extends Error {
    constructor(public code: BarcodeError["error"]) {
      super("That is not a barcode we can read.");
      this.name = "BarcodeRejected";
    }
  }

  export async function scanGtin(
    req: BarcodeRequest,
    opts: { fetchImpl?: typeof fetch } = {}
  ): Promise<BarcodeResponse> {
    const doFetch = opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch("/api/foods/barcode", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(req),
      });
    } catch {
      throw new ScanUnavailable(req.gtin);
    }
    if (res.ok) return (await res.json()) as BarcodeResponse;
    if (res.status === 400) {
      const body = (await res.json().catch(() => ({}))) as Partial<BarcodeError>;
      throw new BarcodeRejected(body.error ?? "invalid_gtin");
    }
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ScanUnavailable(req.gtin, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
  }

  /**
   * A match, flattened into the row buildCommitRequest and computeSnapshot take. `version_label`
   * carries the attribution string so the ODbL notice survives into the offline snapshot's
   * source_version, which is what the food detail screen and a CSV export read (AC 12).
   */
  export function toCachedRevision(
    match: BarcodeMatch,
    gtin14: string,
    now: number = Date.now()
  ): CachedRevision {
    return {
      revision_id: match.revisionId,
      catalog_food_id: match.catalogFoodId,
      description: match.description,
      brand: match.brand,
      source: match.source,
      version_label: match.attribution ?? match.source,
      per_100g: match.per100g,
      portions: match.portions,
      gtin14,
      cached_at: new Date(now).toISOString(),
    };
  }
  ```
- [ ] Run it: `pnpm test tests/barcode/client.test.ts tests/barcode/resolve.test.ts` — expect PASS (9 + 8 tests; the resolve suite's `import type` now resolves).
- [ ] Commit: `git add lib/barcode/client.ts tests/barcode/client.test.ts && git commit -m "feat(barcode): scanGtin client, wire types and the match-to-cache mapper"`

---

## Task 13 — The zxing-wasm reader worker

**Files**
- Create: `lib/barcode/worker.ts`
- Test: covered by `tests/barcode/client.test.ts`'s `SCAN_FORMATS` case (Task 12). The worker body itself is exercised by the phone gate in Task 14 — it needs a real `ImageData` and a real wasm instance, and neither exists in the node environment vitest runs.

**Interfaces**
- Consumes: `prepareZXingModule`, `readBarcodes` from `zxing-wasm/reader` (pre-lane dependency); `SCAN_FORMATS`, `ScanRequest`, `ScanReply` from `lib/barcode/client.ts` (Task 12); `public/zxing/` populated by the pre-lane `scripts/copy-zxing-wasm.mjs` on postinstall.
- Produces: a module-scope `message` handler that answers each `ScanRequest` with a `ScanReply`.

**Steps**

- [ ] Check the installed API before writing the import: `cat node_modules/zxing-wasm/README.md | head -80` and `sed -n '1,60p' node_modules/zxing-wasm/dist/es/reader/index.d.ts`. `zxing-wasm@2.2.4` is already installed on this checkout (pre-lane, contracts §0), and its `./reader` export ships exactly the 2.x API the code below is written against (`prepareZXingModule({ overrides })`, `readBarcodes(input, { formats, tryHarder })`, results carrying `text` / `format` / `isValid`) — this step confirms that against the real typings rather than assuming it. If the installed typings disagree, fix the call shape here and nowhere else — `SCAN_FORMATS` and the message types stay as they are.
- [ ] Write `lib/barcode/worker.ts`:
  ```ts
  /**
   * The decoder, off the main thread. The camera loop in BarcodeScanSheet posts an ImageData every
   * 150 ms and gets back whatever zxing found; the quorum rule decides when that is trustworthy.
   *
   * The .wasm is served from /zxing/ (copied out of node_modules by scripts/copy-zxing-wasm.mjs on
   * postinstall, never committed, never fetched from a CDN), so the scanner works offline and the
   * CSP needs no third-party origin (spec "Client changes").
   */
  import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
  import { SCAN_FORMATS, type ScanReply, type ScanRequest } from "@/lib/barcode/client";

  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) =>
        path.endsWith(".wasm") ? `/zxing/${path}` : `${prefix}${path}`,
    },
  });

  self.addEventListener("message", (event: MessageEvent<ScanRequest>) => {
    const { id, data } = event.data;
    void readBarcodes(data, { formats: [...SCAN_FORMATS], tryHarder: true })
      .then((results) => {
        const reply: ScanReply = {
          id,
          results: results
            .filter((r) => r.isValid !== false && typeof r.text === "string" && r.text.length > 0)
            .map((r) => ({ text: r.text, format: String(r.format) })),
        };
        (self as unknown as Worker).postMessage(reply);
      })
      .catch(() => {
        (self as unknown as Worker).postMessage({ id, results: [] } satisfies ScanReply);
      });
  });
  ```
- [ ] Run: `pnpm exec tsc --noEmit` — expect no error from this file. (`pnpm test tests/barcode/client.test.ts` still PASSes; no node test imports the worker.)
- [ ] Commit: `git add lib/barcode/worker.ts && git commit -m "feat(barcode): zxing-wasm reader worker served from /zxing"`

---

## Task 14 — BarcodeScanSheet

**Files**
- Create: `components/BarcodeScanSheet.tsx`
- Test: manual phone gate, described below. `@testing-library/react` is not installed and no dependency may be added, so there is no render test; every decision this component makes that *can* be tested in node already is — `acceptReading` (Task 2), `scanGtin` (Task 12), `resolveOffline` (Task 11).

**Interfaces**
- Consumes: `Sheet` (`components/Sheet.tsx`, props `{ title, subtitle?, onClose, children, footer? }`); `acceptReading`, `pruneHistory`, `type Reading` (Task 2); `SCAN_FORMATS` is the worker's business, `ScanReply`, `scanGtin`, `ScanUnavailable`, `BarcodeRejected`, `toCachedRevision`, `type BarcodeResponse` (Task 12); `rememberScan`, `resolveOffline`, `addPendingScan` (Task 11).
- Produces:
  ```ts
  export default function BarcodeScanSheet(props: {
    onResolved: (response: BarcodeResponse) => void;
    onClose: () => void;
    hint?: { brand?: string; name?: string };
  }): React.JSX.Element;
  ```

**Steps**

- [ ] Write `components/BarcodeScanSheet.tsx`:
  ```tsx
  "use client";

  import { useCallback, useEffect, useRef, useState } from "react";
  import Sheet from "@/components/Sheet";
  import {
    BarcodeRejected, ScanUnavailable, scanGtin, toCachedRevision,
    type BarcodeResponse, type ScanReply,
  } from "@/lib/barcode/client";
  import { acceptReading, pruneHistory, type Reading } from "@/lib/barcode/quorum";
  import { addPendingScan, rememberScan, resolveOffline } from "@/lib/barcode/scan-cache";

  /** One frame to the worker every 150 ms. Faster burns battery; slower feels like a stall. */
  const FRAME_INTERVAL_MS = 150;
  const FRAME_WIDTH = 640;

  type Phase = "starting" | "scanning" | "resolving" | "denied" | "unreadable" | "offline";

  const MESSAGES: Record<Phase, string> = {
    starting: "Starting the camera…",
    scanning: "Point the camera at the barcode.",
    resolving: "Looking it up…",
    denied: "The camera is blocked. Allow it in Settings, or search for the food instead.",
    unreadable: "That is not a barcode we can read. Try the other side of the pack.",
    offline: "No connection, and this one is not on the phone yet. It will retry when you are back.",
  };

  export default function BarcodeScanSheet({
    onResolved, onClose, hint,
  }: {
    onResolved: (response: BarcodeResponse) => void;
    onClose: () => void;
    hint?: { brand?: string; name?: string };
  }) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const workerRef = useRef<Worker | null>(null);
    const historyRef = useRef<Reading[]>([]);
    const busyRef = useRef(false);
    const [phase, setPhase] = useState<Phase>("starting");
    const [torchOn, setTorchOn] = useState(false);
    const [torchAvailable, setTorchAvailable] = useState(false);

    const resolve = useCallback(
      async (gtin: string) => {
        busyRef.current = true;
        setPhase("resolving");
        try {
          const response = await scanGtin({ gtin, hint });
          if (response.status === "resolved") {
            await rememberScan(response.gtin14, toCachedRevision(response.match, response.gtin14));
          }
          onResolved(response);
        } catch (e) {
          if (e instanceof BarcodeRejected) {
            setPhase("unreadable");
            busyRef.current = false;
            return;
          }
          if (!(e instanceof ScanUnavailable)) throw e;
          const cached = await resolveOffline(e.gtin14);
          if (cached) {
            onResolved({
              status: "resolved", gtin14: e.gtin14, cached: true,
              match: {
                foodRefId: "", catalogFoodId: cached.catalog_food_id, revisionId: cached.revision_id,
                description: cached.description, brand: cached.brand,
                source: cached.source as "off", qualityClass: "crowd", per100g: cached.per_100g,
                portions: cached.portions, ingredientsText: null, allergenTags: [],
                attribution: cached.version_label, policy: { verdict: "unverified" },
              },
            });
            return;
          }
          addPendingScan(e.gtin14);
          setPhase("offline");
          busyRef.current = false;
        }
      },
      [hint, onResolved]
    );

    /* One reading is never enough: a curved pouch reads a wrong digit often enough that a single
       frame cannot be trusted. acceptReading holds the line (spec "Engines and logic"). */
    const onReply = useCallback(
      (reply: ScanReply) => {
        if (busyRef.current) return;
        const at = Date.now();
        for (const result of reply.results) {
          const next: Reading = { text: result.text, format: result.format, at };
          const accepted = acceptReading(historyRef.current, next);
          historyRef.current = pruneHistory([...historyRef.current, next], at);
          if (accepted) {
            void resolve(accepted);
            return;
          }
        }
      },
      [resolve]
    );

    useEffect(() => {
      let raf = 0;
      let lastFrame = 0;
      let frameId = 0;
      let cancelled = false;
      const canvas = document.createElement("canvas");
      const worker = new Worker(new URL("../lib/barcode/worker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", (e: MessageEvent<ScanReply>) => onReply(e.data));
      workerRef.current = worker;

      /* Camera permission is asked at the scan tap, never at app load, and is never required to
         log (spec "Security"). */
      void navigator.mediaDevices
        .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } } })
        .then((stream) => {
          if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
          streamRef.current = stream;
          const track = stream.getVideoTracks()[0];
          const capabilities = track.getCapabilities?.() as { torch?: boolean } | undefined;
          setTorchAvailable(Boolean(capabilities?.torch));
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            void videoRef.current.play();
          }
          setPhase("scanning");
          const tick = (t: number): void => {
            raf = requestAnimationFrame(tick);
            const video = videoRef.current;
            if (!video || video.readyState < 2 || t - lastFrame < FRAME_INTERVAL_MS) return;
            lastFrame = t;
            const scale = FRAME_WIDTH / video.videoWidth;
            canvas.width = FRAME_WIDTH;
            canvas.height = Math.round(video.videoHeight * scale);
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (!ctx) return;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            frameId += 1;
            worker.postMessage({ id: frameId, data: ctx.getImageData(0, 0, canvas.width, canvas.height) });
          };
          raf = requestAnimationFrame(tick);
        })
        .catch(() => setPhase("denied"));

      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
        worker.terminate();
        streamRef.current?.getTracks().forEach((track) => track.stop());
      };
    }, [onReply]);

    function toggleTorch(): void {
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track) return;
      const next = !torchOn;
      void track
        .applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints)
        .then(() => setTorchOn(next))
        .catch(() => setTorchAvailable(false));
    }

    return (
      <Sheet title="Scan" subtitle={MESSAGES[phase]} onClose={onClose}>
        <div className="flex flex-col gap-4">
          <div
            className="relative w-full overflow-hidden"
            style={{ borderRadius: 24, aspectRatio: "4 / 3", background: "#232322" }}
          >
            <video
              ref={videoRef}
              muted
              playsInline
              className="h-full w-full object-cover"
              aria-label="Camera preview"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2"
              style={{
                width: "72%", height: 96, transform: "translate(-50%, -50%)",
                borderRadius: 16, border: "2px solid rgba(255,255,255,0.7)",
              }}
            />
          </div>
          {torchAvailable && (
            <button
              type="button"
              onClick={toggleTorch}
              aria-pressed={torchOn}
              className="pill tap self-start"
            >
              <span className="pill-in ts flex h-11 items-center px-4 text-tiny font-normal text-graphite">
                {torchOn ? "Light off" : "Light on"}
              </span>
            </button>
          )}
        </div>
      </Sheet>
    );
  }
  ```
  `Sheet` already draws a 44 × 44 px close control and a scrim that closes on tap, so the cancel target is the sheet's own and needs no second button.
- [ ] Run: `pnpm exec tsc --noEmit && pnpm lint` — expect both clean.
- [ ] **[manual gate]** On Devin's phone against a Vercel preview with `NEXT_PUBLIC_FEATURE_SCAN=1`: open `/scan`, confirm the camera prompt appears only at that moment; scan a packaged pouch and confirm the confirm sheet opens; confirm the torch pill appears on a device that supports it and lights the LED; confirm the sheet's close control is comfortably tappable one-handed; confirm nothing keeps the camera on after the sheet closes (the LED and the browser's camera indicator both go out).
- [ ] Commit: `git add components/BarcodeScanSheet.tsx && git commit -m "feat(scan): BarcodeScanSheet camera, worker loop and quorum"`

---

## Task 15 — ScanConfirmSheet

**Files**
- Create: `components/ScanConfirmSheet.tsx`
- Test: `tests/barcode/confirm.test.ts` (the exported pure helpers only — see Task 14 on why there is no render test)
- Modify: `lib/log/contract.ts` (the `METHODS` union), `lib/log-client.ts` (`buildCommitRequest`'s `method` field) — both shared files (contracts §1), so the first step below lands them as their own contract-change commit before this task's component commit
- Modify: `docs/plans/2026-09-11-phase-3-4/00-contracts.md` §2 (records the widened `METHODS` union and `buildCommitRequest` signature — the contract's own rule is that a change lands there first)

**Interfaces**
- Consumes: `Sheet`, `Pill` (`components/Sheet.tsx`); `Stepper` (`components/Stepper.tsx`, props `{ label, value, step, unit?, onChange, disabled?, helperText? }`); `buildCommitRequest`, `commitLogEntry` (`lib/log-client.ts`); `toCachedRevision`, `type BarcodeMatch`, `type BarcodeResponse` (Task 12); `type SlotId` (`lib/types.ts`).
- Produces:
  ```ts
  export function searchHintText(hint: { brand?: string; name?: string }): string;
  export function gramsFor(match: BarcodeMatch, portionId: number | null, qty: number): number;
  export function badgeFor(match: BarcodeMatch): { tone: "alert" | "amber" | "none"; label: string };
  export default function ScanConfirmSheet(props: {
    response: BarcodeResponse; slot: SlotId;
    onLogged: (entryId: string) => void; onClose: () => void;
    onSearch?: (hint: string) => void;
    onFavorite?: (foodRefId: string) => void;
  }): React.JSX.Element;
  ```

**Steps**

- [ ] Commit the contract change first: `lib/log/contract.ts`'s `METHODS` union is `["search","plan","text","voice","label","photo"]`, but `log_entries.method`'s database check (architecture §3.3) already allows `'barcode'` and contracts §2 asks this sheet to commit with it. Widen the union and give `buildCommitRequest` an optional `method` argument (default unchanged, so every existing caller is untouched):
  ```ts
  // lib/log/contract.ts
  const METHODS = ["search", "plan", "text", "voice", "label", "photo", "barcode"] as const;
  ```
  ```ts
  // lib/log-client.ts
  export function buildCommitRequest(args: {
    entryId: string; eatenAt: Date; tz: string; slot: SlotId; note?: string; baseRev?: number;
    method?: LogCommitRequest["method"];
    items: {
      id: string; foodRefId: string; revision: CachedRevision; grams: number;
      qty: number; unit: string; portionId?: number | null; wasEdited?: boolean;
    }[];
  }): LogCommitRequest {
    const items: LogItemInput[] = args.items.map((item, i) => ({
      id: item.id, seq: i + 1, food_ref_id: item.foodRefId,
      qty: item.qty, unit: item.unit, grams: item.grams,
      portion_id: item.portionId ?? null,
      food_revision_id: item.revision.revision_id,
      was_edited: item.wasEdited ?? false,
    }));
    const req: LogCommitRequest = {
      entry_id: args.entryId, eaten_at: args.eatenAt.toISOString(), tz: args.tz,
      local_date: localDateOf(args.eatenAt), slot: args.slot, method: args.method ?? "search", items,
    };
    if (args.baseRev !== undefined) req.base_rev = args.baseRev;
    if (args.note?.trim()) req.note = args.note.trim();
    return req;
  }
  ```
  Also append to `00-contracts.md` §2: `METHODS` gains `"barcode"`; `buildCommitRequest` gains an optional `method` argument defaulting to `"search"`.
  **Already landed in `00-contracts.md` (2026-09-11)** — read the contract section and confirm it says this; do not commit a contract change (docs: phase-3-4 contract change — commit method 'barcode')
- [ ] Write the failing test `tests/barcode/confirm.test.ts`:
  ```ts
  import { describe, expect, it } from "vitest";
  import { badgeFor, gramsFor, searchHintText } from "@/components/ScanConfirmSheet";
  import type { BarcodeMatch } from "@/lib/barcode/client";

  const MATCH: BarcodeMatch = {
    foodRefId: "11111111-1111-4111-8111-111111111111", catalogFoodId: 12, revisionId: 34,
    description: "Apple & blueberry pouch", brand: "Ella's Kitchen", source: "off",
    qualityClass: "crowd", per100g: { energy_kcal: 60 },
    portions: [{ id: 5, description: "1 pouch (90 g)", gramWeight: 90, isDefault: true }],
    ingredientsText: "Apple juice concentrate", allergenTags: ["apple"],
    attribution: "Data from Open Food Facts (ODbL)", policy: { verdict: "blocked", reason: "allergen:apple" },
  };

  describe("searchHintText", () => {
    it("joins what she can read off the package, in that order", () => {
      expect(searchHintText({ brand: "Ella's Kitchen", name: "pouch" })).toBe("Ella's Kitchen pouch");
      expect(searchHintText({ name: "pouch" })).toBe("pouch");
      expect(searchHintText({})).toBe("");
    });
  });

  describe("gramsFor", () => {
    it("multiplies the chosen portion, and falls back to 100 g per unit", () => {
      expect(gramsFor(MATCH, 5, 2)).toBe(180);
      expect(gramsFor(MATCH, null, 1.5)).toBe(150);
      expect(gramsFor({ ...MATCH, portions: [] }, 5, 1)).toBe(100);
    });
  });

  describe("badgeFor", () => {
    it("names the allergen on a blocked verdict", () => {
      expect(badgeFor(MATCH)).toEqual({ tone: "alert", label: "Contains apple" });
    });

    it("is amber and honest when there is no ingredient evidence", () => {
      expect(badgeFor({ ...MATCH, policy: { verdict: "unverified" }, allergenTags: [] }))
        .toEqual({ tone: "amber", label: "No ingredient list — check the pack" });
    });

    it("shows nothing when the food is allowed", () => {
      expect(badgeFor({ ...MATCH, policy: { verdict: "allowed" }, allergenTags: [] }).tone).toBe("none");
    });
  });
  ```
- [ ] Run it: `pnpm test tests/barcode/confirm.test.ts` — expect `Failed to resolve import "@/components/ScanConfirmSheet"`.
- [ ] Write `components/ScanConfirmSheet.tsx`:
  ```tsx
  "use client";

  import { useState } from "react";
  import Sheet, { Pill } from "@/components/Sheet";
  import Stepper from "@/components/Stepper";
  import { toCachedRevision, type BarcodeMatch, type BarcodeResponse } from "@/lib/barcode/client";
  import { buildCommitRequest, commitLogEntry } from "@/lib/log-client";
  import type { SlotId } from "@/lib/types";

  /* Row recipe copied from LogMeal.dc.html: 16 px radius on a white gradient with the hairline
     shell shadow. The ink button is that file's 52 px primary. */
  const ROW: React.CSSProperties = {
    borderRadius: 16,
    background: "linear-gradient(180deg, #ffffff 0%, #fcfcfc 100%)",
    boxShadow:
      "0 2px 3px -1px rgba(0,0,0,0.10), 0 1px 0 0 rgba(25,28,33,0.02), 0 0 0 1px rgba(25,28,33,0.08)",
  };
  const INK_BUTTON: React.CSSProperties = {
    height: 52, fontSize: 15, fontWeight: 400,
    boxShadow:
      "inset 0 1px 1px rgba(255,255,255,0.15), 0 2px 3px -1px rgba(0,0,0,0.1), 0 0 0 1px rgba(25,28,33,0.08)",
  };
  const META: React.CSSProperties = { fontSize: 12, fontWeight: 300, color: "#6B6B6B" };
  const SECTION: React.CSSProperties = { fontSize: 12, fontWeight: 400, color: "#4A4A4A" };

  export function searchHintText(hint: { brand?: string; name?: string }): string {
    return [hint.brand, hint.name].filter((p) => p && p.trim().length > 0).join(" ").trim();
  }

  export function gramsFor(match: BarcodeMatch, portionId: number | null, qty: number): number {
    const portion = match.portions.find((p) => p.id === portionId);
    const per = portion?.gramWeight ?? 100;
    return Math.round(per * qty * 10) / 10;
  }

  /** Marking, never hiding: a blocked food still logs, it just says what it contains first. */
  export function badgeFor(match: BarcodeMatch): { tone: "alert" | "amber" | "none"; label: string } {
    if (match.policy.verdict === "blocked") {
      const tag = match.policy.reason?.startsWith("allergen:")
        ? match.policy.reason.slice("allergen:".length)
        : match.allergenTags[0];
      return { tone: "alert", label: tag ? `Contains ${tag}` : "Off-plan" };
    }
    if (match.policy.verdict === "unverified") {
      return { tone: "amber", label: "No ingredient list — check the pack" };
    }
    return { tone: "none", label: "" };
  }

  function Badge({ match }: { match: BarcodeMatch }) {
    const badge = badgeFor(match);
    if (badge.tone === "none") return null;
    return (
      <span className="pill inline-flex">
        <span
          className={`pill-in ts flex h-[30px] items-center px-3 text-tiny font-normal ${
            badge.tone === "alert" ? "text-alert" : "text-amber"
          }`}
        >
          {badge.label}
        </span>
      </span>
    );
  }

  function StarIcon({ filled }: { filled: boolean }) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"
        fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />
      </svg>
    );
  }

  export default function ScanConfirmSheet({
    response, slot, onLogged, onClose, onSearch, onFavorite,
  }: {
    response: BarcodeResponse;
    slot: SlotId;
    onLogged: (entryId: string) => void;
    onClose: () => void;
    onSearch?: (hint: string) => void;
    onFavorite?: (foodRefId: string) => void;
  }) {
    const first = response.status === "resolved" ? response.match
      : response.status === "ambiguous" ? response.matches[0] : null;
    const [picked, setPicked] = useState<BarcodeMatch | null>(
      response.status === "resolved" ? first : null
    );
    const [portionId, setPortionId] = useState<number | null>(
      first?.portions.find((p) => p.isDefault)?.id ?? first?.portions[0]?.id ?? null
    );
    const [qty, setQty] = useState(1);
    const [starred, setStarred] = useState(false);
    const [saving, setSaving] = useState(false);

    async function logIt(match: BarcodeMatch): Promise<void> {
      setSaving(true);
      const at = new Date();
      const entryId = crypto.randomUUID();
      const itemId = crypto.randomUUID();
      const grams = gramsFor(match, portionId, qty);
      const request = buildCommitRequest({
        entryId, eatenAt: at, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, slot,
        method: "barcode",
        items: [{
          id: itemId, foodRefId: match.foodRefId,
          revision: toCachedRevision(match, response.status === "not_found" ? "" : response.gtin14),
          grams, qty, unit: portionId === null ? "g" : "portion", portionId,
        }],
      });
      const result = await commitLogEntry(request);
      if (result.status !== "ok" && result.status !== "queued") {
        console.warn("[scan] commit rejected", result.status, entryId);
      }
      onLogged(entryId);
    }

    if (response.status === "not_found") {
      const hint = searchHintText(response.searchHint);
      return (
        <Sheet
          title="Not in the database"
          subtitle="We do not know this barcode yet. Search for it by what is on the pack."
          onClose={onClose}
        >
          <div className="flex flex-col gap-3">
            <p className="m-0" style={META}>Barcode {response.gtin14}</p>
            <button
              type="button"
              onClick={() => onSearch?.(hint)}
              disabled={!onSearch}
              className="btn-ink tap w-full disabled:opacity-40"
              style={INK_BUTTON}
            >
              Search for it instead
            </button>
          </div>
        </Sheet>
      );
    }

    if (response.status === "ambiguous" && picked === null) {
      return (
        <Sheet title="Which one?" subtitle="This barcode matches more than one product." onClose={onClose}>
          <div className="flex flex-col gap-2">
            {response.matches.map((match) => (
              <button
                key={match.revisionId}
                type="button"
                onClick={() => {
                  setPicked(match);
                  setPortionId(match.portions.find((p) => p.isDefault)?.id ?? match.portions[0]?.id ?? null);
                }}
                className="tap flex w-full items-center gap-3 px-3.5 py-3 text-left"
                style={ROW}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="ts" style={{ fontSize: 14, fontWeight: 400 }}>{match.description}</span>
                  <span style={META}>{[match.brand, match.attribution].filter(Boolean).join(" · ")}</span>
                </span>
                <Badge match={match} />
              </button>
            ))}
          </div>
        </Sheet>
      );
    }

    const match = picked ?? first;
    if (!match) return <Sheet title="Scan" onClose={onClose}><div /></Sheet>;
    const grams = gramsFor(match, portionId, qty);

    return (
      <Sheet title={match.description} subtitle={match.brand ?? undefined} onClose={onClose}>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <Badge match={match} />
            {onFavorite && (
              <button
                type="button"
                aria-label="Favourite this food"
                aria-pressed={starred}
                onClick={() => { setStarred(true); onFavorite(match.foodRefId); }}
                className="tap flex items-center justify-center"
                style={{ width: 44, height: 44, borderRadius: 9999, color: "#4A4A4A" }}
              >
                <StarIcon filled={starred} />
              </button>
            )}
          </div>

          {match.portions.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="ts" style={SECTION}>Portion</span>
              <div className="flex flex-wrap gap-2">
                {match.portions.map((portion) => (
                  <Pill key={portion.id} active={portion.id === portionId} onClick={() => setPortionId(portion.id)}>
                    {portion.gramWeight} g · {portion.description}
                  </Pill>
                ))}
                <Pill active={portionId === null} onClick={() => setPortionId(null)}>100 g</Pill>
              </div>
            </div>
          )}

          <Stepper
            label="How many"
            value={qty}
            step={1}
            onChange={(next) => setQty(Math.max(1, next))}
            helperText={`${grams} g`}
          />

          {match.ingredientsText && (
            <div className="flex flex-col gap-1">
              <span className="ts" style={SECTION}>Ingredients</span>
              <p className="m-0" style={META}>{match.ingredientsText}</p>
            </div>
          )}

          {match.attribution && <p className="m-0" style={META}>{match.attribution}</p>}
        </div>
        <div className="pt-4">
          <button
            type="button"
            disabled={saving}
            onClick={() => void logIt(match)}
            className="btn-ink tap w-full disabled:opacity-40"
            style={INK_BUTTON}
          >
            Log it
          </button>
        </div>
      </Sheet>
    );
  }
  ```
- [ ] Run it: `pnpm test tests/barcode/confirm.test.ts && pnpm exec tsc --noEmit && pnpm lint` — expect PASS (5 tests) and both checks clean.
- [ ] **[manual gate]** On the phone: a resolved OFF pouch shows the product, the brand, the ODbL line, the ingredient list and a red "Contains apple" pill; the portion pills and the stepper both move the grams line; **Log it** puts the entry on Today; an ambiguous GTIN shows three rows and picking one opens this view; a `not_found` shows the search button.
- [ ] Commit: `git add components/ScanConfirmSheet.tsx tests/barcode/confirm.test.ts && git commit -m "feat(scan): ScanConfirmSheet with policy badge, portions and Log it"`

---

## Task 16 — The /scan page, the OFF rate probe and the NOTICE row

**Files**
- Create: `app/scan/page.tsx`
- Create: `scripts/off-rate-probe.ts`
- Modify: `NOTICE.md` — the fud-ai row (line 7)
- Test: manual phone gate; the probe is run by hand at integration and never in CI.

**Interfaces**
- Consumes: `BarcodeScanSheet` (Task 14); `ScanConfirmSheet` (Task 15); `loadStore` (`lib/store.ts`); `resolveDay` (`lib/resolve.ts`); `localDateOf` (`lib/log-client.ts`); `notFound`, `useRouter` (`next/navigation`); `fetchOffProduct`, `OFF_FIELDS`, `OFF_USER_AGENT` (Task 3).
- Produces: the `/scan` route, and `pnpm exec tsx scripts/off-rate-probe.ts`.

**Steps**

- [ ] Write `app/scan/page.tsx`:
  ```tsx
  "use client";

  import { notFound, useRouter } from "next/navigation";
  import { useState } from "react";
  import BarcodeScanSheet from "@/components/BarcodeScanSheet";
  import ScanConfirmSheet from "@/components/ScanConfirmSheet";
  import type { BarcodeResponse } from "@/lib/barcode/client";
  import { localDateOf } from "@/lib/log-client";
  import { resolveDay } from "@/lib/resolve";
  import { loadStore } from "@/lib/store";
  import type { SlotId } from "@/lib/types";

  function minutesOf(time: string): number {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
  }

  /** The last slot whose time has arrived — the same rule app/page.tsx uses to pick "Now". */
  function slotNow(at: Date): SlotId {
    const slots = resolveDay(loadStore(), localDateOf(at)).slots;
    const nowM = at.getHours() * 60 + at.getMinutes();
    let current: SlotId | null = null;
    for (const s of slots) if (minutesOf(s.time) <= nowM) current = s.slot;
    return current ?? slots[0]?.slot ?? "meal-1";
  }

  /**
   * The standalone scan entry, so the whole flow is testable on the phone before Today is wired
   * (contracts §2). Today's own Scan action arrives at integration with the same two sheets.
   */
  export default function ScanPage() {
    const router = useRouter();
    const [scanning, setScanning] = useState(true);
    const [response, setResponse] = useState<BarcodeResponse | null>(null);

    // Read at render, never a module const: the flag is baked at build and a rollback is a redeploy.
    if (process.env.NEXT_PUBLIC_FEATURE_SCAN !== "1") notFound();

    return (
      <main className="min-h-dvh">
        {scanning && (
          <BarcodeScanSheet
            onResolved={(r) => { setScanning(false); setResponse(r); }}
            onClose={() => router.push("/")}
          />
        )}
        {response && (
          <ScanConfirmSheet
            response={response}
            slot={slotNow(new Date())}
            onLogged={() => router.push("/")}
            onClose={() => router.push("/")}
          />
        )}
      </main>
    );
  }
  ```
- [ ] Write `scripts/off-rate-probe.ts`:
  ```ts
  /**
   * Measures the OFF per-IP read limit — Phase 3 spec open question 1, architecture §10, deferred
   * to this phase. Thirty sequential reads of known GTINs through the real fetcher, printing the
   * status and the rate-limit headers so the outbound budget in contracts §2 can stop being a
   * guess. Record the answer in docs/specs/phase-3-fast-capture.md "Open questions".
   *
   * [needs network] [never in CI] — run by hand at the integration stage:
   *   pnpm exec tsx scripts/off-rate-probe.ts
   */
  import { fetchOffProduct, isProviderFailure, OFF_FIELDS, OFF_USER_AGENT } from "@/lib/catalog/off";

  const GTINS = [
    "04006381333931", "00602652171000", "00038000138416", "00016000275263", "00021000658930",
    "00028400090063", "00044000032029", "00070847811169", "00013000001328", "00012000001086",
  ];

  async function main(): Promise<void> {
    console.log(`user-agent: ${OFF_USER_AGENT}`);
    console.log(`fields: ${OFF_FIELDS.join(",")}`);
    const started = Date.now();
    for (let i = 0; i < 30; i += 1) {
      const gtin = GTINS[i % GTINS.length];
      const at = Date.now();
      const result = await fetchOffProduct(gtin);
      const outcome = isProviderFailure(result) ? `FAIL ${String(result.status)}` : "ok";
      console.log(
        `${String(i + 1).padStart(2, "0")}  ${gtin}  ${outcome}  ${Date.now() - at} ms  ` +
        `t+${Math.round((Date.now() - started) / 1000)} s`
      );
    }
    console.log("Record the first refusal (if any) and its headers in the Phase 3 spec, open question 1.");
  }

  void main();
  ```
  The probe prints headers only for a refusal, which `fetchOffProduct` surfaces as its numeric status; if a `429` appears, re-run the failing code once with `curl -sI` and paste the `retry-after` / `x-ratelimit-*` lines into the spec. The fetcher is never changed to expose headers for the probe's convenience.
- [ ] Modify `NOTICE.md` line 7 — replace the placeholder row with the real one:
  ```markdown
  | apoorvdarshan/fud-ai — Copyright (c) 2026 Apoorv Darshan | MIT | Open Food Facts v2 field list, identifying `User-Agent` shape, and the "reject only when all four of energy/protein/carbs/fat are absent; never zero-fill a single missing nutrient" rule | `lib/catalog/off.ts`, `lib/catalog/off-map.ts`, `lib/catalog/fdc-map.ts` |
  ```
- [ ] Run: `pnpm exec tsc --noEmit && pnpm lint && pnpm build` — expect all three clean, and `/scan` to appear in the build output as a client route.
- [ ] **[manual gate]** With `NEXT_PUBLIC_FEATURE_SCAN` unset on a preview, `/scan` returns 404 and `POST /api/foods/barcode` returns 404. With it set to `1`, `/scan` opens the camera. **[needs network]** at integration: `pnpm exec tsx scripts/off-rate-probe.ts` and record the result.
- [ ] Commit: `git add app/scan/page.tsx scripts/off-rate-probe.ts NOTICE.md && git commit -m "feat(scan): /scan page, OFF rate probe and the fud-ai notice row"`

---

## Lane exit gate

Run once, in this order, before opening the PR. Never run the full suite twice (AGENTS.md "CI and branches").

1. `pnpm exec tsc --noEmit` — clean.
2. `pnpm lint` — clean.
3. `pnpm test tests/barcode/` — every suite green; `tests/barcode/schema.test.ts` reports SKIPPED with no branch.
4. `pnpm test lib/db/catalog-cache.test.ts lib/log-client.test.ts lib/search/gtin.test.ts` — the three landed suites this lane touches or reuses, still green.
5. `pnpm build` — clean.
6. **[needs branch]** `pnpm db:push && pnpm test tests/barcode/schema.test.ts tests/catalog/grants.test.ts` — the new migration applies on a Supabase branch, the writer's atomicity and grant tests pass, and Phase 1's catalog grant suite is unchanged.
7. Spec acceptance criteria this lane owns, each with the evidence that proves it:
   - **AC 1** — `tests/barcode/gtin.test.ts` (four lengths, leading zeros, bad check digit) + `tests/barcode/route.test.ts` "400s on an invalid GTIN".
   - **AC 2** — `tests/barcode/schema.test.ts` "writes version, food, revision, children, barcode and food_ref in one call" (exactly one of each) **[needs branch]**.
   - **AC 3** — `tests/barcode/resolve.test.ts` "serves a cached barcode with cached:true and no outbound call".
   - **AC 4** — `tests/barcode/resolve.test.ts` "falls OFF 404 → FDC 404 → not_found, and records the miss" + "makes no outbound call for a miss row younger than 7 days".
   - **AC 5** — `tests/barcode/scan-cache.test.ts` + the airplane-mode leg of the Phase 3 manual gate.
   - **AC 11** — `tests/barcode/schema.test.ts` "lets authenticated read the ledger and write nothing" and "refuses … a call from authenticated" **[needs branch]**.
   - **AC 12** — `pnpm test`, `pnpm lint`, `pnpm build` above; the ODbL line is carried by `attributionFor` into `BarcodeMatch.attribution`, rendered by `ScanConfirmSheet`, and into `CachedRevision.version_label` so it reaches the snapshot's `source_version`.
   - **AC 6** (three foods under 5 s) is the integration stage's phone gate, not this lane's.
8. Security review checklist, each a review-blocking defect if it fails: no module other than `lib/server/catalog-writer.ts` writes `catalog_*` from a request path (`grep -rn "catalog_write_provider_revision\|from(\"catalog_" app lib | grep -v "lib/server/catalog-writer.ts\|lib/server/barcode.ts\|lib/server/catalog.ts"` returns nothing); `grep -rn "openfoodfacts\|nal.usda.gov" lib app components` names only `lib/catalog/off.ts`, `lib/catalog/fdc.ts` and `scripts/off-rate-probe.ts`; no `image_front_url` or any media URL is fetched anywhere; `FDC_API_KEY` appears in no log line and no URL; `user_id` is never read from a request body.
9. Open the PR per `docs/CONTRIBUTING.md`: full-branch diff (`git diff main...HEAD`), the commit list, and the test plan above. Do **not** run `zs-land` — `00-contracts.md` §9 puts landing after the integration stage's checks.

---

## Hand-off to integration

`app/page.tsx` and `components/QuickActions.tsx` are shared files that no lane edits (contracts §1). These are the exact diffs the integration stage applies, and nothing else from this lane touches Today.

**`components/QuickActions.tsx`** — one optional prop and one row, 14 lines:

```tsx
 export default function QuickActions({
   onLogFood,
   onLogMeal,
+  onScan,
   onLogWater,
   onGutCheckin,
   onLogWeight,
 }: {
   onLogFood: () => void;
   onLogMeal: () => void;
+  /** Present only when NEXT_PUBLIC_FEATURE_SCAN=1 — app/page.tsx decides. */
+  onScan?: () => void;
   onLogWater: () => void;
```

and, immediately after the "Log a meal" button:

```tsx
+                {onScan && (
+                  <button type="button" onClick={() => { onScan(); close(); }} className={rowClass}>
+                    <Glyph>
+                      <path d="M4 8V6a2 2 0 0 1 2-2h2" /><path d="M16 4h2a2 2 0 0 1 2 2v2" />
+                      <path d="M20 16v2a2 2 0 0 1-2 2h-2" /><path d="M8 20H6a2 2 0 0 1-2-2v-2" />
+                      <path d="M8 9v6" /><path d="M12 9v6" /><path d="M16 9v6" />
+                    </Glyph>
+                    Scan a barcode
+                  </button>
+                )}
```

**`app/page.tsx`** — three imports, two state hooks, one prop and two mounts, 12 added lines in four hunks. Each hunk's unchanged anchor line is shown with a leading space.

Hunk 1, after the `QuickActions` import (line 26):

```tsx
 import QuickActions from "@/components/QuickActions";
+import BarcodeScanSheet from "@/components/BarcodeScanSheet";
+import ScanConfirmSheet from "@/components/ScanConfirmSheet";
+import type { BarcodeResponse } from "@/lib/barcode/client";
```

Hunk 2, after the `labelOpen` state (line 142):

```tsx
   const [labelOpen, setLabelOpen] = useState(false);
+  const [scanOpen, setScanOpen] = useState(false);
+  const [scanResult, setScanResult] = useState<BarcodeResponse | null>(null);
```

Hunk 3, on the `QuickActions` element:

```tsx
   <QuickActions
+    onScan={process.env.NEXT_PUBLIC_FEATURE_SCAN === "1" ? () => setScanOpen(true) : undefined}
     onLogFood={() => setLogOpen("food")}
```

Hunk 4, beside the `logOpen && <LogFoodSheet …>` mount (line 547):

```tsx
+  {scanOpen && (
+    <BarcodeScanSheet onResolved={(r) => { setScanOpen(false); setScanResult(r); }}
+      onClose={() => setScanOpen(false)} />
+  )}
+  {scanResult && (
+    <ScanConfirmSheet response={scanResult} slot={currentSlotId ?? resolved.slots[0]?.slot ?? "meal-1"}
+      onLogged={() => { setScanResult(null); refresh(); }} onClose={() => setScanResult(null)} />
+  )}
```

`components/LogFoodSheet.tsx` needs no diff from this lane: its Scan tile in `CAPTURE_MODES` stays at 50 % opacity until Lane N wires the four capture actions. Lane L owns the `onFavorite` wiring — `ScanConfirmSheet`'s star is hidden when the prop is absent, so integration adds `onFavorite={(id) => void toggleFavorite("food", id)}` only once `lib/favorites-client.ts` has landed.

## Open questions

1. ~~**`method: 'barcode'` is not in the commit contract.**~~ — **resolved 2026-09-11**: `lib/log/contract.ts`'s `METHODS` union was `["search","plan","text","voice","label","photo"]` and `lib/log-client.ts`'s `buildCommitRequest` hardcoded `method: "search"`, even though `log_entries.method`'s database check (architecture §3.3) already allows `'barcode'` and contracts §2 asks this sheet to commit with it. Task 15 now lands `docs: phase-3-4 contract change — commit method 'barcode'` first — adding `"barcode"` to `METHODS` and an optional `method` argument to `buildCommitRequest` — before writing `ScanConfirmSheet`, which commits with `method: "barcode"` directly (no placeholder constant). This was the one open item Devin's call was needed on before the Phase 3 phone gate, because the gate's whole point is that a scanned entry is distinguishable from a searched one on Today; it no longer blocks the gate.
2. ~~**The writer's arity.**~~ — **resolved 2026-09-11**: Contracts §2 writes `writeProviderRevision(admin, source, gtin14, draft)` and a three-parameter `catalog_write_provider_revision(p_source, p_gtin14, p_draft)`, but `get_or_create_food_ref` calls `_sync_assert_caller(p_user_id)` and raises `user_required` on a null, and Phase 0 contracts §2 makes `p_user_id` the first argument of every RPC in this repository. Both therefore need a user id: the RPC is `(p_user_id uuid, p_source text, p_gtin14 text, p_draft jsonb)` and the TypeScript function appends `userId` as a fifth parameter — nothing renamed, nothing reordered. Task 8 now lands this as its own `docs: phase-3-4 contract change — writeProviderRevision carries userId` commit before the implementation commit, so `00-contracts.md` and the shipped signature agree instead of silently diverging (inlining the `food_refs` insert to avoid the extra parameter was considered and rejected: it would duplicate `get_or_create_food_ref`, which contracts §2 explicitly asks us to call).
3. **The provider lookup code.** OFF and FDC store barcodes as printed, so `providerCode()` sends the 13-digit form and keeps the 14th digit only for a true ITF-14. That is the behaviour the two fetchers are tested against, but it is an inference about provider normalisation, not a measurement. `scripts/off-rate-probe.ts` at integration answers it for OFF; if a UPC-A pouch 404s there and succeeds as 12 digits, the fix is one line in `providerCode` and two fixtures.
4. **Negative-cache window.** 7 days, per contracts §2's ASSUMED value and the spec's open question 2. `NEGATIVE_CACHE_DAYS` in `lib/server/barcode.ts` is the only place it appears.
5. **`FDC_API_KEY`** — which vault id, and does the runtime reuse the Phase 1 import worker's key or get its own (spec open question 6, README decision 1)? The lane builds against the env name only; the value goes in Vercel and `.env.local`.
6. **Product-level allergen tags have nowhere of their own to live.** `catalog_ingredients` is the only table that holds allergen evidence per revision, and `RevisionDraft` is frozen with no product-level allergen field, so OFF's `allergens_tags` + `traces_tags` are written as ingredient **seq 0** ("Contains: gluten, dairy") with the quality flag `allergens_from_tags`. It renders like the Contains line on a label and the policy reads it exactly like any other row, but it is a convention this lane invents. Confirm, or add `allergen_tags text[]` to `catalog_food_revisions` in a later migration.
7. **`ingredientsText` round-trip.** The verbatim provider ingredient string is stored on the seq-1 ingredient row's `raw_text`, and `resolveBarcode` reads it back from there. It is the only nullable text column on that table; if a later phase wants the verbatim string on the revision itself, this is the line to change.
8. ~~`zxing-wasm` is not installed on this checkout~~ — **resolved 2026-09-11**: re-checking the branch directly shows `zxing-wasm@2.2.4` and `lib/capture/types.ts`, `lib/capture/flags.ts`, `lib/policy/constraints.ts` are all already landed (contracts §0 pre-lane setup is complete; there is no pending pre-lane PR to wait on). Task 13 still opens `node_modules/zxing-wasm`'s reader export before writing the import, as a check on the actual shipped API rather than a hedge against the package being missing; Tasks 9 and 12 compile against the real `evaluatePolicy`, `loadProfile`, `ConstraintProfile` and `PolicyVerdict` from the start, not a placeholder standing in for absent pre-lane code.
