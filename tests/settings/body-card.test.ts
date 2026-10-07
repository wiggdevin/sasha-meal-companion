import { describe, expect, it } from "vitest";
import { bodyDataCard } from "@/lib/health-client";
import type { DailyHealthResponse } from "@/lib/health/contract";

const response = { sources: [{ id: "s1" }, { id: "s2" }] } as unknown as DailyHealthResponse;

describe("the Settings Body-data card (contracts §6)", () => {
  it("is hidden when HEALTH_INGEST_ENABLED is unset (the daily route 503s)", () => {
    expect(bodyDataCard({ response: null, fetchedAt: null, offline: false, disabled: true }).hidden).toBe(true);
    // Even with a stale cached copy, a disabled flag hides the card.
    expect(bodyDataCard({ response, fetchedAt: "2026-09-12T00:00:00Z", offline: false, disabled: true }).hidden).toBe(true);
  });

  it("shows an error state, not Loading…, when the fetch fails with nothing cached", () => {
    const card = bodyDataCard({ response: null, fetchedAt: null, offline: true, disabled: false });
    expect(card.hidden).toBe(false);
    expect(card.caption).not.toBe("Loading…");
    expect(card.caption).toMatch(/connection/);
    expect(card.canManage).toBe(false);
  });

  it("shows Loading… only before the first result", () => {
    expect(bodyDataCard(null)).toEqual({ hidden: false, caption: "Loading…", canManage: false,
      canEditProfile: false });
  });

  it("counts sources when live, and marks a cached copy as offline", () => {
    expect(bodyDataCard({ response, fetchedAt: "2026-09-12T00:00:00Z", offline: false, disabled: false }))
      .toEqual({ hidden: false, caption: "2 sources", canManage: true, canEditProfile: true });
    const offline = bodyDataCard({ response, fetchedAt: "2026-09-12T00:00:00Z", offline: true, disabled: false });
    expect(offline.caption).toMatch(/^2 sources · offline/);
    expect(offline.canManage).toBe(false);
    // The cached row came from a 200, so the capability IS enabled: the fields stay reachable.
    expect(offline.canEditProfile).toBe(true);
  });

  // T11b ninth-round finding 4: the profile fields that ride inside the card mount only on an
  // enabled answer. While the capability is unresolved (still loading) or off, they do not exist.
  it("carries the profile-field gate: enabled answers only, never an unresolved capability", () => {
    expect(bodyDataCard(null).canEditProfile).toBe(false);
    expect(bodyDataCard({ response: null, fetchedAt: null, offline: true, disabled: false })
      .canEditProfile).toBe(false);
    expect(bodyDataCard({ response, fetchedAt: "2026-09-12T00:00:00Z", offline: false,
      disabled: true }).canEditProfile).toBe(false);
  });
});
