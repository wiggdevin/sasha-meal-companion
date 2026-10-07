/**
 * Oura v2 HTTP with the retry policy from spec §7: 1s / 2s / 4s on 429 and 5xx, and exactly one
 * refresh-then-retry on 401. fetchFn and sleepFn are injectable so the tests never sleep or call out.
 */
export const OURA_API_BASE = "https://api.ouraring.com/v2/usercollection";
export const OURA_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

export type OuraCallOptions = { accessToken: string; fetchFn?: typeof fetch;
  refresh?: () => Promise<string>; sleepFn?: (ms: number) => Promise<void>; baseUrl?: string };

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export async function ouraGet(path: string, params: Record<string, string>,
    opts: OuraCallOptions): Promise<{ data: unknown[] }> {
  const call = opts.fetchFn ?? fetch;
  const sleepFn = opts.sleepFn ?? wait;
  const base = opts.baseUrl ?? OURA_API_BASE;
  const query = new URLSearchParams(params).toString();
  const url = query.length > 0 ? `${base}/${path}?${query}` : `${base}/${path}`;

  let token = opts.accessToken;
  let refreshed = false;

  for (let attempt = 0; ; attempt += 1) {
    const res = await call(url, { headers: { authorization: `Bearer ${token}`,
      accept: "application/json" } });

    if (res.ok) {
      const body = await res.json() as { data?: unknown };
      return { data: Array.isArray(body.data) ? body.data : [] };
    }

    if (res.status === 401 && opts.refresh && !refreshed) {
      refreshed = true;
      token = await opts.refresh();
      continue;
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= OURA_RETRY_DELAYS_MS.length) {
      throw new Error(`Oura ${path} failed with ${res.status}`);
    }
    await sleepFn(OURA_RETRY_DELAYS_MS[attempt]);
  }
}
