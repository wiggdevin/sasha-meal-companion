/**
 * sol BLOCK (review round 2): `loadProfileFor` used to ignore a `constraint_profiles` read error
 * and load an empty profile from `null` — a query outage could make the account's allergen rules
 * disappear entirely and the scan resolve "allowed" even with an active allergen rule. The
 * capture and catalog profile readers already fail the request instead of defaulting to an empty
 * (allow-everything) profile (lib/server/catalog.ts loadUserProfile, lib/server/log.ts
 * loadCallerProfile); barcode.ts now matches them.
 */
import { describe, expect, it } from "vitest";
import { resolveBarcode } from "@/lib/server/barcode";
import { HttpError } from "@/lib/server/auth";

const GTIN = "04006381333931";

function clientWithFailingProfileRead() {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const failingProfile = table === "constraint_profiles";
    Object.assign(chain, {
      select: () => chain, eq: () => chain, in: () => chain,
      maybeSingle: async () => failingProfile
        ? { data: null, error: { message: "read timed out" } }
        : { data: null, error: null },
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    });
    return chain;
  };
  return { from } as never;
}

describe("resolveBarcode: a failed profile read must not fall back to an empty (allow-all) profile", () => {
  it("fails the request instead of silently loading no allergen rules", async () => {
    const client = clientWithFailingProfileRead();
    await expect(resolveBarcode(client, client, "user-a", { gtin: GTIN }))
      .rejects.toBeInstanceOf(HttpError);
    await expect(resolveBarcode(client, client, "user-a", { gtin: GTIN }))
      .rejects.toMatchObject({ status: 500, code: "policy_failed" });
  });
});
