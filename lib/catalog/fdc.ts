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
  brandedFoodCategory?: string;
};

export async function fetchFdcBranded(
  gtin14: string,
  deps: { fetchFn?: typeof fetch; signal?: AbortSignal } = {}
): Promise<FdcBrandedFood | ProviderFailure> {
  const key = process.env.FDC_API_KEY;
  if (!key) return { status: 401 };
  const doFetch = deps.fetchFn ?? fetch;
  const url =
    `https://${FDC_HOST}/fdc/v1/foods/search?query=${providerCode(gtin14)}&dataType=Branded&pageSize=5`;
  if (new URL(url).host !== FDC_HOST) return { status: 400 };
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
      headers: { "x-api-key": key, accept: "application/json" },
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
  let body: { foods?: FdcBrandedFood[] };
  try {
    body = (await res.json()) as { foods?: FdcBrandedFood[] };
  } catch {
    return { status: 502 };
  }
  const hit = (body.foods ?? []).find((f) => normalizeGtin(f.gtinUpc ?? "") === gtin14);
  return hit ?? { status: 404 };
}
