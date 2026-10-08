/**
 * Whether the /design fixture galleries open without an account. Fails closed: only in development
 * (never a production build) and only when the developer opts in with
 * NEXT_PUBLIC_DESIGN_GALLERY_OPEN=1, which no deployed environment sets. Read by middleware.ts and
 * components/AuthGate.tsx so the server and the client gate agree.
 */
export function isDesignGallery(pathname: string): boolean {
  return pathname === "/design" || pathname.startsWith("/design/");
}

export function designGalleryOpen(pathname: string | null): boolean {
  if (!pathname || !isDesignGallery(pathname)) return false;
  return process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_DESIGN_GALLERY_OPEN === "1";
}
