/**
 * The capture flags as the browser bundle sees them — audit finding T2/P1.
 *
 * Next.js only inlines a `NEXT_PUBLIC_` value when the member access is written literally in
 * source (docs/app/guides/environment-variables: "dynamic lookups will not be inlined", naming
 * `env.NEXT_PUBLIC_*` as the example that fails). A helper that takes the whole env record and
 * reads `env.NEXT_PUBLIC_CAPTURE_METHODS` therefore compiles to `undefined` in the browser, and
 * with it every capture button disappears. This module exists so the literal lives in exactly one
 * place; `lib/capture/flags.ts` stays pure and takes the raw value.
 *
 * Only the public half is here. `CAPTURE_METHODS` (no prefix) is server-only by design and still
 * wins over its public twin in `enabledMethods()`.
 */

/** `process.env.NEXT_PUBLIC_CAPTURE_METHODS`, e.g. `"text,photo,label"`. */
export function publicCaptureMethods(): string | undefined {
  return process.env.NEXT_PUBLIC_CAPTURE_METHODS;
}

/** `process.env.NEXT_PUBLIC_FEATURE_SCAN === "1"` — the barcode scanner's own flag, the same
 *  gate app/page.tsx used to spell out inline and app/scan plus the barcode route still do. */
export function publicFeatureScan(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_SCAN === "1";
}
