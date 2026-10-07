import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/server/auth";

vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  requireUser: vi.fn(),
}));

const { requireUser } = await import("@/lib/server/auth");
const { POST } = await import("@/app/api/foods/role/confirm/route");

const FOOD = "11111111-1111-4111-8111-111111111111";
const OTHER_FOOD = "22222222-2222-4222-8222-222222222222";
type Pref = { user_id: string; food_ref_id: string; status: string; role: string | null;
  no_cook: boolean; note: string | null; rev: number };

function client(rows: Pref[]) {
  const rpc = vi.fn(async (_name: string, args: { p_user_id: string; p_op: {
    entity_id: string; base_rev: number; payload: { role: string };
  } }): Promise<{ data: { status: string; rev?: number } | null;
    error: { message: string } | null }> => {
    const row = rows.find((item) => item.user_id === args.p_user_id
      && item.food_ref_id === args.p_op.entity_id);
    if (!row || row.rev !== args.p_op.base_rev || row.role !== null) {
      return { data: { status: "conflict" }, error: null };
    }
    row.role = args.p_op.payload.role;
    row.rev += 1;
    return { data: { status: "applied", rev: row.rev }, error: null };
  });
  return {
    rpc,
    from: (table: string) => {
      expect(table).toBe("user_food_prefs");
      const filters: Record<string, string> = {};
      const query = {
        select: () => query,
        eq: (key: string, value: string) => { filters[key] = value; return query; },
        maybeSingle: async () => ({ data: rows.find((row) =>
          Object.entries(filters).every(([key, value]) => row[key as keyof Pref] === value)) ?? null,
        error: null }),
      };
      return query;
    },
  };
}

function post(body: unknown) {
  return POST(new Request("https://app.test/api/foods/role/confirm", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

const BODY = { foodRefId: FOOD, proposedRole: "protein", currentRole: null,
  requiresConfirmation: true };

beforeEach(() => {
  vi.mocked(requireUser).mockReset();
});

describe("POST /api/foods/role/confirm", () => {
  it("saves an explicit choice through the owner's sync RPC and is idempotent", async () => {
    const rows: Pref[] = [{ user_id: "u1", food_ref_id: FOOD, status: "eats", role: null,
      no_cook: true, note: "keep", rev: 4 }];
    const db = client(rows);
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db as never });

    const first = await post(BODY);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ status: "persisted", role: "protein" });
    expect(db.rpc).toHaveBeenCalledWith("apply_sync_op", expect.objectContaining({
      p_user_id: "u1", p_op: expect.objectContaining({ entity: "user_food_prefs",
        entity_id: FOOD, kind: "update", base_rev: 4,
        payload: { role: "protein" } }),
    }));
    expect(rows[0]).toMatchObject({ status: "eats", no_cook: true, note: "keep" });
    const again = await post(BODY);
    await expect(again.json()).resolves.toEqual({ status: "unchanged", role: "protein" });
    expect(db.rpc).toHaveBeenCalledOnce();
  });

  it("cannot read or update another account's food role", async () => {
    const rows: Pref[] = [{ user_id: "u2", food_ref_id: OTHER_FOOD, status: "eats",
      role: null, no_cook: false, note: null, rev: 2 }];
    const db = client(rows);
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db as never });

    expect((await post({ ...BODY, foodRefId: OTHER_FOOD })).status).toBe(404);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(rows[0].role).toBeNull();
  });

  it("rejects a changed role and an unconfirmed request", async () => {
    const db = client([{ user_id: "u1", food_ref_id: FOOD, status: "eats", role: "carb",
      no_cook: false, note: null, rev: 3 }]);
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db as never });
    expect((await post(BODY)).status).toBe(409);
    expect((await post({ ...BODY, requiresConfirmation: false })).status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("rejects a stale advice role or a role outside the stored enum", async () => {
    const db = client([{ user_id: "u1", food_ref_id: FOOD, status: "eats", role: "carb",
      no_cook: false, note: null, rev: 3 }]);
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db as never });
    const stale = await post({ ...BODY, currentRole: "protein" });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: "role_changed" });
    expect((await post({ ...BODY, proposedRole: "produce" })).status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("answers 409 without a second write when the revision changes during confirmation", async () => {
    const rows: Pref[] = [{ user_id: "u1", food_ref_id: FOOD, status: "eats", role: null,
      no_cook: true, note: "before", rev: 4 }];
    const db = client(rows);
    db.rpc.mockImplementationOnce(async () => {
      rows[0].note = "another tab";
      rows[0].rev = 5;
      return { data: { status: "conflict" }, error: null };
    });
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db as never });
    const response = await post(BODY);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "role_changed" });
    expect(db.rpc).toHaveBeenCalledOnce();
    expect(rows[0]).toMatchObject({ role: null, note: "another tab", rev: 5 });
  });

  it("treats a concurrent identical confirmation as unchanged", async () => {
    const rows: Pref[] = [{ user_id: "u1", food_ref_id: FOOD, status: "eats", role: null,
      no_cook: false, note: null, rev: 4 }];
    const db = client(rows);
    db.rpc.mockImplementationOnce(async () => {
      rows[0].role = "protein";
      rows[0].rev = 5;
      return { data: { status: "conflict" }, error: null };
    });
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db as never });
    await expect((await post(BODY)).json()).resolves.toEqual({ status: "unchanged", role: "protein" });
    expect(db.rpc).toHaveBeenCalledOnce();
  });

  it("maps a role-only database revision race to 409", async () => {
    const db = client([{ user_id: "u1", food_ref_id: FOOD, status: "eats", role: null,
      no_cook: false, note: null, rev: 4 }]);
    db.rpc.mockResolvedValueOnce({ data: null, error: { message: "food_role_conflict" } });
    vi.mocked(requireUser).mockResolvedValue({ userId: "u1", client: db as never });
    const response = await post(BODY);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "role_changed" });
    expect(db.rpc).toHaveBeenCalledOnce();
  });

  it("requires an authenticated account", async () => {
    vi.mocked(requireUser).mockRejectedValue(new HttpError(401, "unauthorized"));
    expect((await post(BODY)).status).toBe(401);
  });
});
