// Server-side target recompute (#330, user 40707946's stale revision): derives from the stored
// user_settings row, writes through write_target_revision, converges when a newer settings write
// races it, and leaves adaptive/proposal revisions alone.
import { describe, expect, it } from "vitest";
import { deriveTargetRevision } from "@/lib/profile/derive";
import {
  localDate, weighInKgToKeep, recomputeDerivedTarget, settingsFromRow,
} from "@/lib/server/target-recompute";
import {
  TODAY, USER, activeOn, fakeClient, settingsRow, staleTarget, type Row,
} from "./recompute-fake";

describe("recomputeDerivedTarget", () => {
  it("replaces the stale 2104 kcal revision with the app's own derivation, effective today", async () => {
    const fake = fakeClient(settingsRow(), [staleTarget()]);
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(outcome.status).toBe("written");
    expect(fake.writes).toHaveLength(1);
    const write = fake.writes[0] as Row & { training_macros: Row; rest_macros: Row };
    expect(write.effective_from).toBe(TODAY);
    expect(write.training_macros).toMatchObject({ kcal: 1960, protein: 145 });
    expect(write.rest_macros).toMatchObject({ kcal: 1764 });
    expect(write.kcal_min).toBe(1430);
    expect(write).toMatchObject({ formula_name: "profile-energy-v1", target_source: "derived",
      input_goal: "recomp", input_activity_level: "moderate", input_weight_kg: 72.575,
      input_weight_source: "onboarding", input_training_weekdays: [1, 3, 4, 5], goal_rate_bp_week: 0,
      kcal_min_source: "macro_minimum", pin_training_kcal: null, pin_rest_kcal: null, pin_protein_g: null });
    // A second run is a no-op: nothing to write once the revision matches.
    const again = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(again.status).toBe("unchanged");
    expect(fake.writes).toHaveLength(1);
  });

  it("writes nothing on a dry run", async () => {
    const fake = fakeClient(settingsRow(), [staleTarget()]);
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY, dryRun: true });
    expect(outcome.status).toBe("would_write");
    expect(fake.writes).toHaveLength(0);
  });

  it("skips an account that has not finished onboarding", async () => {
    const fake = fakeClient(settingsRow({ onboarded_at: null }), []);
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "not_onboarded" });
    expect(fake.writes).toHaveLength(0);
  });

  it("skips an incomplete profile", async () => {
    const fake = fakeClient(settingsRow({ birth_year: null }), [staleTarget()]);
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "incomplete_profile" });
    expect(fake.writes).toHaveLength(0);
  });

  it("leaves an adaptive or proposal revision alone", async () => {
    const fake = fakeClient(settingsRow(), [staleTarget({ formula_name: "adaptive-tdee-v1" })]);
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "authoritative_formula" });
    expect(fake.writes).toHaveLength(0);
  });

  it("keeps a weigh-in revision's weight; weigh-ins are the weigh-in path's to apply", async () => {
    const fake = fakeClient(settingsRow({ activity_level: "light" }),
      [staleTarget({ input_weight_kg: 70, input_weight_source: "weigh-in" })],
      [{ user_id: USER, local_date: "2026-09-01", start_time: "2026-09-01T14:00:00Z", value: 90, unit: "kg" }]);
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(fake.writes[0]).toMatchObject({ input_weight_kg: 70, input_weight_source: "weigh-in",
      input_activity_level: "light" });
  });

  it("skips instead of writing a dead row when a revision is dated after the run's date", async () => {
    const fake = fakeClient(settingsRow(), [staleTarget(),
      staleTarget({ id: "future", rev: 6, effective_from: "2026-10-04" })]);
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "future_revision" });
    expect(fake.writes).toHaveLength(0);
  });

  it("re-plans when the settings row moved between the plan and the write", async () => {
    const fake = fakeClient(settingsRow(), [staleTarget()]);
    let moved = false;
    fake.beforeWrite = () => {
      if (!moved) { moved = true; fake.settings.row = settingsRow({ rev: 8, activity_level: "active" }); }
    };
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(fake.conflicts).toBe(1);
    expect(fake.writes.map((w) => w.input_activity_level)).toEqual(["active"]);
    expect(outcome).toMatchObject({ status: "written" });
  });

  it("rewrites a revision whose macros match but whose floor provenance is legacy", async () => {
    const fake = fakeClient(settingsRow(), [staleTarget()]);
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    const current = fake.targets[fake.targets.length - 1];
    fake.targets.push({ ...current, id: "legacy", rev: current.rev + 1,
      kcal_min_source: "legacy_default" });
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "written" });
  });

  it("keeps the active revision's pins even when the settings pin columns are empty", async () => {
    const fake = fakeClient(settingsRow({ activity_level: "light" }),
      [staleTarget({ target_source: "manual", pin_training_kcal: 2000, pin_protein_g: 150 })]);
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(fake.writes[0]).toMatchObject({ target_source: "manual", pin_training_kcal: 2000,
      pin_rest_kcal: null, pin_protein_g: 150, input_activity_level: "light" });
    // The pin holds to the gram rounding adjustCalories applies (atwater identity on whole grams).
    const training = fake.writes[0].training_macros as { kcal: number; protein: number };
    expect(training.protein).toBe(150);
    expect(Math.abs(training.kcal - 2000)).toBeLessThanOrEqual(5);
  });

  it("skips when the settings row carries pins the revision does not (cannot tell which is newer)", async () => {
    const fake = fakeClient(settingsRow({ training_kcal: 2000, activity_level: "light" }), [staleTarget()]);
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "pins_differ" });
    expect(fake.writes).toHaveLength(0);
  });

  it("proceeds when the settings pins equal the revision's", async () => {
    const fake = fakeClient(settingsRow({ training_kcal: 2000, activity_level: "light" }),
      [staleTarget({ target_source: "manual", pin_training_kcal: 2000 })]);
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(fake.writes[0]).toMatchObject({ pin_training_kcal: 2000, input_activity_level: "light" });
  });

  it("reports the skip, not 'written', when an adaptive revision wins after a write", async () => {
    const fake = fakeClient(settingsRow(), [staleTarget()]);
    fake.afterWrite = () => {
      fake.targets.push(staleTarget({ id: "adaptive", rev: 99, effective_from: TODAY,
        formula_name: "adaptive-tdee-v1" }));
    };
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "authoritative_formula" });
  });

  it("leaves a legacy revision with no formula or source alone", async () => {
    for (const legacy of [{ formula_name: null }, { target_source: null }]) {
      const fake = fakeClient(settingsRow(), [staleTarget(legacy as never)]);
      await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
        .resolves.toMatchObject({ status: "skipped", reason: "authoritative_formula" });
      expect(fake.writes).toHaveLength(0);
    }
  });

  it("leaves a proposal revision alone", async () => {
    const fake = fakeClient(settingsRow(), [staleTarget({ target_source: "proposal" })]);
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "skipped", reason: "authoritative_formula" });
    expect(fake.writes).toHaveLength(0);
  });

  it("never buries a revision that became active after the plan read", async () => {
    const fake = fakeClient(settingsRow(), [staleTarget()]);
    // An adaptive revision commits between this run's read and its write.
    fake.beforeWrite = (attempt) => {
      if (attempt === 1) fake.targets.push(staleTarget({ id: "t6", rev: 6, effective_from: TODAY,
        formula_name: "adaptive-tdee-v1" }));
    };
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(fake.conflicts).toBe(1);
    expect(fake.writes).toHaveLength(0);
    expect(outcome).toMatchObject({ status: "skipped", reason: "authoritative_formula" });
    expect(activeOn(fake.targets, TODAY)?.id).toBe("t6");
  });

  it("coerces a numeric-string goal rate before comparing", async () => {
    const fake = fakeClient(settingsRow({ goal_rate_bp_week: "0" }), [staleTarget()]);
    await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    await expect(recomputeDerivedTarget(fake.client, USER, { today: TODAY }))
      .resolves.toMatchObject({ status: "unchanged" });
  });

  it("re-derives from the newer row when a settings write lands during the recompute", async () => {
    const fake = fakeClient(settingsRow(), [staleTarget()]);
    // The first write derived from activity "moderate"; a newer save switched to "active" meanwhile.
    fake.afterWrite = (count) => {
      if (count === 1) fake.settings.row = settingsRow({ rev: 8, activity_level: "active" });
    };
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(outcome).toMatchObject({ status: "written", rounds: 2 });
    expect(fake.writes.map((w) => w.input_activity_level)).toEqual(["moderate", "active"]);
    // The reported active revision is the one left in force, not the stale one read first.
    expect(outcome.active?.input_activity_level).toBe("active");
  });

  it("reports unsettled, not written, when the profile moves after every write", async () => {
    const fake = fakeClient(settingsRow(), [staleTarget()]);
    const levels = ["light", "active", "very_active", "sedentary", "moderate"] as const;
    fake.afterWrite = (count) => {
      fake.settings.row = settingsRow({ rev: 7 + count, activity_level: levels[count - 1] });
    };
    const outcome = await recomputeDerivedTarget(fake.client, USER, { today: TODAY });
    expect(outcome.status).toBe("unsettled");
  });

  it("derives the same numbers whatever the display-only Settings fields hold", () => {
    const base = settingsFromRow(settingsRow() as never);
    const varied = { ...base, proteinLocked: false, slotTimes: { breakfast: "06:00" },
      shiftMinutes: 90, changedAt: "2026-10-01T00:00:00Z" } as typeof base;
    const input = { latestWeighInKg: null, today: TODAY, trainingWeekdays: [1, 3, 4, 5] };
    const left = deriveTargetRevision({ ...input, settings: base });
    const right = deriveTargetRevision({ ...input, settings: varied });
    expect({ training: right.training, rest: right.rest, floors: right.floors })
      .toEqual({ training: left.training, rest: left.rest, floors: left.floors });
  });
});

describe("weighInKgToKeep", () => {
  it("keeps a weigh-in revision's weight and defers to the profile weight otherwise", () => {
    expect(weighInKgToKeep({ input_weight_source: "weigh-in", input_weight_kg: 80.04 })).toBe(80.04);
    expect(weighInKgToKeep({ input_weight_source: "onboarding", input_weight_kg: 72.5 })).toBeNull();
    expect(weighInKgToKeep(null)).toBeNull();
  });
});

describe("localDate", () => {
  it("uses the account's zone and falls back to UTC for an unknown zone", () => {
    const late = new Date("2026-10-04T03:00:00Z");
    expect(localDate("America/Denver", late)).toBe("2026-10-03");
    expect(localDate("Not/AZone", late)).toBe("2026-10-04");
    expect(localDate(null, late)).toBe("2026-10-04");
  });
});
