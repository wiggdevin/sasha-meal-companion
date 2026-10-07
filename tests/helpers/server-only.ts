// Vitest stand-in for the `server-only` marker package. Next.js throws when a Client Component
// bundle imports it; tests import server modules directly, so the marker resolves to nothing here
// (vitest.config.ts aliases it). Per-file `vi.mock("server-only", () => ({}))` calls stay valid.
export {};
