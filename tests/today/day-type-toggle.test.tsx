/**
 * T5 — toggle and lock a day as training or rest from the Today header.
 *
 * Vitest runs in the Node environment and React Testing Library is not installed (Sol harness), so
 * the tap is a manual phone gate. What is asserted here: the pure mapping and no-op rule, the write
 * payload, and static renders of the chip and the sheet. The renders check the accessible copy and
 * the 44 px `.tap` class — never a `data-*` hook or an exact SVG path.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DayTypeChip from "@/components/DayTypeChip";
import DayTypeMenu from "@/components/DayTypeMenu";
import { dayTypeFor } from "@/lib/plan";
import {
  createChoiceGate, dayTypeChipName, dayTypeChoiceChanges, dayTypeChoices, dayTypeLabel,
  dayTypeNowNote, nextChoiceAction, type DayTypeChoice,
} from "@/lib/plan-day";
import {
  dayTypeChoicePatch, savePlanDay, saveSlotNote, saveSwap, toggleFloorDay,
} from "@/lib/plan-day-client";
import { getDay, updateDay } from "@/lib/store";
import { allOps, getRow, putRow } from "@/lib/sync/idb";
import { enqueue, enqueueWithRow } from "@/lib/sync/outbox";
import { resolveTargets } from "@/lib/targets";
import type { DayType, Settings, StoredDay } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";
import type { AccountHandle } from "@/lib/device/account";

let h: AccountHandle;

// 2026-09-07 is a Monday, 09-08 a Tuesday and 09-09 a Wednesday. Every weekday trains at
// training-10 (onboarding v2 G6: the old hard-coded Wednesday fasted session is nobody's default).
const MON = "2026-09-07";
const TUE = "2026-09-08";
const WED = "2026-09-09";

/** Storage dates, one per test: the legacy store is a module-level singleton for the whole file. */
const LEGACY_DATE = "2026-10-05";
const CREATE_DATE = "2026-10-06";
const MIRROR_DATE = "2026-10-07";
const KEEP_DATE = "2026-10-08";
const BOUNDARY_DATE = "2026-10-09";
const FAIL_DATE = "2026-10-10";
const NO_LOCK_DATE = "2026-10-11";
const FLOOR_DATE = "2026-10-12";
const SWAP_DATE = "2026-10-13";
const NOTE_DATE = "2026-10-14";

const PINNED_OFF: Settings = {
  trainingKcal: null,
  restKcal: null,
  proteinG: null,
  proteinLocked: true, slotTimes: {}, shiftMinutes: 0, changedAt: null,
  activeTargetProfile: {
    revision: 1, source: "derived", effectiveFrom: MON,
    training: { kcal: 2200, protein: 135, carbs: 230, fat: 80 },
    rest: { kcal: 1800, protein: 135, carbs: 130, fat: 80 },
    pins: { trainingKcal: null, restKcal: null, proteinG: null },
    inputs: { effectiveDate: MON, weightKg: 60, weightSource: "onboarding",
      trainingWeekdays: [1, 3, 4, 5], activity: "moderate", goal: "recomp", goalRateBpWeek: 0,
      formulaName: "profile-energy-v1" },
  },
};

/** One sheet row's markup, split on the row buttons so a check mark can be attributed to a row. */
function rowSegment(markup: string, label: string): string {
  const segment = markup.split("<button").find((part) => part.includes(`>${label}</span>`));
  if (!segment) throw new Error(`no "${label}" row in the render`);
  return segment;
}

