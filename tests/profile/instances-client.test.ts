import { beforeEach, describe, expect, it, vi } from "vitest";

const accountFetch = vi.fn();
vi.mock("@/lib/device/account", async () => {
  const actual = await vi.importActual<typeof import("@/lib/device/account")>("@/lib/device/account");
  return { ...actual, accountFetch: (...a: unknown[]) => accountFetch(...a) };
});

const { bindAccount } = await import("@/lib/device/account");
const {
  confirmFoodPreference, confirmProfileInstance, fetchProfileInstances, removeProfileInstance,
} = await import("@/lib/profile/instances-client");

let HANDLE: ReturnType<typeof bindAccount>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  accountFetch.mockReset();
  HANDLE = bindAccount("u1");
});

describe("fetchProfileInstances", () => {
  it("GETs through accountFetch (the only way client code calls an app route)", async () => {
    accountFetch.mockResolvedValue(jsonResponse({ instances: [], catalog: [] }));
    await fetchProfileInstances(HANDLE);
    expect(accountFetch).toHaveBeenCalledWith(HANDLE, "/api/profile/instances", expect.any(Object));
  });

  it("returns the instances and catalog the route answered", async () => {
    accountFetch.mockResolvedValue(jsonResponse({
      instances: [{ profileId: "vegan" }], catalog: [{ id: "vegan", label: "Vegan" }],
    }));
    const result = await fetchProfileInstances(HANDLE);
    expect(result.instances).toEqual([{ profileId: "vegan" }]);
    expect(result.catalog).toEqual([{ id: "vegan", label: "Vegan" }]);
  });

  it("throws on a non-ok response rather than returning an empty catalog silently", async () => {
    accountFetch.mockResolvedValue(jsonResponse({ error: "unauthorized", message: "x" }, 401));
    await expect(fetchProfileInstances(HANDLE)).rejects.toThrow();
  });
});

describe("confirmProfileInstance", () => {
  it("PUTs the profile id and confirmations as JSON", async () => {
    accountFetch.mockResolvedValue(jsonResponse({ instance: { profileId: "vegan" } }));
    await confirmProfileInstance(HANDLE, "vegan", [{ facet: "contains_meat", confirmed: true }]);
    const [, , init] = accountFetch.mock.calls[0];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      profileId: "vegan", confirmations: [{ facet: "contains_meat", confirmed: true }],
    });
  });

  it("sends a variant choice alongside, when one is given", async () => {
    accountFetch.mockResolvedValue(jsonResponse({ instance: { profileId: "halal" } }));
    await confirmProfileInstance(HANDLE, "halal", [], { no_carmine: true });
    const [, , init] = accountFetch.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      profileId: "halal", confirmations: [], options: { no_carmine: true },
    });
  });

  it("returns the confirmed instance the server built", async () => {
    accountFetch.mockResolvedValue(jsonResponse({ instance: { profileId: "vegan", rules: [] } }));
    const instance = await confirmProfileInstance(HANDLE, "vegan", []);
    expect(instance).toEqual({ profileId: "vegan", rules: [] });
  });
});

describe("removeProfileInstance", () => {
  it("DELETEs with the profile id as a query param", async () => {
    accountFetch.mockResolvedValue(jsonResponse({ ok: true }));
    await removeProfileInstance(HANDLE, "vegan");
    const [, url, init] = accountFetch.mock.calls[0];
    expect(url).toBe("/api/profile/instances?profileId=vegan");
    expect(init.method).toBe("DELETE");
  });
});

describe("confirmFoodPreference", () => {
  it("PUTs the like or dislike through accountFetch as its own body shape", async () => {
    accountFetch.mockResolvedValue(jsonResponse({ instance: { profileId: "food_preferences" } }));
    await confirmFoodPreference(HANDLE, "cilantro", "avoid");
    const [handle, url, init] = accountFetch.mock.calls[0];
    expect(handle).toBe(HANDLE);
    expect(url).toBe("/api/profile/instances");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      foodPreference: { foodName: "cilantro", strength: "avoid", confirmed: true },
    });
  });
});
