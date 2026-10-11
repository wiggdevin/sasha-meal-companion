// lib/sync/merge.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  joinNotes, MergeRefusedError, mergeEntity, mergeNoteFromBase, mergePlanDayFields, NEVER_MERGED,
  planDayStamps, rebaseOp,
} from "./merge";
import type { SyncOp } from "./types";

const OLD = "2026-09-10T10:00:00.000Z";
const NEW = "2026-09-10T11:00:00.000Z";

describe("mergeEntity — newer client_ts per field", () => {
  it("takes the newer side's value where both define a field", () => {
    const m = mergeEntity("plan_days",
      { local_date: "2026-09-11", floor_day: true, rev: 3 },
      { local_date: "2026-09-11", floor_day: false, rev: 4 }, NEW, OLD);
    expect(m.floor_day).toBe(true);
  });
  it("keeps a field the newer side never had", () => {
    const m = mergeEntity("plan_days",
      { local_date: "2026-09-11", day_type_override: "rest" },
      { local_date: "2026-09-11", floor_day: true }, OLD, NEW);
    expect(m).toMatchObject({ day_type_override: "rest", floor_day: true });
  });
  it("settles on the server's rev, so the caller can rebase", () => {
    expect(mergeEntity("user_settings", { rev: 2 }, { rev: 7 }, NEW, OLD).rev).toBe(7);
  });
  it("takes the newer state for duplicate_groups", () => {
    const m = mergeEntity("duplicate_groups",
      { id: "a", state: "open" }, { id: "a", state: "dismissed" }, OLD, NEW);
    expect(m.state).toBe("dismissed");
  });
  it("merges gut_log per field", () => {
    const m = mergeEntity("gut_log",
      { id: "a", state: "flare", note: "bad night" }, { id: "a", state: "iffy" }, NEW, OLD);
    expect(m).toMatchObject({ state: "flare", note: "bad night" });
  });
  it("merges plan eaten ticks per slot and lets the server win equal timestamps", () => {
    const m = mergeEntity("plan_days",
      { eaten_slots: {
        coffee: { eaten_at: "2026-09-10T09:00:00.000Z", changed_at: NEW },
        "meal-1": { eaten_at: "2026-09-10T12:00:00.000Z", changed_at: OLD },
      } },
      { eaten_slots: {
        coffee: { eaten_at: null, changed_at: NEW },
        "meal-2": { eaten_at: "2026-09-10T18:00:00.000Z", changed_at: OLD },
      } }, NEW, OLD);
    expect(m.eaten_slots).toEqual({
      coffee: { eaten_at: null, changed_at: NEW },
      "meal-1": { eaten_at: "2026-09-10T12:00:00.000Z", changed_at: OLD },
      "meal-2": { eaten_at: "2026-09-10T18:00:00.000Z", changed_at: OLD },
    });
  });
  it("keeps server recipe history across stale offline timestamps and releases its epoch for ordinary ticks", () => {
    const oldConsumed = { eaten_at: NEW, changed_at: NEW, consumed: { title: "old" } };
    const active = { eaten_at: OLD, changed_at: OLD, consumed: { title: "current" },
      history_epoch: "11111111-1111-4111-8111-111111111111" };
    const undone = { eaten_at: null, changed_at: OLD,
      history_epoch: "22222222-2222-4222-8222-222222222222" };
    const merge = (local: unknown, server: unknown) => mergeEntity("plan_days",
      { eaten_slots: { "meal-3": local } }, { eaten_slots: { "meal-3": server } }, NEW, OLD)
      .eaten_slots as Record<string, unknown>;
    expect(merge(oldConsumed, active)["meal-3"]).toEqual(active);
    expect(merge(oldConsumed, undone)["meal-3"]).toEqual(undone);
    const ordinary = { eaten_at: NEW, changed_at: NEW,
      history_epoch: undone.history_epoch };
    expect(merge(ordinary, undone)["meal-3"]).toEqual(ordinary);
    expect(merge(oldConsumed, ordinary)["meal-3"]).toEqual(ordinary);
  });
  it("joins both notes on a gut_log conflict, older text first", () => {
    const m = mergeEntity("gut_log",
      { id: "a", state: "flare", note: "hurt on 9/12" },
      { id: "a", state: "iffy", note: "fine on 9/04" }, NEW, OLD);
    expect(m.note).toBe("fine on 9/04\nhurt on 9/12");
    expect(m.state).toBe("flare");
  });
});

