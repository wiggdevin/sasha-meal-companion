/**
 * D1 §1.2–§1.3: the gate's classifier reads the ACCOUNT's `user_settings` row and nothing else.
 *
 * Before this run the classifier also took `lib/store.ts`'s `firstOpenedAt`/`onboardedAt`. That
 * store is one device-wide blob shared by every account that has ever signed in on the browser,
 * so a row-less account inherited whatever the last person left behind — and a failed read was
 * answered "invite", which let a brand-new account into Today. Both are gone: the cases below
 * pin the row-only answers, and `tests/onboarding/auth-gate.test.tsx` pins what a failed read
 * does instead.
 */
import { describe, expect, it, vi } from "vitest";
import { gateRedirect, gateForDisposition } from "@/components/AuthGate";
import {
  ONBOARDING_CUTOVER,
  accountDisposition,
  isExistingAccount,
  readAccountOnboardingRow,
} from "@/lib/profile/onboarding-state";

describe("the onboarding route gate", () => {
  it("pins the onboarding landing cutover", () => {
    expect(ONBOARDING_CUTOVER).toBe("2026-09-19T18:20:00Z");
  });

  it("treats the exact cutover instant as existing in both account classifiers", () => {
    expect(isExistingAccount(ONBOARDING_CUTOVER)).toBe(true);
    expect(accountDisposition({
      first_opened_at: ONBOARDING_CUTOVER,
      onboarded_at: null,
    })).toBe("invite");
  });

  it("does not route an unfinished account created before the cutover", () => {
    const disposition = accountDisposition({
      first_opened_at: "2026-09-19T18:19:59.999Z",
      onboarded_at: null,
    });
    expect(disposition).toBe("invite");
    expect(gateRedirect(gateForDisposition(disposition), "/")).toBeNull();
  });

  it("routes an unfinished account created strictly after the cutover", () => {
    const disposition = accountDisposition({
      first_opened_at: "2026-09-19T18:20:00.001Z",
      onboarded_at: null,
    });
    expect(disposition).toBe("force");
    expect(gateRedirect(gateForDisposition(disposition), "/")).toBe("/onboarding");
    expect(gateRedirect(gateForDisposition(disposition), "/onboarding")).toBeNull();
  });

  it("never redirects after onboarding was skipped or completed", () => {
    const disposition = accountDisposition({
      first_opened_at: "2026-09-19T18:20:00.001Z",
      onboarded_at: "2026-09-19T18:25:00.000Z",
    });
    expect(disposition).toBe("none");
    expect(gateRedirect(gateForDisposition(disposition), "/settings")).toBeNull();
  });

  it.each([
    ["missing first_opened_at", { onboarded_at: null }],
    ["null first_opened_at", { first_opened_at: null, onboarded_at: null }],
    ["unparsable first_opened_at", { first_opened_at: "not-a-date", onboarded_at: null }],
    ["non-string first_opened_at", { first_opened_at: 1_789_837_200_000, onboarded_at: null }],
    ["cutover boundary", { first_opened_at: ONBOARDING_CUTOVER, onboarded_at: null }],
    ["missing onboarded_at", { first_opened_at: "2026-09-20T12:00:00.000Z" }],
    ["unparsable onboarded_at", {
      first_opened_at: "2026-09-20T12:00:00.000Z", onboarded_at: "not-a-date",
    }],
    ["non-string onboarded_at", {
      first_opened_at: "2026-09-20T12:00:00.000Z", onboarded_at: 1,
    }],
  ])("grandfathers a row with %s", (_label, serverRow) => {
    expect(accountDisposition(serverRow)).toBe("invite");
  });

  it("forces a row-less account whatever this device remembers", () => {
    expect(accountDisposition(null)).toBe("force");
    expect(gateForDisposition("force")).toBe("onboarding");
    expect(gateForDisposition("invite")).toBe("in");
    expect(gateForDisposition("none")).toBe("in");
  });

  it("returns none for a valid completion timestamp", () => {
    expect(accountDisposition({
      first_opened_at: "2026-09-20T12:00:00.000Z",
      onboarded_at: "2026-09-20T12:05:00.000Z",
    })).toBe("none");
  });

  it("preserves server-row absence and read failure as different states", async () => {
    const server = {
      from: () => ({
        select: () => ({
          maybeSingle: async () => ({
            data: {
              first_opened_at: "2026-09-20T12:00:00.000Z",
              onboarded_at: "2026-09-20T12:05:00.000Z",
            },
          }),
        }),
      }),
    };
    expect(await readAccountOnboardingRow(server)).toEqual({
      first_opened_at: "2026-09-20T12:00:00.000Z",
      onboarded_at: "2026-09-20T12:05:00.000Z",
    });

    const absent = {
      from: () => ({ select: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    };
    expect(await readAccountOnboardingRow(absent)).toBeNull();

    const offline = {
      from: () => ({
        select: () => ({ maybeSingle: async () => { throw new Error("offline"); } }),
      }),
    };
    expect(await readAccountOnboardingRow(offline)).toBeUndefined();

    const failed = {
      from: () => ({
        select: () => ({ maybeSingle: async () => ({ data: null, error: new Error("denied") }) }),
      }),
    };
    expect(await readAccountOnboardingRow(failed)).toBeUndefined();
  });

  // PR #248 review r1 #3: the gate reads the row of the account it expects, not "whatever row the
  // cookie's session sees", so a session that changed under it cannot answer for another account.
  it("filters the onboarding read by the expected user id when given one", async () => {
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: null }) }));
    const scoped = { from: () => ({ select: () => ({ eq, maybeSingle: async () => ({ data: {} }) }) }) };
    expect(await readAccountOnboardingRow(scoped, "user-a")).toBeNull();
    expect(eq).toHaveBeenCalledWith("user_id", "user-a");
  });
});
