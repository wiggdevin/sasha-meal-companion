/**
 * Capture method flags — contracts §6. CAPTURE_METHODS (server) gates the propose routes;
 * NEXT_PUBLIC_CAPTURE_METHODS is the same list baked into the client bundle. A method absent
 * from the list renders no action and its route answers 404.
 *
 * The public twin is read through `lib/capture/public-flags.ts`, whose literal member access is
 * what Next.js inlines — a parameter-alias lookup is compiled to `undefined` in the browser
 * (audit finding T2/P1). Pure otherwise: no I/O, no Supabase import.
 */
import { publicCaptureMethods } from "@/lib/capture/public-flags";

export type CaptureMethod = "text" | "voice" | "label" | "photo";

const KNOWN_METHODS: readonly CaptureMethod[] = ["text", "voice", "label", "photo"];

/** `raw` is the whole flag value: CAPTURE_METHODS on the server, its public twin read literally
 * in `public-flags.ts` when the caller supplies nothing. Unknown values are dropped and the
 * result is ordered and deduped to KNOWN_METHODS's canonical order. */
export function enabledMethods(raw?: string): CaptureMethod[] {
  const value = raw ?? process.env.CAPTURE_METHODS ?? publicCaptureMethods() ?? "";
  const requested = new Set(
    value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0),
  );
  return KNOWN_METHODS.filter((method) => requested.has(method));
}

export function isMethodEnabled(method: CaptureMethod, raw?: string): boolean {
  return enabledMethods(raw).includes(method);
}