describe("dayTypeChoices", () => {
  const LABELS = ["Training day", "Rest day", "Follow the schedule"];

  it("always offers all three rows, in the same order", () => {
    expect(dayTypeChoices("training-10", MON, false).map((c) => c.label)).toEqual(LABELS);
    expect(dayTypeChoices("rest", TUE, false).map((c) => c.label)).toEqual(LABELS);
    expect(dayTypeChoices("rest", MON, true).map((c) => c.label)).toEqual(LABELS);
  });

  it("marks the day type in force, and only that row", () => {
    expect(dayTypeChoices("training-10", MON, false).filter((c) => c.current).map((c) => c.id))
      .toEqual(["training"]);
    expect(dayTypeChoices("rest", TUE, false).filter((c) => c.current).map((c) => c.id))
      .toEqual(["rest"]);
    expect(dayTypeChoices("rest", MON, true).filter((c) => c.current).map((c) => c.id))
      .toEqual(["rest"]);
  });

  it("maps the training row to the date's own variant", () => {
    expect(dayTypeChoices("rest", TUE, false)[0].dayType).toBe("training-10");
    expect(dayTypeChoices("rest", WED, true)[0].dayType).toBe("training-10");
    // A fasted session the date already saved stays its training row.
    expect(dayTypeChoices("training-7-fasted", WED, false)[0].dayType).toBe("training-7-fasted");
  });

  it("keeps the clear row an action: it is never the marked one", () => {
    expect(dayTypeChoices("training-10", MON, false).map((c) => c.current))
      .toEqual([true, false, false]);
  });
});

describe("dayTypeChoiceChanges", () => {
  const byId = (dayType: DayType, date: string, locked: boolean, id: string) => {
    const found = dayTypeChoices(dayType, date, locked).find((c) => c.id === id);
    if (!found) throw new Error(`no "${id}" row`);
    return found;
  };

  it("is a no-op for the type already in force", () => {
    expect(dayTypeChoiceChanges(byId("training-10", MON, false, "training"), "training-10", false))
      .toBe(false);
    expect(dayTypeChoiceChanges(byId("rest", TUE, false, "rest"), "rest", false)).toBe(false);
    expect(dayTypeChoiceChanges(byId("rest", MON, true, "rest"), "rest", true)).toBe(false);
  });

  it("writes when moved to the other side of the day", () => {
    expect(dayTypeChoiceChanges(byId("training-10", MON, false, "rest"), "training-10", false))
      .toBe(true);
    expect(dayTypeChoiceChanges(byId("rest", TUE, false, "training"), "rest", false)).toBe(true);
    expect(dayTypeChoiceChanges(byId("rest", WED, true, "training"), "rest", true)).toBe(true);
  });

  it("only clears when there is an override to clear", () => {
    expect(dayTypeChoiceChanges(byId("training-10", MON, false, "clear"), "training-10", false))
      .toBe(false);
    expect(dayTypeChoiceChanges(byId("rest", MON, true, "clear"), "rest", true)).toBe(true);
  });
});

describe("dayTypeNowNote", () => {
  it("says what is in force, schedule or lock", () => {
    expect(dayTypeNowNote("training-10", false)).toBe("Training day on the schedule");
    expect(dayTypeNowNote("rest", true)).toBe("Locked as a rest day — calories follow.");
  });
});

describe("nextChoiceAction", () => {
  const row = (dayType: DayType, date: string, locked: boolean, id: string) => {
    const found = dayTypeChoices(dayType, date, locked).find((c) => c.id === id);
    if (!found) throw new Error(`no "${id}" row`);
    return found;
  };

  it("saves a real change and closes on a no-op while nothing is in flight", () => {
    expect(nextChoiceAction(
      { saving: false, dayType: "training-10", locked: false },
      row("training-10", MON, false, "rest"),
    )).toBe("save");
    expect(nextChoiceAction(
      { saving: false, dayType: "training-10", locked: false },
      row("training-10", MON, false, "clear"),
    )).toBe("close");
    expect(nextChoiceAction(
      { saving: false, dayType: "rest", locked: true },
      row("rest", MON, true, "clear"),
    )).toBe("save");
  });

  it("ignores every row while a save is in flight", () => {
    for (const choice of dayTypeChoices("training-10", MON, false)) {
      expect(nextChoiceAction(
        { saving: true, dayType: "training-10", locked: false },
        choice,
      )).toBe("ignore");
    }
    // The row that would otherwise be the no-op close is ignored too: the tap
    // that started the save owns the outcome until it settles.
    expect(nextChoiceAction(
      { saving: true, dayType: "rest", locked: true },
      row("rest", MON, true, "clear"),
    )).toBe("ignore");
  });
});

/* The component's choose(): one synchronous gate read, then the save, released
   in `finally` — the same two calls in components/DayTypeToggle.tsx. */
