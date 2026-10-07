import { afterEach, describe, expect, it, vi } from "vitest";

const generateLink = vi.fn();
vi.mock("@/lib/server/admin", () => ({ adminClient: () => ({ auth: { admin: { generateLink } } }) }));

async function call(env: Record<string, string | undefined>): Promise<Response> {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  const { GET } = await import("@/app/api/dev/sign-in/route");
  return GET(new Request("https://x.test/api/dev/sign-in"));
}

afterEach(() => { vi.unstubAllEnvs(); generateLink.mockReset(); });

describe("GET /api/dev/sign-in", () => {
  it("is 404 in production", async () => {
    const res = await call({ NODE_ENV: "production", DEV_SIGN_IN_EMAIL: "a@example.com" });
    expect(res.status).toBe(404);
    expect(generateLink).not.toHaveBeenCalled();
  });
  it("is 404 on any Vercel environment", async () => {
    const res = await call({ NODE_ENV: "development", VERCEL: "1", DEV_SIGN_IN_EMAIL: "a@example.com" });
    expect(res.status).toBe(404);
    expect(generateLink).not.toHaveBeenCalled();
  });
  it("is 404 without DEV_SIGN_IN_EMAIL", async () => {
    const res = await call({ NODE_ENV: "development", VERCEL: undefined, DEV_SIGN_IN_EMAIL: undefined });
    expect(res.status).toBe(404);
  });
  it("is 404 when NODE_ENV is test", async () => {
    const res = await call({ NODE_ENV: "test", VERCEL: undefined, DEV_SIGN_IN_EMAIL: "a@example.com" });
    expect(res.status).toBe(404);
    expect(generateLink).not.toHaveBeenCalled();
  });
  it("is 404 when NODE_ENV is unset", async () => {
    const res = await call({ NODE_ENV: undefined, VERCEL: undefined, DEV_SIGN_IN_EMAIL: "a@example.com" });
    expect(res.status).toBe(404);
    expect(generateLink).not.toHaveBeenCalled();
  });
  it("is 404 in development when VERCEL_ENV is set", async () => {
    const res = await call({ NODE_ENV: "development", VERCEL_ENV: "preview", DEV_SIGN_IN_EMAIL: "a@example.com" });
    expect(res.status).toBe(404);
    expect(generateLink).not.toHaveBeenCalled();
  });
});
