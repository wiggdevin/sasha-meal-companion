/**
 * The local-only boundary for the admin-client canaries (review r7 finding 1): they run real
 * server code and cron jobs that act on every account, so they may run only against a disposable
 * local stack, for the API and the database alike. No database needed.
 */
import { describe, expect, it } from "vitest";
import { guardLocalOnly } from "./local-only";
import { assertLocalTargets, localTargets } from "./target-guard";

const LOCAL = {
  SUPABASE_TEST_URL: "http://127.0.0.1:54321",
  SUPABASE_TEST_DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
};
const HOSTED = "https://abcdefghijklmnop.supabase.co";

describe("local-only target guard", () => {
  it("allows a loopback API and database (127.0.0.1, localhost, ::1)", () => {
    expect(localTargets(LOCAL)).toBe(true);
    expect(localTargets({ SUPABASE_TEST_URL: "http://localhost:54321",
      SUPABASE_TEST_DB_URL: "postgresql://u:p@localhost:54322/postgres" })).toBe(true);
    expect(localTargets({ SUPABASE_TEST_URL: "http://[::1]:54321",
      SUPABASE_TEST_DB_URL: "postgresql://u:p@[::1]:54322/postgres" })).toBe(true);
    expect(localTargets({ ...LOCAL, SUPABASE_URL: LOCAL.SUPABASE_TEST_URL })).toBe(true);
  });

  it("refuses a hosted test API", () => {
    expect(localTargets({ ...LOCAL, SUPABASE_TEST_URL: HOSTED })).toBe(false);
  });

  it("refuses equal hosted URLs for the app and the tests", () => {
    expect(localTargets({ ...LOCAL, SUPABASE_TEST_URL: HOSTED, SUPABASE_URL: HOSTED })).toBe(false);
  });

  it("refuses a hosted app URL next to a local test URL", () => {
    expect(localTargets({ ...LOCAL, SUPABASE_URL: HOSTED })).toBe(false);
  });

  it("refuses a hosted or missing database URL", () => {
    expect(localTargets({ ...LOCAL,
      SUPABASE_TEST_DB_URL: "postgresql://u:p@db.abcdefghijklmnop.supabase.co:5432/postgres" }))
      .toBe(false);
    expect(localTargets({ SUPABASE_TEST_URL: LOCAL.SUPABASE_TEST_URL })).toBe(false);
  });

  it("refuses look-alike hosts and malformed URLs", () => {
    expect(localTargets({ ...LOCAL, SUPABASE_TEST_URL: "http://127.0.0.1.example.com" }))
      .toBe(false);
    expect(localTargets({ ...LOCAL, SUPABASE_TEST_URL: "http://localhost.supabase.co" }))
      .toBe(false);
    expect(localTargets({ ...LOCAL, SUPABASE_TEST_URL: "not a url" })).toBe(false);
  });

  it("guardLocalOnly does nothing without a test database and refuses a hosted one", () => {
    expect(() => guardLocalOnly({})).not.toThrow();
    expect(() => guardLocalOnly(LOCAL)).not.toThrow();
    expect(() => guardLocalOnly({ SUPABASE_TEST_URL: HOSTED })).toThrow(/local/);
    expect(() => guardLocalOnly({ SUPABASE_TEST_DB_URL:
      "postgresql://u:p@db.abcdefghijklmnop.supabase.co:5432/postgres" })).toThrow(/local/);
  });

  it("assertLocalTargets throws for a hosted target and passes for a local one", () => {
    expect(() => assertLocalTargets({ ...LOCAL, SUPABASE_TEST_URL: HOSTED,
      SUPABASE_URL: HOSTED })).toThrow(/local/);
    expect(() => assertLocalTargets(LOCAL)).not.toThrow();
  });
});
