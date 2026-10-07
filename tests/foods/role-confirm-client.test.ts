import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountChanged, bindAccount, unbindAccount, type AccountHandle,
} from "@/lib/device/account";
import {
  confirmFoodRole, roleConfirmOffer, waitForMembershipSync, type RoleConfirmDeps,
} from "@/lib/foods/role-confirm-client";
import type { CoachAction } from "@/lib/coach/actions";
import type { OutboxOp } from "@/lib/sync/idb";

const REF = "3f1b1a2c-0000-4000-8000-0000000000f1";
const OFFER = { foodRefId: REF, name: "Tahini", proposedRole: "fat" as const, currentRole: null };

function membershipOp(nameNorm: string): OutboxOp {
  return { op_id: "op-1", entity: "food_membership", entity_id: "m-1", kind: "update", base_rev: null,
    payload: { name_norm: nameNorm, status: "eats" }, client_ts: "2026-10-05T00:00:00Z",
    user_id: "user-a" } as unknown as OutboxOp;
}

let h: AccountHandle;
let fetchImpl: ReturnType<typeof vi.fn>;
let deps: RoleConfirmDeps;

beforeEach(() => {
  h = bindAccount("user-a");
  fetchImpl = vi.fn();
  deps = {
    account: h, fetchImpl: fetchImpl as unknown as typeof fetch,
    sync: vi.fn(async () => undefined), readOps: vi.fn(async () => []),
    readFresh: vi.fn(async () => ({ status: "eats" as const, role: "carb" as const })),
  };
});

afterEach(() => { unbindAccount(); });

describe("confirmFoodRole", () => {
  it("posts the explicit confirmation and reports a saved role (200)", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ status: "persisted", role: "fat" }));
    await expect(confirmFoodRole(OFFER, deps)).resolves.toEqual({ status: "saved", role: "fat" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/foods/role/confirm");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-smc-account")).toBe("user-a");
    expect(JSON.parse(String(init.body))).toEqual({
      foodRefId: REF, proposedRole: "fat", currentRole: null, requiresConfirmation: true,
    });
  });

  it("reports unchanged when the server already holds the role", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ status: "unchanged", role: "fat" }));
    await expect(confirmFoodRole(OFFER, deps)).resolves.toEqual({ status: "unchanged", role: "fat" });
  });

  it("re-reads the food after a 409 and returns its fresh state", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json(
      { error: "role_changed", message: "changed" }, { status: 409 }));
    await expect(confirmFoodRole(OFFER, deps)).resolves.toEqual({
      status: "changed", fresh: { status: "eats", role: "carb" },
    });
    expect(deps.sync).toHaveBeenCalledWith(h);
    expect(deps.readFresh).toHaveBeenCalledWith(REF, h);
  });

  it("tells a 409 membership_required apart from a changed role", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json(
      { error: "membership_required", message: "Add it first." }, { status: 409 }));
    deps.readFresh = vi.fn(async () => null);
    await expect(confirmFoodRole(OFFER, deps)).resolves.toEqual({
      status: "not_member", code: "membership_required", fresh: null,
    });
    expect(deps.sync).toHaveBeenCalledWith(h);
  });

  it("reports a 404 as no preference row, after a re-read", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ error: "not_found" }, { status: 404 }));
    deps.readFresh = vi.fn(async () => null);
    await expect(confirmFoodRole(OFFER, deps)).resolves.toEqual({
      status: "not_member", code: "no_preference", fresh: null,
    });
    expect(deps.readFresh).toHaveBeenCalledWith(REF, h);
  });

  it("rethrows an account switch while the answer is read", async () => {
    const res = Response.json({ status: "persisted", role: "fat" });
    const json = res.json.bind(res);
    res.json = async () => { const body = await json(); bindAccount("user-b"); return body; };
    fetchImpl.mockResolvedValueOnce(res);
    await expect(confirmFoodRole(OFFER, deps)).rejects.toBeInstanceOf(AccountChanged);
  });

  it("rejects on a network failure", async () => {
    fetchImpl.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(confirmFoodRole(OFFER, deps)).rejects.toThrow("Failed to fetch");
  });

  it("rejects on an unexpected server error", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ error: "internal" }, { status: 500 }));
    await expect(confirmFoodRole(OFFER, deps)).rejects.toThrow("500");
  });

  it("waits for the queued membership to sync before posting", async () => {
    const order: string[] = [];
    let queued = true;
    deps.readOps = vi.fn(async () => (queued ? [membershipOp("tahini")] : []));
    deps.sync = vi.fn(async () => { order.push("sync"); queued = false; });
    fetchImpl.mockImplementationOnce(async () => {
      order.push("post");
      return Response.json({ status: "persisted", role: "fat" });
    });
    await expect(confirmFoodRole(OFFER, deps)).resolves.toEqual({ status: "saved", role: "fat" });
    expect(order.slice(0, 2)).toEqual(["sync", "post"]);
  });

  it("does not post while the membership is still queued", async () => {
    deps.readOps = vi.fn(async () => [membershipOp("tahini")]);
    await expect(confirmFoodRole(OFFER, deps)).resolves.toEqual({
      status: "not_synced", fresh: { status: "eats", role: "carb" },
    });
    expect(deps.sync).toHaveBeenCalledTimes(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("waitForMembershipSync", () => {
  it("ignores another food's queued membership", async () => {
    deps.readOps = vi.fn(async () => [membershipOp("banana")]);
    await expect(waitForMembershipSync(h, "Tahini", REF, deps)).resolves.toBe(true);
    expect(deps.sync).not.toHaveBeenCalled();
  });

  it("answers false when a sync pass throws", async () => {
    deps.readOps = vi.fn(async () => [membershipOp("tahini")]);
    deps.sync = vi.fn(async () => { throw new Error("offline"); });
    await expect(waitForMembershipSync(h, "Tahini", REF, deps)).resolves.toBe(false);
  });
});

describe("roleConfirmOffer", () => {
  const base = {
    kind: "add_to_eats", actionId: "a-1", flagged: [], name: "Tahini", foodRefId: REF,
    roleAdvice: { foodRefId: REF, suggestedRole: "fat_source", proposedRole: "fat", currentRole: null,
      reason: "The food is chiefly the meal's fat source.", confidence: 0.9, requiresConfirmation: true },
  };
  const offer = (patch: Record<string, unknown>) =>
    roleConfirmOffer({ ...base, roleAdvice: { ...base.roleAdvice, ...patch } } as unknown as CoachAction);

  it("offers a confirm only when it is required and names a role", () => {
    expect(offer({})).toMatchObject({ proposedRole: "fat", currentRole: null, name: "Tahini" });
    expect(offer({ requiresConfirmation: false })).toBeNull();
    expect(offer({ proposedRole: null })).toBeNull();
    expect(roleConfirmOffer({ ...base, kind: "remove_from_eats" } as unknown as CoachAction)).toBeNull();
  });
});
