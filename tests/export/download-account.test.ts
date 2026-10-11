// @vitest-environment jsdom
/**
 * Phase 9 slice 1, audit plan r2 finding 6: the export is a fetch for the account the card was
 * rendered for, never a plain link that downloads whatever account the shared cookie now holds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";
import { downloadExport, exportHref, MAX_EXPORT_PAGES } from "@/lib/export-client";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const getClaims = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createRequestClient: () => ({ auth: { getClaims }, from: () => { throw new Error("no query may run"); } }),
}));

beforeEach(() => {
  unbindAccount();
  getClaims.mockResolvedValue({ data: { claims: { sub: B } }, error: null });
});

function deps(fetchImpl: unknown) {
  return { fetchImpl: fetchImpl as typeof fetch, createObjectURL: vi.fn(() => "blob:x"),
    revokeObjectURL: vi.fn() };
}

describe("downloadExport (client)", () => {
  it("builds the same query the link used to", () => {
    expect(exportHref("meals", "2026-09-01", "")).toBe("/api/export?kind=meals&format=csv&from=2026-09-01");
  });

  it("fetches nothing and saves nothing with a stale handle", async () => {
    const a = bindAccount(A);
    bindAccount(B);
    const fetchImpl = vi.fn();
    const d = deps(fetchImpl);
    await expect(downloadExport(a, "meals", "", "", d)).rejects.toBeInstanceOf(AccountChanged);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(d.createObjectURL).not.toHaveBeenCalled();
  });

  it("saves nothing when the answer arrives after a switch", async () => {
    let answer!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => { answer = r; }));
    const d = deps(fetchImpl);
    const a = bindAccount(A);
    const pending = downloadExport(a, "meals", "", "", d);
    bindAccount(B);
    answer(new Response("id,grams\n", { status: 200 }));
    await expect(pending).rejects.toBeInstanceOf(AccountChanged);
    expect(d.createObjectURL).not.toHaveBeenCalled();
  });

  it("downloads the account's CSV with the account header and a dated file name", async () => {
    const fetchImpl = vi.fn(async () => new Response("id,grams\n", { status: 200 }));
    const d = deps(fetchImpl);
    await downloadExport(bindAccount(A), "progress", "2026-09-01", "2026-09-22", d);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("x-smc-account")).toBe(A);
    expect(d.createObjectURL).toHaveBeenCalledTimes(1);
    expect(d.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });
});

describe("downloadExport over several CSV pages (W012, A086)", () => {
  /** A CSV page as the route writes it: header, rows, then `#` notice lines it counts. */
  function page(rows: string[], notices: string[], next: string | null): Response {
    const body = [["local_date", "note"].join(","), ...rows, ...notices.map((n) => `# ${n}`)]
      .join("\r\n") + "\r\n";
    const headers = new Headers({ "x-export-notice-lines": String(notices.length) });
    if (next) headers.set("x-export-next-cursor", next);
    return new Response(body, { status: 200, headers });
  }

  async function savedText(create: ReturnType<typeof vi.fn>): Promise<string> {
    return await (create.mock.calls[0][0] as Blob).text();
  }

  it("follows the cursor and saves one file with one header and each notice once", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page(["2026-09-01,a", '2026-09-02,"two\r\n# lines"'],
        ["ODbL", "Export truncated: more rows exist. Re-request with cursor=c1 to get the rest."], "c1"))
      .mockResolvedValueOnce(page(["2026-09-03,c"], ["ODbL"], null));
    const d = deps(fetchImpl);
    await downloadExport(bindAccount(A), "meals", "", "", d);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1] as unknown as [string])[0])
      .toBe("/api/export?kind=meals&format=csv&cursor=c1");
    expect(await savedText(d.createObjectURL)).toBe(["local_date,note", "2026-09-01,a",
      '2026-09-02,"two', '# lines"', "2026-09-03,c", "# ODbL"].join("\r\n") + "\r\n");
  });

  it("stops after the page cap and keeps the server's truncation line", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return page([`row-${n}`], [`Export truncated: cursor=c${n}`], `c${n}`);
    });
    const d = deps(fetchImpl);
    await downloadExport(bindAccount(A), "meals", "", "", d);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_EXPORT_PAGES);
    const text = await savedText(d.createObjectURL);
    expect(text.trimEnd().split("\r\n").at(-1)).toBe(`# Export truncated: cursor=c${MAX_EXPORT_PAGES}`);
    expect(text.match(/Export truncated/g)).toHaveLength(1);
  });

  it("saves nothing when a later page fails", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(page(["2026-09-01,a"], ["Export truncated: cursor=c1"], "c1"))
      .mockResolvedValueOnce(new Response("{}", { status: 429 }));
    const d = deps(fetchImpl);
    await expect(downloadExport(bindAccount(A), "meals", "", "", d)).rejects.toThrow(/429/);
    expect(d.createObjectURL).not.toHaveBeenCalled();
  });
});

describe("GET /api/export account check", () => {
  it("answers 409 account_mismatch for another account's header and runs no export query", async () => {
    const { GET } = await import("@/app/api/export/route");
    const res = await GET(new Request("https://app.test/api/export?kind=meals", {
      headers: { "x-smc-account": A },
    }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "account_mismatch" });
  });
});
