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
export const OFF_USER_AGENT = "MealCompanion/0.1 (+https://zerosumsolutions.com)";
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
  deps: { fetchFn?: typeof fetch; signal?: AbortSignal } = {}
): Promise<OffProduct | ProviderFailure> {
  const doFetch = deps.fetchFn ?? fetch;
  const url =
    `https://${OFF_HOST}/api/v2/product/${providerCode(gtin14)}.json?fields=${OFF_FIELDS.join(",")}`;
  if (new URL(url).host !== OFF_HOST) return { status: 400 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  // A caller racing two providers cancels the loser through this (T0 §4): the request is still
  // spending the outbound budget long after nobody is waiting for its answer.
  const onCallerAbort = (): void => controller.abort();
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const releaseCaller = (): void => deps.signal?.removeEventListener("abort", onCallerAbort);
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
    // The caller's signal outlives this call — a race hands the same one to two attempts — so the
    // listener comes off when the fetch settles rather than accumulating one per attempt.
    releaseCaller();
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
