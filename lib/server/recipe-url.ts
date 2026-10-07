/**
 * Fetches one public recipe page for the plan sheet's "paste a link". The user's URL is untrusted,
 * so this guards the server, not only the parse:
 *   - https only, default port, no credentials in the URL, no literal IP or local host name;
 *   - every address the host resolves to must be public — checked inside the socket's own DNS
 *     lookup, so a rebinding answer between check and connect cannot reach a private address;
 *   - at most 3 redirects, each re-checked; 5 s overall; a body over 1.5 MB is an error, never a
 *     truncated page.
 * No model reads the page: lib/plan/recipe-jsonld.ts parses its schema.org data deterministically.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { HttpError } from "@/lib/server/auth";

export const MAX_RECIPE_PAGE_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 5_000;

function privateV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

/**
 * The eight 16-bit words of an IPv6 address, whatever spelling it came in (`0::1`,
 * `0:0:0:0:0:ffff:127.0.0.1`, `::ffff:7f00:1`), or null when it is not one. Range checks run on
 * these numbers, so no spelling slips past a string prefix.
 */
export function ipv6Words(address: string): number[] | null {
  let text = address.toLowerCase();
  if (isIP(text) !== 6) return null;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const parts = halves.length > 1 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  const words = parts.map((part) => parseInt(part, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words : null;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and metadata addresses. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateV4(address);
  const w = ipv6Words(address);
  if (!w) return true;
  // IPv4-mapped (::ffff:a.b.c.d, any spelling): judged as the IPv4 address it carries.
  if (w.slice(0, 5).every((word) => word === 0) && w[5] === 0xffff) {
    return privateV4(`${w[6] >> 8}.${w[6] & 0xff}.${w[7] >> 8}.${w[7] & 0xff}`);
  }
  // ::/8 (unspecified, loopback, IPv4-compatible, SIIT) and NAT64 (64:ff9b::/96 and /48), unique-
  // local fc00::/7, link-local and site-local fe80::/9, multicast ff00::/8, 6to4 2002::/16, Teredo
  // 2001:0::/32 and documentation 2001:db8::/32 — the forms a gateway could route to a private host.
  return w[0] < 0x100 || (w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xff80) === 0xfe80
    || (w[0] & 0xff00) === 0xff00 || w[0] === 0x2002
    || (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8));
}

/** Parses and screens the URL text, or throws the 422 the sheet shows as "That link can't be read". */
export function checkRecipeUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new HttpError(422, "bad_url", "That link can’t be read."); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new HttpError(422, "bad_url", "Use a full https:// recipe link.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal")) {
    throw new HttpError(422, "bad_url", "That link can’t be read.");
  }
  return url;
}

type Resolve = (hostname: string, options: { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** The socket's own resolver: every resolved address must be public, or the connect fails. */
function publicLookup(resolve: Resolve): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true }, (error, list) => {
      if (error) return callback(error, "", 4);
      if (list.length === 0 || list.some((entry) => isPrivateAddress(entry.address))) {
        return callback(new Error("blocked address"), "", 4);
      }
      if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

export type RecipeFetchDeps = {
  /** DNS resolution with `all: true`; defaults to node:dns lookup. */
  lookup?: Resolve;
  /** The HTTPS client; defaults to node:https request. Tests inject one that honours `lookup`. */
  request?: typeof httpsRequest;
};

class TooLarge extends Error {}

function getOnce(url: URL, signal: AbortSignal, lookup: LookupFunction, request: typeof httpsRequest):
  Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const req = request(url, {
      method: "GET", lookup, signal,
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "MealCompanion/1.0 (+recipe link)" },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return finish(() => resolve({ status, location: res.headers.location, body: "" }));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_RECIPE_PAGE_BYTES) {
          finish(() => reject(new TooLarge()));
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      // Only a complete body is a page: a close without `end` (socket drop, abort) is a failure,
      // never the bytes buffered so far.
      res.on("end", () => finish(() => resolve({ status, body: Buffer.concat(chunks).toString("utf8") })));
      res.on("close", () => finish(() => reject(new Error("closed before end"))));
      res.on("error", (error) => finish(() => reject(error)));
    });
    req.on("error", (error) => finish(() => reject(error)));
    req.end();
  });
}

export async function fetchRecipePage(raw: string, deps: RecipeFetchDeps = {}): Promise<string> {
  const lookup = publicLookup(deps.lookup
    ?? ((hostname, options, callback) => dnsLookup(hostname, options, callback)));
  const request = deps.request ?? httpsRequest;
  let url = checkRecipeUrl(raw);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Awaited<ReturnType<typeof getOnce>>;
    try { res = await getOnce(url, signal, lookup, request); }
    catch (error) {
      if (error instanceof TooLarge) {
        throw new HttpError(422, "too_large", "That page is too large to read. Try another link or a photo.");
      }
      throw new HttpError(422, "unreachable", "That page didn’t open. Try another link or a photo.");
    }
    if (res.location) { url = checkRecipeUrl(new URL(res.location, url).toString()); continue; }
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(422, "unreachable", "That page didn’t open. Try another link or a photo.");
    }
    return res.body;
  }
  throw new HttpError(422, "unreachable", "That page redirects too many times.");
}