function makeChooser(
  dayType: DayType,
  locked: boolean,
  write: (choice: DayTypeChoice) => Promise<void>,
) {
  const gate = createChoiceGate();
  return async function choose(choice: DayTypeChoice) {
    const action = nextChoiceAction({ saving: gate.saving(), dayType, locked }, choice);
    if (action === "ignore") return "ignored" as const;
    if (action === "close") return "closed" as const;
    gate.claim();
    try {
      await write(choice);
    } finally {
      gate.release();
    }
    return "saved" as const;
  };
}

describe("single-flight gate", () => {
  it("drops a second selection while the first save is still pending — one write, not two", async () => {
    const writes: DayTypeChoice[] = [];
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    const choose = makeChooser("training-10", false, async (choice) => {
      writes.push(choice);
      await pending;
    });
    const [training, rest] = dayTypeChoices("training-10", MON, false);
    const clear = dayTypeChoices("rest", MON, true)[2];

    const first = choose(rest); // "Rest day" — the save starts and stays pending
    expect(writes.map((c) => c.dayType)).toEqual(["rest"]);

    // Three taps land before the first save settles: the same row again (the
    // duplicate-op case), the other side of the day, and the clear row.
    const repeats = [choose(rest), choose(training), choose(clear)];
    expect(writes.map((c) => c.dayType)).toEqual(["rest"]);
    await expect(Promise.all(repeats)).resolves.toEqual(["ignored", "ignored", "ignored"]);
    expect(writes.map((c) => c.dayType)).toEqual(["rest"]); // still one write

    settle();
    await expect(first).resolves.toBe("saved");
    expect(writes).toHaveLength(1);
  });

  it("frees the rows again when the save fails, so the next tap is the retry", async () => {
    const attempted: string[] = [];
    const choose = makeChooser("training-10", false, async (choice) => {
      attempted.push(choice.id);
      if (attempted.length === 1) throw new Error("offline");
    });
    const rest = dayTypeChoices("training-10", MON, false)[1];

    await expect(choose(rest)).rejects.toThrow("offline");
    await expect(choose(rest)).resolves.toBe("saved");
    expect(attempted).toEqual(["rest", "rest"]); // the retry reached the write
  });
});

describe("dayTypeLabel", () => {
  it("keeps the weekday chip copy when the override is cleared", () => {
    expect(dayTypeLabel("rest", undefined)).toBe("Rest day");
    expect(dayTypeLabel("training-10", undefined)).toBe("Training day");
    expect(dayTypeLabel("training-7-fasted", undefined)).toBe("Training \u00b7 fasted 7am");
  });

  it("names the lock once an override is in play", () => {
    expect(dayTypeLabel("training-10", "rest")).toBe("Locked as a rest day");
    expect(dayTypeLabel("rest", "training-10")).toBe("Locked as a training day");
    expect(dayTypeLabel("rest", "training-7-fasted")).toBe("Locked as a training day");
  });
});

describe("dayTypeChipName", () => {
  it("states the day type, the lock, and what the button does", () => {
    expect(dayTypeChipName("rest", true)).toBe("Day type: rest day, locked. Change");
    expect(dayTypeChipName("training-10", false))
      .toBe("Day type: training day, on the schedule. Change");
    expect(dayTypeChipName("training-7-fasted", false))
      .toBe("Day type: fasted training day, on the schedule. Change");
  });
});