describe("mergeEntity — deletes dominate", () => {
  it("keeps a tombstone the other side has not seen", () => {
    const m = mergeEntity("user_foods",
      { id: "a", name: "oat milk", deleted_at: null },
      { id: "a", name: "oat milk", deleted_at: "2026-09-10T09:00:00.000Z" }, NEW, OLD);
    expect(m.deleted_at).toBe("2026-09-10T09:00:00.000Z");
  });
  it("keeps a local tombstone against a newer server edit", () => {
    const m = mergeEntity("user_foods",
      { id: "a", deleted_at: "2026-09-10T09:30:00.000Z" },
      { id: "a", name: "oats", deleted_at: null }, OLD, NEW);
    expect(m.deleted_at).toBe("2026-09-10T09:30:00.000Z");
  });
});

describe("joinNotes — a real two-sided conflict", () => {
  it("joins two different notes, older text first, regardless of which side is newer", () => {
    expect(joinNotes("late", "at the desk", NEW, OLD)).toBe("at the desk\nlate");
    expect(joinNotes("at the desk", "late", OLD, NEW)).toBe("at the desk\nlate");
  });
  it("keeps one copy when both sides say the same thing", () => {
    expect(joinNotes("ok", "ok", NEW, OLD)).toBe("ok");
  });
  it("returns the only side that has a note", () => {
    expect(joinNotes("bad night", undefined, NEW, OLD)).toBe("bad night");
    expect(joinNotes(undefined, "bad night", OLD, NEW)).toBe("bad night");
  });
  it("returns undefined when neither side has a note", () => {
    expect(joinNotes(undefined, undefined, OLD, NEW)).toBeUndefined();
  });
});

/** Audit 2026-10-10 A139: each further conflict appended the server's text again. */
describe("joinNotes — repeated conflicts add nothing new", () => {
  it("keeps a rebased note that already carries the server's text as it is", () => {
    const first = joinNotes("hurt on 9/12", "fine 9/04", NEW, OLD);
    expect(first).toBe("fine 9/04\nhurt on 9/12");
    // The rebased op is refused again by a write that kept the server's note.
    expect(joinNotes(first, "fine 9/04", NEW, OLD)).toBe("fine 9/04\nhurt on 9/12");
    expect(joinNotes("fine 9/04", first, OLD, NEW)).toBe("fine 9/04\nhurt on 9/12");
  });

  it("is stable however many times the same pair conflicts", () => {
    let note = joinNotes("felt fine", "a bit heavy", NEW, OLD);
    for (let i = 0; i < 5; i += 1) note = joinNotes(note, "a bit heavy", NEW, OLD);
    expect(note).toBe("a bit heavy\nfelt fine");
  });

  it("appends only the newer side's lines the older side lacks", () => {
    expect(joinNotes("fine 9/04\nbloated", "fine 9/04\nslept badly", NEW, OLD))
      .toBe("fine 9/04\nslept badly\nbloated");
  });

  it("does the same for a user_food_prefs conflict replayed onto its own result", () => {
    const once = mergeEntity("user_food_prefs", { food_ref_id: "f1", note: "hurt on 9/12" },
      { food_ref_id: "f1", note: "fine 9/04", rev: 5 }, NEW, OLD);
    const twice = mergeEntity("user_food_prefs", { food_ref_id: "f1", note: once.note },
      { food_ref_id: "f1", note: "fine 9/04", rev: 6 }, NEW, OLD);
    expect(twice.note).toBe("fine 9/04\nhurt on 9/12");
  });
});

/** Audit 2026-10-10 A077: a whole-note edit is merged against the note it started from. */
describe("mergeNoteFromBase", () => {
  it("takes her rewrite when the other device left the note alone", () => {
    expect(mergeNoteFromBase("felt fine", "felt fine, then good", "felt fine", NEW, OLD))
      .toBe("felt fine, then good");
  });

  it("takes her clear when the other device left the note alone", () => {
    expect(mergeNoteFromBase("felt fine", null, "felt fine", NEW, OLD)).toBeUndefined();
  });

  it("takes the other device's note when she left it alone", () => {
    expect(mergeNoteFromBase("felt fine", "felt fine", "felt worse", NEW, OLD)).toBe("felt worse");
    expect(mergeNoteFromBase(null, null, "after the gym", NEW, OLD)).toBe("after the gym");
  });

  it("joins the two when both changed it, older text first", () => {
    expect(mergeNoteFromBase(null, "felt fine", "a bit heavy", NEW, OLD))
      .toBe("a bit heavy\nfelt fine");
  });

  it("treats surrounding whitespace as no change", () => {
    expect(mergeNoteFromBase("ok", "ok now", " ok ", NEW, OLD)).toBe("ok now");
  });
});

