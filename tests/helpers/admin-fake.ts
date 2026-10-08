/**
 * Unit tests of the target write path (lib/server/target-writes.ts calls the target RPCs on the
 * service-role client). A test file that drives those writes with an in-memory fake routes the
 * admin client to the same fake:
 *
 *   vi.mock("@/lib/server/admin", async () =>
 *     (await import("@/tests/helpers/admin-fake")).adminModule);
 *
 * and its fake factory sets `adminFake.client = client`. Reads stay on the client the code under
 * test was given, so a test still sees which client served each call.
 */
export const adminFake: { client: unknown } = { client: null };

export const adminModule = {
  adminClient: () => {
    if (!adminFake.client) throw new Error("admin-fake: no fake client set for this test");
    return adminFake.client;
  },
};
