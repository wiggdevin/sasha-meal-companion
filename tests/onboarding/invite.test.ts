import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OnboardingInviteCard, inviteDisposition,
} from "@/components/Onboarding/OnboardingInvite";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import {
  onboardingInviteDismissedKey,
  accountDisposition,
  dismissOnboardingInvite,
  shouldShowOnboardingInvite,
} from "@/lib/profile/onboarding-state";

const NOW = new Date("2026-10-20T18:20:00.000Z");
const EXISTING = "2026-09-19T18:19:59.999Z";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("the existing-account onboarding invitation", () => {
  it("is offered as the one-line Today card for a grandfathered unfinished account", () => {
    expect(shouldShowOnboardingInvite("invite", null, NOW)).toBe(true);
    const markup = renderToStaticMarkup(
      createElement(OnboardingInviteCard, { onSetUp: () => {}, onDismiss: () => {} }),
    );
    expect(markup).toContain("Set up your profile so the coach can size your day — 2 minutes");
    expect(markup).toContain("Set up");
    expect(markup).toContain("Not now");
    // Two system buttons at md, 44 px (components/ui/Button).
    expect(markup.match(/\bbtn-md\b/g)).toHaveLength(2);
  });

  it("stays dismissed for 30 days once Not now is stored locally", () => {
    // Phase 9 §0.4: the dismissal is the bound account's own.
    unbindAccount();
    bindAccount("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const storage = memoryStorage();
    const dismissedAt = dismissOnboardingInvite(NOW, storage);

    expect(storage.getItem(onboardingInviteDismissedKey()!)).toBe(NOW.toISOString());
    expect(onboardingInviteDismissedKey()).toBe(
      "smc:u:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:onboarding-invite-dismissed-at");
    expect(shouldShowOnboardingInvite(
      "invite", dismissedAt, new Date("2026-11-19T18:19:59.999Z"),
    )).toBe(false);
    expect(shouldShowOnboardingInvite(
      "invite", dismissedAt, new Date("2026-11-19T18:20:00.000Z"),
    )).toBe(true);
  });

  it("stays hidden after the flow completes and never shows for a new unfinished account", () => {
    expect(shouldShowOnboardingInvite("none", null, NOW)).toBe(false);
    expect(shouldShowOnboardingInvite("force", null, NOW)).toBe(false);
  });

  it("invites an existing server account even when this device has a fresh local store", () => {
    expect(accountDisposition({ first_opened_at: EXISTING, onboarded_at: null })).toBe("invite");
  });
});

/**
 * Grok pass 1 on T2, NIT 4. A FAILED read used to be mapped to "none" — a claim about the account
 * made from a dropped connection, the same class of guess D1 §1.3/§1.4 took out of the gate. Only
 * a row the server actually returned resolves a disposition; a failure stays unresolved (null) and
 * the card renders nothing rather than deciding it has nothing to say.
 */
describe("the invitation's disposition read", () => {
  it("resolves only from a row the server returned", () => {
    expect(inviteDisposition(undefined)).toBeNull();
    expect(inviteDisposition(null)).toBe("force");
    expect(inviteDisposition({ first_opened_at: EXISTING, onboarded_at: null })).toBe("invite");
    expect(inviteDisposition({ first_opened_at: EXISTING, onboarded_at: NOW.toISOString() }))
      .toBe("none");
  });
});