/** Audit 2026-10-10 A141 / backlog B091: a field-wise plan edit, merged slot by slot. */
describe("mergePlanDayFields", () => {
  it("keeps the other side's value for a field this edit left as it found it", () => {
    expect(mergePlanDayFields({ floor_day: false }, { floor_day: false }, { floor_day: true }, NEW, OLD))
      .toEqual({ floor_day: true });
  });

  it("keeps this edit's value for a field the other side left alone, older or not", () => {
    expect(mergePlanDayFields({ floor_day: true }, { floor_day: false }, { floor_day: false }, OLD, NEW))
      .toEqual({ floor_day: true });
  });

  it("merges swaps and item overrides per slot", () => {
    const merged = mergePlanDayFields(
      { swaps: { "meal-1": "oats" }, item_overrides: { "meal-1": { title: "Oats" } } },
      { swaps: {}, item_overrides: {} },
      { swaps: { "meal-2": "eggs" }, item_overrides: { "meal-3": { title: "Pad thai" } } }, OLD, NEW);
    expect(merged).toEqual({
      swaps: { "meal-1": "oats", "meal-2": "eggs" },
      item_overrides: { "meal-1": { title: "Oats" }, "meal-3": { title: "Pad thai" } },
    });
  });

  it("keeps a slot this edit removed, unless the other side changed it too", () => {
    expect(mergePlanDayFields({ swaps: {} }, { swaps: { "meal-1": "oats" } },
      { swaps: { "meal-1": "oats", "meal-2": "eggs" } }, OLD, NEW)).toEqual({ swaps: { "meal-2": "eggs" } });
    expect(mergePlanDayFields({ swaps: {} }, { swaps: { "meal-1": "oats" } },
      { swaps: { "meal-1": "toast" } }, OLD, NEW)).toEqual({ swaps: { "meal-1": "toast" } });
  });

  it("gives a slot both sides changed to the newer one, and keeps both notes", () => {
    expect(mergePlanDayFields({ swaps: { "meal-1": "oats" } }, { swaps: {} },
      { swaps: { "meal-1": "eggs" } }, NEW, OLD)).toEqual({ swaps: { "meal-1": "oats" } });
    expect(mergePlanDayFields({ slot_notes: { "meal-1": "ate half" } }, { slot_notes: {} },
      { slot_notes: { "meal-1": "no rice" } }, NEW, OLD))
      .toEqual({ slot_notes: { "meal-1": "no rice\nate half" } });
  });

  it("gives each field and slot its own stamp from the ops that changed it (Sol WARN 4)", () => {
    const stamps = planDayStamps([
      { payload: { swaps: { "meal-1": "oats" } }, base_fields: { swaps: {} }, client_ts: OLD },
      { payload: { floor_day: true }, base_fields: { floor_day: false }, client_ts: NEW },
    ]);
    expect(stamps("swaps", "meal-1")).toBe(OLD);
    expect(stamps("floor_day")).toBe(NEW);
    const between = new Date((Date.parse(OLD) + Date.parse(NEW)) / 2).toISOString();
    expect(mergePlanDayFields({ swaps: { "meal-1": "oats" }, floor_day: true },
      { swaps: {}, floor_day: false }, { swaps: { "meal-1": "eggs" }, floor_day: false }, stamps, between))
      .toEqual({ swaps: { "meal-1": "eggs" }, floor_day: true });
  });

  it("reads an override the server re-ordered as the same override", () => {
    const mine = { baseMealId: null, title: "Chili", components: [] };
    const jsonb = { title: "Chili", components: [], baseMealId: null };
    expect(mergePlanDayFields({ item_overrides: { "meal-1": mine } },
      { item_overrides: { "meal-1": jsonb } }, { item_overrides: {} }, NEW, OLD))
      .toEqual({ item_overrides: {} });
  });
});

describe("mergeEntity — never merged", () => {
  it("lists target_profiles and refuses to merge it", () => {
    expect(NEVER_MERGED.has("target_profiles")).toBe(true);
    expect(() => mergeEntity("target_profiles" as never, {}, {}, OLD, NEW)).toThrow(MergeRefusedError);
  });
});


describe("mergeEntity — log_entries", () => {
  it("keeps both notes, older text first, and takes the newer slot", () => {
    const m = mergeEntity("log_entries",
      { id: "e1", slot: "meal-2", note: "late", items: [] },
      { id: "e1", slot: "meal-1", note: "at the desk", items: [] }, NEW, OLD);
    expect(m.note).toBe("at the desk\nlate");
    expect(m.slot).toBe("meal-2");
  });
  it("keeps one copy when both notes say the same thing", () => {
    const m = mergeEntity("log_entries",
      { id: "e1", note: "ok", items: [] }, { id: "e1", note: "ok", items: [] }, NEW, OLD);
    expect(m.note).toBe("ok");
  });
  it("merges items by id: newer wins per field, one-sided ids are kept", () => {
    const m = mergeEntity("log_entries",
      { id: "e1", items: [{ id: "i1", seq: 1, grams: 120 }, { id: "i2", seq: 2, grams: 30 }] },
      { id: "e1", items: [{ id: "i1", seq: 1, grams: 100 }, { id: "i3", seq: 3, grams: 10 }] },
      NEW, OLD);
    expect(m.items).toEqual([
      { id: "i1", seq: 1, grams: 120 }, { id: "i2", seq: 2, grams: 30 }, { id: "i3", seq: 3, grams: 10 },
    ]);
  });
});

