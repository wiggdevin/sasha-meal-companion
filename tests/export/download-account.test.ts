// @vitest-environment jsdom
/**
 * Phase 9 slice 1, audit plan r2 finding 6: the export is a fetch for the account the card was
 * rendered for, never a plain link that downloads whatever account the shared cookie now holds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";
import { downloadExport, exportHref } from "@/lib/export-client";

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
