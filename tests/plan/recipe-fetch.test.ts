import { EventEmitter } from "node:events";
import type { LookupAddress } from "node:dns";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { fetchRecipePage, MAX_RECIPE_PAGE_BYTES, type RecipeFetchDeps } from "@/lib/server/recipe-url";

type Reply = { status: number; location?: string; body?: string | Buffer; drop?: boolean };
type Lookup = (host: string, opts: { all: true }, cb: (e: Error | null, a: LookupAddress[]) => void) => void;
type SocketLookup = (host: string, opts: object, cb: (e: Error | null, a: unknown) => void) => void;

/**
 * A stand-in for node:https request that behaves like the real one where the guard depends on it:
 * the socket's `lookup` option runs before any connect, and a lookup error becomes `error`.
 */
function fakeHttps(dns: Record<string, string[]>, replies: Record<string, Reply>) {
  const hits: string[] = [];
  // Hosts the guarded resolver was asked about: proof the guard ran, not just that a request failed.
  const resolved: string[] = [];
  const lookup: Lookup = (host, _opts, cb) => {
    resolved.push(host);
    const list = dns[host];
    if (!list) return cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
    cb(null, list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  };
  const request = vi.fn((url: URL, options: { lookup?: SocketLookup }, onResponse: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    // The guard lives in this option: a request without it would resolve with plain DNS and
    // connect anywhere, so the fake refuses to run one and dropping the guard fails every test.
    if (typeof options.lookup !== "function") throw new Error("request made without the guarded lookup");
    const socketLookup = options.lookup;
    req.end = () => {
      socketLookup(url.hostname, { all: true }, (error) => {
        if (error) { req.emit("error", error); return; }
        hits.push(url.toString());
        const reply = replies[url.toString()] ?? { status: 404 };
        const res = Object.assign(new PassThrough(), {
          statusCode: reply.status, headers: reply.location ? { location: reply.location } : {},
        });
        onResponse(res);
        const body = typeof reply.body === "string" ? Buffer.from(reply.body) : reply.body ?? Buffer.alloc(0);
        for (let at = 0; at < body.length; at += 256_000) res.write(body.subarray(at, at + 256_000));
        if (reply.drop) setTimeout(() => res.destroy(), 0); else res.end();
      });
    };
    return req;
  });
  return { deps: { lookup, request } as unknown as RecipeFetchDeps, hits, resolved };
}

const PUBLIC = { "recipes.example": ["93.184.216.34"] };

describe("fetchRecipePage", () => {
  it("returns a public page", async () => {
    const { deps, hits } = fakeHttps(PUBLIC,
      { "https://recipes.example/pasta": { status: 200, body: "<html>pasta</html>" } });
    await expect(fetchRecipePage("https://recipes.example/pasta", deps)).resolves.toBe("<html>pasta</html>");
    expect(hits).toEqual(["https://recipes.example/pasta"]);
  });

  it("refuses a host whose answers include one private address", async () => {
    const { deps, hits, resolved } = fakeHttps({ "rebind.example": ["93.184.216.34", "169.254.169.254"] },
      { "https://rebind.example/": { status: 200, body: "secret" } });
    await expect(fetchRecipePage("https://rebind.example/", deps)).rejects.toMatchObject({ status: 422 });
    expect(resolved).toEqual(["rebind.example"]);
    expect(hits).toEqual([]);
  });

  it("refuses a redirect to a literal IP or to http:", async () => {
    for (const location of ["https://127.0.0.1/admin", "https://[::1]/", "http://recipes.example/plain"]) {
      const { deps, hits } = fakeHttps(PUBLIC, {
        "https://recipes.example/go": { status: 302, location },
        [location]: { status: 200, body: "should not be read" },
      });
      await expect(fetchRecipePage("https://recipes.example/go", deps), location)
        .rejects.toMatchObject({ status: 422, code: "bad_url" });
      expect(hits, location).toEqual(["https://recipes.example/go"]);
    }
  });

  it("refuses a redirect to a hostname that resolves to a private address", async () => {
    const { deps, hits, resolved } = fakeHttps({ ...PUBLIC, "metadata.example": ["169.254.169.254"],
      "inside.example": ["93.184.216.34", "10.0.0.5"] }, {
      "https://recipes.example/a": { status: 302, location: "https://metadata.example/latest" },
      "https://recipes.example/b": { status: 307, location: "https://inside.example/admin" },
      "https://metadata.example/latest": { status: 200, body: "secret" },
      "https://inside.example/admin": { status: 200, body: "secret" },
    });
    for (const start of ["https://recipes.example/a", "https://recipes.example/b"]) {
      await expect(fetchRecipePage(start, deps), start).rejects.toMatchObject({ status: 422, code: "unreachable" });
    }
    expect(hits).toEqual(["https://recipes.example/a", "https://recipes.example/b"]);
    // The redirect target went through the guarded resolver, which refused it.
    expect(resolved).toEqual(["recipes.example", "metadata.example", "recipes.example", "inside.example"]);
  });

  it("fails loudly if a request is ever made without the guarded lookup", async () => {
    const { deps } = fakeHttps(PUBLIC, { "https://recipes.example/x": { status: 200, body: "ok" } });
    const request = (deps as { request: (u: URL, o: object, cb: unknown) => unknown }).request;
    expect(() => request(new URL("https://recipes.example/x"), {}, () => {}))
      .toThrow(/without the guarded lookup/);
  });

  it("follows three redirects and refuses the fourth", async () => {
    const url = (n: number) => `https://recipes.example/${n}`;
    const replies: Record<string, Reply> = {};
    for (let n = 0; n < 4; n++) replies[url(n)] = { status: 301, location: url(n + 1) };
    replies[url(4)] = { status: 200, body: "too far" };
    const first = fakeHttps(PUBLIC, replies);
    await expect(fetchRecipePage(url(0), first.deps)).rejects.toThrow(/redirects too many times/);
    expect(first.hits).toEqual([url(0), url(1), url(2), url(3)]);

    replies[url(3)] = { status: 200, body: "fine" };
    await expect(fetchRecipePage(url(0), fakeHttps(PUBLIC, replies).deps)).resolves.toBe("fine");
  });

  it("treats a connection that closes before the body ends as unreachable, not a page", async () => {
    const { deps } = fakeHttps(PUBLIC, {
      "https://recipes.example/cut": { status: 200, body: "<html><head>", drop: true },
    });
    await expect(fetchRecipePage("https://recipes.example/cut", deps))
      .rejects.toMatchObject({ status: 422, code: "unreachable" });
  });

  it("treats a body over the cap as an error, not a truncated page", async () => {
    const { deps } = fakeHttps(PUBLIC, {
      "https://recipes.example/huge": { status: 200, body: Buffer.alloc(MAX_RECIPE_PAGE_BYTES + 1, 0x61) },
    });
    await expect(fetchRecipePage("https://recipes.example/huge", deps))
      .rejects.toMatchObject({ status: 422, code: "too_large" });
  });
});