describe("mergeEntity — log_items, user_food_prefs, water_log", () => {
  it("takes the newer client_ts per field for a log_item", () => {
    expect(mergeEntity("log_items", { id: "i1", grams: 120 }, { id: "i1", grams: 100 }, OLD, NEW).grams).toBe(100);
  });
  it("takes the newer status and role for prefs and keeps both notes", () => {
    const m = mergeEntity("user_food_prefs",
      { food_ref_id: "f1", status: "avoid", role: "carb", note: "hurt on 9/12" },
      { food_ref_id: "f1", status: "eats", role: "protein", note: "fine on 9/04" }, NEW, OLD);
    expect(m).toMatchObject({ status: "avoid", role: "carb" });
    expect(m.note).toBe("fine on 9/04\nhurt on 9/12");
  });
  it("takes the larger cups, whichever side is newer", () => {
    const a = mergeEntity("water_log", { local_date: "d", cups: 5 }, { local_date: "d", cups: 7 }, NEW, OLD);
    const b = mergeEntity("water_log", { local_date: "d", cups: 8 }, { local_date: "d", cups: 2 }, OLD, NEW);
    expect([a.cups, b.cups]).toEqual([7, 8]);
  });
});

describe("mergeEntity on phase 3 entities", () => {
  const local = { id: "r1", name: "Rice tray v2", servings: 4,
    items: [{ seq: 1, food_ref_id: "f1", grams: 400 }] };
  const server = { id: "r1", name: "Rice tray", servings: 3, rev: 7,
    items: [{ seq: 1, food_ref_id: "f1", grams: 300 }] };

  it("never field-merges a recipe: the local payload wins whole, on the server's rev", () => {
    const merged = mergeEntity("recipes", local, server,
      "2026-09-19T10:00:00.000Z", "2026-09-19T11:00:00.000Z");
    expect(merged.name).toBe("Rice tray v2");
    expect(merged.servings).toBe(4);
    expect(merged.items).toEqual(local.items);
    expect(merged.rev).toBe(7);
  });

  it("keeps a recipe tombstone from either side", () => {
    const merged = mergeEntity("recipes", local, { ...server, deleted_at: "2026-09-19T09:00:00.000Z" },
      "2026-09-19T10:00:00.000Z", "2026-09-19T11:00:00.000Z");
    expect(merged.deleted_at).toBe("2026-09-19T09:00:00.000Z");
  });

  it("settles a favorite's sort on the newer client_ts", () => {
    const mine = { food_ref_id: "f1", sort: 9 };
    const theirs = { food_ref_id: "f1", sort: 2, rev: 3 };
    const newer = mergeEntity("favorites_foods", mine, theirs,
      "2026-09-19T12:00:00.000Z", "2026-09-19T11:00:00.000Z");
    expect([newer.sort, newer.rev]).toEqual([9, 3]);
    const older = mergeEntity("favorites_foods", mine, theirs,
      "2026-09-19T10:00:00.000Z", "2026-09-19T11:00:00.000Z");
    expect(older.sort).toBe(2);
  });
});

describe("rebaseOp", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-09-10T12:00:00.000Z") }));
  afterEach(() => vi.useRealTimers());

  const op: SyncOp = {
    op_id: "11111111-1111-4111-8111-111111111111", entity: "water_log",
    entity_id: "2026-09-11", kind: "update", base_rev: 3,
    payload: { cups: 5 }, client_ts: OLD,
  };

  it("rebases onto the current rev with a fresh id and a fresh stamp", () => {
    const next = rebaseOp(op, { local_date: "2026-09-11", cups: 7, rev: 9 }, 9);
    expect(next.base_rev).toBe(9);
    expect(next.payload).toEqual({ local_date: "2026-09-11", cups: 7, rev: 9 });
    expect(next.op_id).not.toBe(op.op_id);
    expect(next.op_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(next.client_ts).toBe("2026-09-10T12:00:00.000Z");
    expect(next.entity_id).toBe("2026-09-11");
  });
  it("turns a rejected create into an update, because the row now exists", () => {
    expect(rebaseOp({ ...op, kind: "create", base_rev: null }, { cups: 7 }, 1).kind).toBe("update");
  });
  it("refuses a merged payload that is not an object", () => {
    expect(() => rebaseOp(op, null, 9)).toThrow(/payload/);
  });
});
