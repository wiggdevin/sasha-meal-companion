/**
 * The /design fixture galleries open without an account only in local development with the explicit
 * NEXT_PUBLIC_DESIGN_GALLERY_OPEN=1 opt-in (app/design/gallery-access.ts). Without it — or in any
 * production build — middleware.ts sends a signed-out request to /sign-in like every other page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import middleware from "@/middleware";
import { designGalleryOpen } from "@/app/design/gallery-access";

afterEach(() => vi.unstubAllEnvs());

function signedOut(path: string) {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:9");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-key");
  return middleware(new NextRequest(`https://example.test${path}`));
}

describe("design gallery access", () => {
  it("is closed by default, even in development", async () => {
    expect(designGalleryOpen("/design/meal-cards")).toBe(false);
    const res = await signedOut("/design/meal-cards");
    expect(res.headers.get("location")).toContain("/sign-in");
  });

  it("is closed in a production build, opt-in or not", async () => {
    vi.stubEnv("NEXT_PUBLIC_DESIGN_GALLERY_OPEN", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(designGalleryOpen("/design/meal-cards")).toBe(false);
    const res = await signedOut("/design/meal-cards");
    expect(res.headers.get("location")).toContain("/sign-in");
  });

  it("opens the galleries, and only them, with the development opt-in", async () => {
    vi.stubEnv("NEXT_PUBLIC_DESIGN_GALLERY_OPEN", "1");
    const gallery = await signedOut("/design/meal-cards");
    expect(gallery.headers.get("location")).toBeNull();
    const today = await signedOut("/");
    expect(today.headers.get("location")).toContain("/sign-in");
    expect(designGalleryOpen("/designer")).toBe(false);
  });
});