describe("DayTypeChip", () => {
  it("names the day type and the lock, and says it opens a menu", () => {
    const markup = renderToStaticMarkup(
      <DayTypeChip dayType="training-10" override={undefined} open={false} onOpen={() => {}} />,
    );
    expect(markup).toContain('aria-label="Day type: training day, on the schedule. Change"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain("Training day");
  });

  it("says the day is locked once it has been pinned", () => {
    const markup = renderToStaticMarkup(
      <DayTypeChip dayType="rest" override="rest" open={true} onOpen={() => {}} />,
    );
    expect(markup).toContain('aria-label="Day type: rest day, locked. Change"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Locked as a rest day");
  });

  it("is a 44 px tap target whose open label can shrink", () => {
    const markup = renderToStaticMarkup(
      <DayTypeChip dayType="rest" override="rest" open={true} onOpen={() => {}} />,
    );
    expect(markup).toContain('class="tap ');
    expect(markup).toContain("min-w-0");
    expect(markup).toContain("truncate");
  });
});

/* The header layout — the day-type chip beside the avatar —
   stays a manual phone gate. It used to be asserted here by grepping app/page.tsx for class order,
   which passed or failed on string order rather than on anything a browser laid out. */

describe("DayTypeMenu", () => {
  function render(dayType: DayType, date: string, locked: boolean, error?: string, saving = false) {
    return renderToStaticMarkup(
      <DayTypeMenu
        date={date}
        dayType={dayType}
        locked={locked}
        saving={saving}
        error={error}
        onChoose={() => {}}
        onClose={() => {}}
      />,
    );
  }

  it("keeps the rest row on a locked rest day and marks it current", () => {
    const markup = render("rest", MON, true);
    expect(markup).toContain(">Training day</span>");
    expect(markup).toContain(">Rest day</span>");
    expect(markup).toContain(">Follow the schedule</span>");
    expect(rowSegment(markup, "Rest day")).toContain('aria-checked="true"');
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
  });

  it("draws the check glyph on the current row only", () => {
    const markup = render("training-10", MON, false);
    expect(rowSegment(markup, "Training day")).toContain("<svg");
    expect(rowSegment(markup, "Rest day")).not.toContain("<svg");
    expect(rowSegment(markup, "Follow the schedule")).not.toContain("<svg");
  });

  it("never offers a Wednesday fasted session from a locked rest day (G6)", () => {
    const markup = render("rest", WED, true);
    expect(rowSegment(markup, "Training day")).toContain("Usual slot times");
    expect(markup).not.toContain("Wednesday");
    expect(markup).not.toContain("fasted");
    expect(markup).toContain("Now: Locked as a rest day — calories follow.");
  });

  it("keeps every row tappable when the save failed, under the error copy", () => {
    const markup = render("training-10", MON, false, "Couldn't save. Try again.");
    expect(markup).toContain("Couldn&#x27;t save. Try again.");
    for (const label of ["Training day", "Rest day", "Follow the schedule"]) {
      expect(rowSegment(markup, label)).toContain('class="tap ');
    }
  });

  it("disables all three rows, visibly, while a save is in flight", () => {
    const markup = render("training-10", MON, false, undefined, true);
    for (const label of ["Training day", "Rest day", "Follow the schedule"]) {
      const row = rowSegment(markup, label);
      expect(row).toContain('disabled=""');
    }
    expect(markup).toContain('aria-busy="true"');
  });

  it("leaves the rows live when nothing is in flight", () => {
    const markup = render("training-10", MON, false);
    for (const label of ["Training day", "Rest day", "Follow the schedule"]) {
      const row = rowSegment(markup, label);
      expect(row).not.toContain('disabled=""');
    }
  });
});

describe("savePlanDay", () => {
  beforeEach(async () => {
    h = await resetTestAccount();
    globalThis.indexedDB = new IDBFactory();
  });

  it("sets and clears the legacy override", async () => {
    await savePlanDay(LEGACY_DATE, { dayTypeOverride: "rest" });
    expect(getDay(LEGACY_DATE)?.dayTypeOverride).toBe("rest");
    await savePlanDay(LEGACY_DATE, { dayTypeOverride: null });
    expect(getDay(LEGACY_DATE)?.dayTypeOverride).toBeUndefined();
  });

  it("queues one complete plan_days row, never a partial op", async () => {
    await savePlanDay(CREATE_DATE, { dayTypeOverride: "rest" });
    const [op] = await allOps(h);
    expect(op).toMatchObject({ entity: "plan_days", entity_id: CREATE_DATE, kind: "create" });
    // Five fields since 2026-09-14: item_overrides joined the row when slot editing landed. The
    // SQL branch replaces the whole row, so an op that omits one deletes it.
    // `eaten_slots` is the exception: omit = keep on the server (design §3.3), so
    // a plan op that does not name it must leave the key off the payload.
    expect(op.payload).toEqual({
      local_date: CREATE_DATE,
      day_type_override: "rest",
      floor_day: false,
      swaps: {},
      slot_notes: {},
      item_overrides: {},
    });
    expect((await getRow(h, "plan_days", CREATE_DATE))?.day_type_override).toBe("rest");
  });

  // Audit 2026-10-10 A141: an update names only what it changed. The server keeps every field a
  // payload omits (migration 20261026090000), so the mirror's floor day, swaps, notes and edits stay
  // without riding along — and a conflict can tell this edit from the other device's.
  it("sends only the day type, and the mirror keeps the floor day, swaps, notes and edits", async () => {
    const edited = {
      coffee: {
        baseMealId: "coffee-latte",
        components: [{
          name: "Whole milk", qty: 1, unit: "cup", role: "free",
          macros: { kcal: 168, protein: 8, carbs: 12, fat: 9 },
        }],
      },
    };
    await putRow(h, "plan_days", MIRROR_DATE, {
      local_date: MIRROR_DATE,
      floor_day: true,
      swaps: { lunch: "meal-9" },
      slot_notes: { breakfast: "half portion" },
      item_overrides: edited,
      eaten_slots: {},
      rev: 4,
    });
    await savePlanDay(MIRROR_DATE, { dayTypeOverride: "rest" });
    const [op] = await allOps(h);
    expect(op).toMatchObject({ kind: "update", base_rev: 4 });
    expect(op.payload).toEqual({ local_date: MIRROR_DATE, day_type_override: "rest" });
    expect(op.base_fields).toEqual({ day_type_override: null });
    expect(await getRow(h, "plan_days", MIRROR_DATE)).toMatchObject({
      day_type_override: "rest", floor_day: true, swaps: { lunch: "meal-9" },
      slot_notes: { breakfast: "half portion" }, item_overrides: edited,
    });
  });

  it("keeps the day's floor flag, swaps and notes through a set and a clear", async () => {
    updateDay(KEEP_DATE, {
      floorDay: true,
      swaps: { "meal-2": "meal-3" },
      notes: { "meal-1": "big one" },
      dayTypeOverride: "training-10",
    });
    const kept = {
      floor_day: true,
      swaps: { "meal-2": "meal-3" },
      slot_notes: { "meal-1": "big one" },
    };

    // The server has no row for the day yet: the create carries the whole plan.
    await savePlanDay(KEEP_DATE, { dayTypeOverride: "rest" });
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({ day_type_override: "rest", ...kept });

    // The update names only the lock; the server keeps the rest.
    await savePlanDay(KEEP_DATE, { dayTypeOverride: null });
    expect((await allOps(h)).at(-1)?.payload).toEqual({ local_date: KEEP_DATE, day_type_override: null });
    expect(await getRow(h, "plan_days", KEEP_DATE)).toMatchObject({ day_type_override: null, ...kept });
    expect(getDay(KEEP_DATE)?.dayTypeOverride).toBeUndefined();
  });

  it("clears the override with an explicit null in the mirror and the op", async () => {
    await savePlanDay(MIRROR_DATE, { dayTypeOverride: "rest" });
    const firstId = (await allOps(h))[0].op_id;
    await savePlanDay(MIRROR_DATE, { dayTypeOverride: null });
    const ops = await allOps(h);
    expect(ops).toHaveLength(2);
    expect(ops[0].op_id).toBe(firstId);
    expect(ops[1].kind).toBe("update");
    expect(ops[1].payload).toMatchObject({ day_type_override: null });
    expect((await getRow(h, "plan_days", MIRROR_DATE))?.day_type_override).toBeNull();
  });

  it("carries the clear row's null across the boundary, all the way into the op", async () => {
    const clear = dayTypeChoices("rest", BOUNDARY_DATE, true).find((c) => c.id === "clear");
    if (!clear) throw new Error('no "Follow the schedule" row');
    expect(dayTypeChoicePatch(clear)).toStrictEqual({ dayTypeOverride: null });

    await savePlanDay(BOUNDARY_DATE, { dayTypeOverride: "rest" });
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({ day_type_override: "rest" });

    await savePlanDay(BOUNDARY_DATE, dayTypeChoicePatch(clear));
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({ day_type_override: null });
    expect((await getRow(h, "plan_days", BOUNDARY_DATE))?.day_type_override).toBeNull();
    expect(getDay(BOUNDARY_DATE)?.dayTypeOverride).toBeUndefined();
  });

  it("keeps a lock the patch never names — only an explicit null clears it", async () => {
    await savePlanDay(NO_LOCK_DATE, { dayTypeOverride: "rest" });
    await savePlanDay(NO_LOCK_DATE, { floorDay: true });
    expect(getDay(NO_LOCK_DATE)?.dayTypeOverride).toBe("rest");
    expect(getDay(NO_LOCK_DATE)?.floorDay).toBe(true);
    // The Floor Day update leaves the lock out, and the server keeps what a payload omits.
    expect((await allOps(h)).at(-1)?.payload).toEqual({ local_date: NO_LOCK_DATE, floor_day: true });
    expect(await getRow(h, "plan_days", NO_LOCK_DATE)).toMatchObject({
      day_type_override: "rest", floor_day: true,
    });
  });

  it("leaves the legacy day — and its save — alone when the enqueue rejects", async () => {
    const persisted = new Map<string, string>();
    const saved: string[] = [];
    const realWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (key: string) => persisted.get(key) ?? null,
        setItem: (key: string, value: string) => { persisted.set(key, value); saved.push(value); },
      },
    };
    try {
      const swaps = { "meal-2": () => "not clonable" } as unknown as StoredDay["swaps"];
      await expect(savePlanDay(FAIL_DATE, { floorDay: true, swaps })).rejects.toThrow();
    } finally {
      (globalThis as { window?: unknown }).window = realWindow;
    }
    expect(saved).toHaveLength(0);
    expect(getDay(FAIL_DATE)).toBeUndefined();
  });

  it("switches a locked rest day to locked training at training-10, Wednesday too", async () => {
    const training = dayTypeChoices("rest", WED, true)[0];
    await savePlanDay(WED, dayTypeChoicePatch(training));
    expect(getDay(WED)?.dayTypeOverride).toBe("training-10");
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({
      day_type_override: "training-10",
    });
    expect(dayTypeFor(WED, getDay(WED)?.dayTypeOverride)).toBe("training-10");
  });
});

