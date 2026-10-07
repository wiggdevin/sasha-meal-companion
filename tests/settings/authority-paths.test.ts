import { describe, expect, it, vi } from "vitest";
import {
  persistProfilePatch,
  persistTargetPin,
  type SettingsWriteDeps,
} from "@/components/settings/use-settings-controller";
import { defaultStore } from "@/lib/store";
import { AccountChanged, bindAccount, unbindAccount } from "@/lib/device/account";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function deps(): SettingsWriteDeps {
  return {
    applyProfile: vi.fn(async () => ({ status: "applied" as const, token: {} as never })),
    applyTargets: vi.fn(async () => ({ status: "applied" as const, token: {} as never })),
    syncProfile: vi.fn(async () => undefined),
    load: vi.fn(() => defaultStore()),
    save: vi.fn(),
  };
}

describe("Settings authority paths", () => {
  it("routes a goal edit through the existing profile action path", async () => {
    const ports = deps();
    await persistProfilePatch(defaultStore(), { goal: "maintain" }, ports);
    expect(ports.applyProfile).toHaveBeenCalledWith({ kind: "update_profile", goal: "maintain" });
    expect(ports.syncProfile).not.toHaveBeenCalled();
  });

  it("routes cleared profile values through target authority", async () => {
    const ports = deps();

    await persistProfilePatch(defaultStore(), { goal: null }, ports);
    await persistProfilePatch(defaultStore(), { birthYear: null }, ports);

    expect(ports.applyProfile).toHaveBeenNthCalledWith(1, {
      kind: "update_profile",
      goal: null,
    });
    expect(ports.applyProfile).toHaveBeenNthCalledWith(2, {
      kind: "update_profile",
      birthYear: null,
    });
    expect(ports.syncProfile).not.toHaveBeenCalled();
  });

  it("syncs display-unit preferences without deriving new targets", async () => {
    const ports = deps();
    const current = defaultStore();
    const next = await persistProfilePatch(current, { heightUnit: "cm", weightUnit: "kg" }, ports);
    expect(ports.applyProfile).not.toHaveBeenCalled();
    expect(ports.syncProfile).toHaveBeenCalledWith(expect.objectContaining({
      heightUnit: "cm",
      weightUnit: "kg",
    }), undefined, ["heightUnit", "weightUnit"]);
    expect(ports.save).toHaveBeenCalledWith(next);
  });

  it("routes a calorie pin through the existing target action path", async () => {
    const ports = deps();
    await persistTargetPin({ dayType: "training", kcal: 2450 }, ports);
    expect(ports.applyTargets).toHaveBeenCalledWith({
      kind: "set_targets",
      dayType: "training",
      kcal: 2450,
    });
    expect(ports.save).not.toHaveBeenCalled();
  });

  // PR #248 review r1 #5: a switch during an awaited action writes nothing into the new account.
  it("saves nothing when the account changes while a profile write is in flight", async () => {
    unbindAccount();
    bindAccount(A);
    const ports = deps();
    ports.applyProfile = vi.fn(async () => {
      bindAccount(B);
      return { status: "applied" as const, token: {} as never };
    });
    await expect(persistProfilePatch(defaultStore(), { goal: "maintain", heightUnit: "cm" }, ports))
      .rejects.toBeInstanceOf(AccountChanged);
    expect(ports.load).not.toHaveBeenCalled();
    expect(ports.syncProfile).not.toHaveBeenCalled();
    expect(ports.save).not.toHaveBeenCalled();
    unbindAccount();
  });

  it("saves nothing when the account changes while the unit sync is in flight", async () => {
    unbindAccount();
    bindAccount(A);
    const ports = deps();
    ports.syncProfile = vi.fn(async () => { bindAccount(B); });
    await expect(persistProfilePatch(defaultStore(), { heightUnit: "cm" }, ports))
      .rejects.toBeInstanceOf(AccountChanged);
    expect(ports.save).not.toHaveBeenCalled();
    unbindAccount();
  });

  it("reads no store for the new account after a target pin lands for the old one", async () => {
    unbindAccount();
    bindAccount(A);
    const ports = deps();
    ports.applyTargets = vi.fn(async () => {
      bindAccount(B);
      return { status: "applied" as const, token: {} as never };
    });
    await expect(persistTargetPin({ dayType: "both", kcal: null, proteinG: null }, ports))
      .rejects.toBeInstanceOf(AccountChanged);
    expect(ports.load).not.toHaveBeenCalled();
    unbindAccount();
  });
});
