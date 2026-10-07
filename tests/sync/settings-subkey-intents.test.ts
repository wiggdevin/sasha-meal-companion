// @vitest-environment jsdom
/**
 * Phase 18 W5b-2: `diet_prefs` is one column many phone writers rewrite whole (flags, text, water,
 * widget, taste) and the server now writes too (the taste-chip confirm and Undo RPCs). A pending edit
 * records the sub-keys it changed (`sub`), so the rebase onto a newer server row writes only those:
 * a water-unit edit built before the server added a taste chip never carries the older taste back.
 * `cuisines` and `diet_prefs.taste.dislikes` replay as the keys the edit added and removed (capped
 * at 6 and 50), so a pending Settings edit neither drops a confirmed chip nor brings back one the
 * server's Undo removed. An older build's whole intent is upgraded against its baseline row. Any
 * other column and a non-object value still replace the whole value.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import type { AccountHandle } from "@/lib/device/account";
import { __resetStoreCache, defaultStore, loadStore, saveStore } from "@/lib/store";
import { applyServerUserSettings } from "@/lib/sync/client";
import { allOps, getMeta, getRow, putMeta, putOp } from "@/lib/sync/idb";
import { mutateUserSettings, USER_SETTINGS_KEY } from "@/lib/sync/outbox";
import { applyPulledUserSettings, selectAndFreezeSettings, settleUserSettings } from "@/lib/sync/settings";
import {
  BASELINE_KEY, HELD_INTENTS_KEY, foldEdit, foldQueued, mergeIntents, nextState, normalizeBaseline, payloadOf, type SettingsIntent,
} from "@/lib/sync/settings-intents";
import { resetTestAccount } from "@/tests/helpers/account";

const OLD = { flags: ["no_gluten"], water: { unit: "ml" }, taste: { dislikes: ["t:soft"] } };
const CONFIRMED = { ...OLD, taste: { dislikes: ["t:soft", "t:bitter"] } };

describe("the algebra", () => {
  it("a diet_prefs edit records the sub-keys it changed; replay lays only those onto the newer row", () => {
    const edit = { ...OLD, water: { unit: "oz" } };
    const [intent] = foldEdit({ diet_prefs: OLD }, [], { diet_prefs: edit });
    expect(intent).toEqual({ key: "diet_prefs", value: edit, sub: ["water"] });
    expect(payloadOf({ diet_prefs: CONFIRMED, rev: 4 }, [intent]).diet_prefs)
      .toEqual({ ...CONFIRMED, water: { unit: "oz" } });
  });

  it("a taste edit replays as the keys it removed and added: the server's new chip survives", () => {
    const removed = { ...OLD, taste: { dislikes: ["t:sour"] } };
    const [intent] = foldEdit({ diet_prefs: OLD }, [], { diet_prefs: removed });
    expect(intent).toEqual({ key: "diet_prefs", value: removed, sub: ["taste"],
      delta: { add: ["t:sour"], remove: ["t:soft"] } });
    expect(payloadOf({ diet_prefs: CONFIRMED }, [intent]).diet_prefs)
      .toEqual({ ...OLD, taste: { dislikes: ["t:bitter", "t:sour"] } });
  });

  it("a pending cuisines edit neither drops a confirmed cuisine nor brings back one the server undid", () => {
    const [intent] = foldEdit({ cuisines: ["italian", "korean"] }, [], { cuisines: ["italian", "korean", "african"] });
    expect(intent).toEqual({ key: "cuisines", value: ["italian", "korean", "african"],
      delta: { add: ["african"], remove: [] } });
    // The server added japanese and its Undo removed korean meanwhile.
    expect(payloadOf({ cuisines: ["italian", "japanese"] }, [intent]).cuisines).toEqual(["italian", "japanese", "african"]);
    const [removal] = foldEdit({ cuisines: ["italian", "korean"] }, [], { cuisines: ["korean"] });
    expect(payloadOf({ cuisines: ["italian", "korean", "japanese"] }, [removal]).cuisines).toEqual(["korean", "japanese"]);
  });

  it("a replay never passes the caps: 6 cuisines, 50 dislikes", () => {
    const [intent] = foldEdit({ cuisines: [] }, [], { cuisines: ["african", "caribbean"] });
    const full = ["american", "italian", "korean", "chinese", "japanese"];
    expect(payloadOf({ cuisines: full }, [intent]).cuisines).toEqual([...full, "african"]);
    const fifty = Array.from({ length: 50 }, (_, i) => `f:food ${i}`);
    const [taste] = foldEdit({ diet_prefs: OLD }, [], { diet_prefs: { ...OLD, taste: { dislikes: ["t:soft", "t:sour"] } } });
    expect((payloadOf({ diet_prefs: { taste: { dislikes: fifty } } }, [taste]).diet_prefs as typeof OLD).taste.dislikes)
      .toEqual(fifty);
  });

  it("deltas compose across edits and generations: a key's last move wins", () => {
    let intents = foldEdit({ cuisines: ["italian"] }, [], { cuisines: ["italian", "korean"] });
    intents = foldEdit({ cuisines: ["italian", "korean"] }, intents, { cuisines: ["italian"] });
    expect(intents[0].delta).toEqual({ add: [], remove: ["korean"] });
    const merged = mergeIntents([{ key: "cuisines", value: ["korean"], delta: { add: ["korean"], remove: ["italian"] } }],
      [{ key: "cuisines", value: ["korean", "african"], delta: { add: ["african"], remove: [] } }]);
    expect(merged[0].delta).toEqual({ add: ["korean", "african"], remove: ["italian"] });
  });

  it("an older build's whole intent is upgraded against the baseline row it was built on", () => {
    const water = { ...OLD, water: { unit: "oz" } };
    const state = normalizeBaseline({ row: { diet_prefs: OLD, cuisines: ["italian"] }, rev: 3, generation: 1, sent: null,
      intents: [{ key: "diet_prefs", value: water }, { key: "cuisines", value: ["italian", "korean"] }] });
    expect(state?.intents).toEqual([{ key: "diet_prefs", value: water, sub: ["water"] },
      { key: "cuisines", value: ["italian", "korean"], delta: { add: ["korean"], remove: [] } }]);
    // The same for a frozen generation an older build sent, settled by a conflict.
    const settled = { op_id: "o1", base_rev: 3, payload: {}, intents: [{ key: "diet_prefs", value: water }] } as never;
    const next = nextState({ row: { diet_prefs: OLD }, rev: 3, generation: 1, intents: [], sent: "o1" },
      settled, { status: "conflict", row: { diet_prefs: CONFIRMED }, rev: 4 }, []);
    expect(payloadOf(next.row, next.intents).diet_prefs).toEqual({ ...CONFIRMED, water: { unit: "oz" } });
  });

  it("a removed sub-key is removed on replay; a new one is added", () => {
    const edit = { flags: ["no_gluten"], taste: OLD.taste, widget: { ring: "protein" } };
    const [intent] = foldEdit({ diet_prefs: OLD }, [], { diet_prefs: edit });
    expect(intent.sub?.sort()).toEqual(["water", "widget"]);
    expect(payloadOf({ diet_prefs: CONFIRMED }, [intent]).diet_prefs)
      .toEqual({ flags: ["no_gluten"], taste: CONFIRMED.taste, widget: { ring: "protein" } });
  });

  it("two edits compose their sub-keys; the later value carries both", () => {
    const first = { ...OLD, water: { unit: "oz" } };
    const second = { ...first, flags: [] };
    let intents = foldEdit({ diet_prefs: OLD }, [], { diet_prefs: first });
    intents = foldEdit({ diet_prefs: first }, intents, { diet_prefs: second });
    expect(intents).toEqual([{ key: "diet_prefs", value: second, sub: ["water", "flags"] }]);
    // The in-flight generation's intents and the next generation's merge the same way (a conflict).
    const merged = mergeIntents([{ key: "diet_prefs", value: first, sub: ["water"] }],
      [{ key: "diet_prefs", value: second, sub: ["flags"] }]);
    expect(merged).toEqual([{ key: "diet_prefs", value: second, sub: ["water", "flags"] }]);
    expect(payloadOf({ diet_prefs: CONFIRMED }, merged).diet_prefs)
      .toEqual({ ...CONFIRMED, water: { unit: "oz" }, flags: [] });
  });

  it("a null diet_prefs, a whole intent and every other column stay whole", () => {
    expect(foldEdit({ diet_prefs: OLD }, [], { diet_prefs: null })).toEqual([{ key: "diet_prefs", value: null }]);
    expect(foldEdit({ diet_prefs: null }, [], { diet_prefs: OLD })).toEqual([{ key: "diet_prefs", value: OLD }]);
    expect(foldEdit({ slot_times: { a: "08:00" } }, [], { slot_times: { a: "09:00" } }))
      .toEqual([{ key: "slot_times", value: { a: "09:00" } }]);
    const whole: SettingsIntent = { key: "diet_prefs", value: OLD };
    expect(payloadOf({ diet_prefs: CONFIRMED }, [whole]).diet_prefs).toEqual(OLD);
    // A whole earlier intent keeps the composition whole (an older build's intent).
    expect(mergeIntents([whole], [{ key: "diet_prefs", value: CONFIRMED, sub: ["taste"] }]))
      .toEqual([{ key: "diet_prefs", value: CONFIRMED }]);
    // A sub-key intent onto a row whose diet_prefs is null starts from an empty object.
    expect(payloadOf({ diet_prefs: null }, [{ key: "diet_prefs", value: OLD, sub: ["water"] }]).diet_prefs)
      .toEqual({ water: { unit: "ml" } });
  });

  it("re-folding a queued payload keeps the typed intent it was built from", () => {
    const base = { cuisines: ["italian"], diet_prefs: OLD };
    const intents = foldEdit(base, [], { cuisines: ["italian", "korean"], diet_prefs: { ...OLD, water: { unit: "oz" } } });
    const queuedPayload = payloadOf(base, intents);
    expect(foldQueued(base, intents, queuedPayload)).toEqual(intents);
    // A removal then a re-add re-states the base, and its typed intent is kept, not dropped.
    const readd = foldEdit({ cuisines: [] }, foldEdit(base, [], { cuisines: [] }), { cuisines: ["italian"] });
    expect(foldQueued(base, readd, payloadOf(base, readd))).toEqual(readd);
    // A whole intent that restates the base (clear, then restore) changes nothing and is dropped.
    const restored = foldEdit({ diet_prefs: null }, foldEdit(base, [], { diet_prefs: null }), { diet_prefs: OLD });
    expect(restored).toEqual([{ key: "diet_prefs", value: OLD }]);
    expect(foldQueued(base, restored, payloadOf(base, restored))).toEqual([]);
    // A legacy queued payload with no recorded intent is recorded as what it changed against base.
    expect(foldQueued(base, [], { cuisines: ["korean"] }))
      .toEqual([{ key: "cuisines", value: ["korean"], delta: { add: ["korean"], remove: ["italian"] } }]);
  });

  it("a stored intent with a malformed sub or delta replays whole, never dropped", () => {
    const state = normalizeBaseline({ row: {}, rev: 1, generation: 1, sent: null,
      intents: [{ key: "diet_prefs", value: OLD, sub: [1] }, { key: "cuisines", value: ["korean"], delta: { add: [2] } }] });
    // No baseline column to diff against: both stay whole.
    expect(state?.intents).toEqual([{ key: "diet_prefs", value: OLD }, { key: "cuisines", value: ["korean"] }]);
  });

  it("a conflict rebases the frozen generation's sub-keys onto the server's row", () => {
    const edit = { ...OLD, water: { unit: "oz" } };
    const settled = { op_id: "o1", base_rev: 3, payload: {}, generation: 1,
      intents: [{ key: "diet_prefs", value: edit, sub: ["water"] }] } as never;
    const state = nextState({ row: { diet_prefs: OLD }, rev: 3, generation: 1, intents: [], sent: "o1" },
      settled, { status: "conflict", row: { diet_prefs: CONFIRMED, rev: 4 }, rev: 4 }, []);
    expect(payloadOf(state.row, state.intents).diet_prefs).toEqual({ ...CONFIRMED, water: { unit: "oz" } });
  });
});

describe("on the phone: a pending water edit and the server's confirm", () => {
  let h: AccountHandle;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    h = await resetTestAccount();
    window.localStorage.clear();
    __resetStoreCache();
    saveStore(defaultStore(), { silent: true });
    await applyPulledUserSettings(h, { rev: 3, diet_prefs: OLD, cuisines: ["italian"] }, 3);
  });

  async function editWater(unit: string): Promise<void> {
    await mutateUserSettings(h, (row) => {
      const rev = typeof row.rev === "number" ? row.rev : null;
      const payload = { diet_prefs: { ...(row.diet_prefs as object), water: { unit } } };
      return { row: { ...row, ...payload }, op: { op_id: crypto.randomUUID(), entity: "user_settings" as const,
        entity_id: USER_SETTINGS_KEY, kind: "update" as const, base_rev: rev, payload,
        client_ts: new Date().toISOString() }, result: undefined };
    });
  }

  it("the confirm's row becomes the baseline; the queued edit keeps the confirmed chip", async () => {
    await editWater("oz");
    expect(await applyServerUserSettings(h, { rev: 4, diet_prefs: CONFIRMED, cuisines: ["italian", "korean"] }))
      .toBe(true);
    const mirror = await getRow(h, "user_settings", USER_SETTINGS_KEY);
    expect(mirror).toMatchObject({ diet_prefs: { ...CONFIRMED, water: { unit: "oz" } }, cuisines: ["italian", "korean"] });
    const [op] = (await allOps(h)).filter((o) => o.entity === "user_settings");
    expect(op).toMatchObject({ base_rev: 4,
      payload: { diet_prefs: { ...CONFIRMED, water: { unit: "oz" } }, cuisines: ["italian", "korean"] } });
    expect(loadStore().settings.cuisines).toEqual(["italian", "korean"]);
  });

  it("an edit already in flight that conflicts with the confirm is rewritten onto it, chip kept", async () => {
    await editWater("oz");
    const { op } = await selectAndFreezeSettings(h, Date.now() + 1);
    expect(op).not.toBeNull();
    await settleUserSettings(h, op, { status: "conflict", row: { rev: 4, diet_prefs: CONFIRMED }, rev: 4 });
    const [rewritten] = (await allOps(h)).filter((o) => o.entity === "user_settings");
    expect(rewritten).toMatchObject({ base_rev: 4, payload: { diet_prefs: { ...CONFIRMED, water: { unit: "oz" } } } });
  });

  async function edit(payloadOf: (row: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    await mutateUserSettings(h, (row) => {
      const rev = typeof row.rev === "number" ? row.rev : null;
      const payload = payloadOf(row);
      return { row: { ...row, ...payload }, op: { op_id: crypto.randomUUID(), entity: "user_settings" as const,
        entity_id: USER_SETTINGS_KEY, kind: "update" as const, base_rev: rev, payload,
        client_ts: new Date().toISOString() }, result: undefined };
    });
  }
  const settingsOp = async () => (await allOps(h)).filter((o) => o.entity === "user_settings");

  it("cuisine add, then an unrelated edit, then the confirm's row: the queued edit keeps the confirmed cuisine", async () => {
    await edit(() => ({ cuisines: ["italian", "korean"] }));
    await edit(() => ({ country_code: "US" }));
    const [queued] = await settingsOp();
    expect(queued.intents).toEqual(expect.arrayContaining([
      { key: "cuisines", value: ["italian", "korean"], delta: { add: ["korean"], remove: [] } }]));
    await applyServerUserSettings(h, { rev: 4, diet_prefs: OLD, cuisines: ["italian", "japanese"] });
    const [op] = await settingsOp();
    expect(op).toMatchObject({ base_rev: 4,
      payload: { cuisines: ["italian", "japanese", "korean"], country_code: "US" } });
    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
      .toMatchObject({ cuisines: ["italian", "japanese", "korean"], country_code: "US" });
  });

  it("a removal and a re-add of one key: the user's last move wins over the server's list", async () => {
    await edit(() => ({ cuisines: [] }));
    await applyServerUserSettings(h, { rev: 4, diet_prefs: OLD, cuisines: ["italian", "korean"] });
    expect((await settingsOp())[0].payload.cuisines).toEqual(["korean"]);
    await edit(() => ({ cuisines: ["korean", "italian"] }));
    // The server's Undo took korean off meanwhile; italian was re-added by the user, so it stays.
    await applyServerUserSettings(h, { rev: 5, diet_prefs: OLD, cuisines: [] });
    expect((await settingsOp())[0].payload.cuisines).toEqual(["italian"]);
  });

  it("a frozen op from an older build is upgraded against its own row before the confirm's row lands", async () => {
    await editWater("oz");
    const { op } = await selectAndFreezeSettings(h, Date.now() + 1);
    // What an older build left frozen: a whole diet_prefs intent with no sub-keys.
    await putOp(h, { ...op!, intents: [{ key: "diet_prefs", value: { ...OLD, water: { unit: "oz" } } }] });
    await applyServerUserSettings(h, { rev: 4, diet_prefs: CONFIRMED, cuisines: ["italian"] });
    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
      .toMatchObject({ diet_prefs: { ...CONFIRMED, water: { unit: "oz" } } });
    const [frozen] = await settingsOp();
    expect(frozen.intents).toEqual([{ key: "diet_prefs", value: { ...OLD, water: { unit: "oz" } }, sub: ["water"] }]);
    // Its answer comes back a conflict (the confirm moved the rev): rewritten onto the confirm, chip kept.
    await settleUserSettings(h, frozen, { status: "conflict", row: { rev: 4, diet_prefs: CONFIRMED }, rev: 4 });
    const [rewritten] = await settingsOp();
    expect(rewritten).toMatchObject({ base_rev: 4, payload: { diet_prefs: { ...CONFIRMED, water: { unit: "oz" } } } });
  });

  it("a removal and re-add before sync survives an unrelated later edit and the server's Undo", async () => {
    await edit(() => ({ cuisines: [] }));
    await edit(() => ({ cuisines: ["italian"] }));
    await edit(() => ({ country_code: "US" }));
    // The server's Undo took italian off meanwhile: the user's re-add is the last move and stays.
    await applyServerUserSettings(h, { rev: 4, diet_prefs: OLD, cuisines: [] });
    expect((await settingsOp())[0].payload).toMatchObject({ cuisines: ["italian"], country_code: "US" });
  });

  it("a frozen older-build op whose row is gone holds its taste and cuisines and replays the rest", async () => {
    await editWater("oz");
    await edit(() => ({ cuisines: ["italian", "korean"] }));
    const { op } = await selectAndFreezeSettings(h, Date.now() + 1);
    await putOp(h, { ...op!, intents: [{ key: "diet_prefs", value: { ...OLD, water: { unit: "oz" }, taste: { dislikes: [] } } },
      { key: "cuisines", value: ["italian", "korean"] }] });
    // An older build already pulled rev 4 before this one loaded: the frozen op's own row is gone.
    const stored = await getMeta<{ row: object }>(h, BASELINE_KEY);
    await putMeta(h, BASELINE_KEY, { ...stored, row: { diet_prefs: OLD, cuisines: ["italian"] }, rev: 4 });
    await applyServerUserSettings(h, { rev: 5, diet_prefs: CONFIRMED, cuisines: ["italian", "japanese"] });
    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY))
      .toMatchObject({ diet_prefs: { ...CONFIRMED, water: { unit: "oz" } }, cuisines: ["italian", "japanese"] });
    const held = await getMeta<{ key: string }[]>(h, HELD_INTENTS_KEY);
    expect(held?.map((i) => i.key)).toEqual(["diet_prefs.taste", "cuisines"]);
    // The frozen op no longer carries what it holds: the sync RPC keeps the stored values.
    const [frozen] = await settingsOp();
    expect(frozen.payload).not.toHaveProperty("cuisines");
    expect(frozen.payload.diet_prefs).not.toHaveProperty("taste");
    expect(frozen.payload.diet_prefs).toMatchObject({ water: { unit: "oz" } });
  });

  it("an older or equal rev never rolls the baseline back; a row without a rev is ignored", async () => {
    await applyServerUserSettings(h, { rev: 5, diet_prefs: CONFIRMED });
    await applyServerUserSettings(h, { rev: 4, diet_prefs: OLD });
    expect(await applyServerUserSettings(h, { diet_prefs: OLD })).toBe(false);
    expect(await getRow(h, "user_settings", USER_SETTINGS_KEY)).toMatchObject({ diet_prefs: CONFIRMED });
  });
});