// Regression, audit 2026-09-13 finding #10: the Today screen's own Floor Day toggle, swap
// picker and slot-note sheet wrote the legacy store directly (`updateDay`) and never reached the
// outbox — the same `plan_days` op DayTypeToggle already sent for the day-type lock. app/page.tsx
// now routes all three through these wrappers instead.
describe("toggleFloorDay / saveSwap / saveSlotNote (today-screen writes reach the outbox)", () => {
  beforeEach(async () => {
    h = await resetTestAccount();
    globalThis.indexedDB = new IDBFactory();
  });

  it("toggleFloorDay flips the legacy flag and queues a plan_days op each time", async () => {
    await toggleFloorDay(FLOOR_DATE);
    expect(getDay(FLOOR_DATE)?.floorDay).toBe(true);
    expect((await allOps(h)).at(-1)).toMatchObject({ entity: "plan_days", entity_id: FLOOR_DATE });
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({ floor_day: true });

    await toggleFloorDay(FLOOR_DATE);
    expect(getDay(FLOOR_DATE)?.floorDay).toBe(false);
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({ floor_day: false });
    expect(await allOps(h)).toHaveLength(2);
  });

  it("saveSwap sets and clears one slot's swap and queues both", async () => {
    await saveSwap(SWAP_DATE, "meal-2", "meal-9");
    expect(getDay(SWAP_DATE)?.swaps).toEqual({ "meal-2": "meal-9" });
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({ swaps: { "meal-2": "meal-9" } });

    await saveSwap(SWAP_DATE, "meal-2", null);
    expect(getDay(SWAP_DATE)?.swaps).toEqual({});
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({ swaps: {} });
  });

  it("saveSwap only touches the named slot, leaving the rest of the day's swaps alone", async () => {
    updateDay(SWAP_DATE, { swaps: { "meal-1": "meal-4" } });
    await saveSwap(SWAP_DATE, "meal-2", "meal-9");
    expect(getDay(SWAP_DATE)?.swaps).toEqual({ "meal-1": "meal-4", "meal-2": "meal-9" });
  });

  it("saveSlotNote trims, saves and clears a note, mirroring lib/store.ts's setSlotNote", async () => {
    await saveSlotNote(NOTE_DATE, "meal-1", "  half portion  ");
    expect(getDay(NOTE_DATE)?.notes).toEqual({ "meal-1": "half portion" });
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({
      slot_notes: { "meal-1": "half portion" },
    });

    await saveSlotNote(NOTE_DATE, "meal-1", "   ");
    expect(getDay(NOTE_DATE)?.notes).toEqual({});
    expect((await allOps(h)).at(-1)?.payload).toMatchObject({ slot_notes: {} });
  });
});

describe("enqueueWithRow", () => {
  const mirrorOp = {
    op_id: "op-1",
    entity: "plan_days",
    entity_id: MIRROR_DATE,
    kind: "create",
    base_rev: null,
    payload: { local_date: MIRROR_DATE, day_type_override: "rest" },
    client_ts: "2026-10-07T12:00:00.000Z",
  } as const;

  beforeEach(async () => {
    h = await resetTestAccount();
    globalThis.indexedDB = new IDBFactory();
  });

  it("commits the mirror row and its op together", async () => {
    await enqueueWithRow(h, { ...mirrorOp.payload, rev: 1 }, mirrorOp);
    expect((await getRow(h, "plan_days", MIRROR_DATE))?.day_type_override).toBe("rest");
    expect((await allOps(h)).map((o) => o.op_id)).toEqual(["op-1"]);
  });

  it("refuses a row whose own key is not the op's entity_id", async () => {
    const otherDateOp = {
      ...mirrorOp,
      op_id: "op-other",
      entity_id: CREATE_DATE,
      payload: { local_date: CREATE_DATE, day_type_override: "rest" },
    };
    await expect(
      enqueueWithRow(h, { local_date: MIRROR_DATE, day_type_override: "rest", rev: 1 }, otherDateOp),
    ).rejects.toThrow(/row key/);
    expect(await allOps(h)).toHaveLength(0);
    expect(await getRow(h, "plan_days", MIRROR_DATE)).toBeUndefined();
    expect(await getRow(h, "plan_days", CREATE_DATE)).toBeUndefined();
  });

  it("still queues an op on its own when there is no mirror row to write", async () => {
    await enqueue(h, {
      ...mirrorOp,
      op_id: "op-2",
      entity_id: CREATE_DATE,
      payload: { local_date: CREATE_DATE, day_type_override: null },
    });
    expect((await allOps(h)).map((o) => o.op_id)).toEqual(["op-2"]);
    expect(await getRow(h, "plan_days", CREATE_DATE)).toBeUndefined();
  });

  it("rolls the op back when the mirror write fails, so the two cannot disagree", async () => {
    const row = { local_date: MIRROR_DATE, swaps: { lunch: () => "not clonable" } };
    await expect(
      enqueueWithRow(h, row, mirrorOp),
    ).rejects.toThrow();
    expect(await allOps(h)).toHaveLength(0);
    expect(await getRow(h, "plan_days", MIRROR_DATE)).toBeUndefined();
  });
});

describe("the override never moves protein", () => {
  it("rest and both training types share the revision's protein number", () => {
    const rest = resolveTargets("rest", PINNED_OFF)!.macros;
    const train = resolveTargets("training-10", PINNED_OFF)!.macros;
    const fasted = resolveTargets("training-7-fasted", PINNED_OFF)!.macros;
    expect(rest.protein).toBe(train.protein);
    expect(fasted.protein).toBe(rest.protein);
  });

  it("the locked rest target is the revision's rest target and drops the training kcal", () => {
    const dayType: DayType = dayTypeChoices("training-10", MON, false)[1].dayType ?? "rest";
    const rest = resolveTargets(dayType, PINNED_OFF)!.macros;
    expect(rest).toEqual(PINNED_OFF.activeTargetProfile!.rest);
    expect(rest.kcal).toBeLessThan(PINNED_OFF.activeTargetProfile!.training.kcal);
  });
});
