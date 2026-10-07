/**
 * Onboarding v2 (coordinator ruling 2026-10-06): the "prefer not to say" answer to the sex
 * question. 20261224090000 widens `user_settings.sex`'s check constraint to accept
 * 'unspecified' alongside 'female'/'male'; 20261224090100 validates it. Text-only, same pattern
 * as tests/migrations/user-dietary-profiles.test.ts: no server-side function changed, so there is
 * nothing a live-branch run would prove beyond what the text checks below already pin.
 *
 * The down files are the inverse of each other's forward step by NAME, but (Sol r2 WARN) the
 * two lock-sensitive ROLLBACK steps are deliberately split across them in the order down files
 * actually run (reverse chronological: 090100's down runs BEFORE 090000's): 090100's down does
 * the exists-check and the NOT VALID add (quick ACCESS EXCLUSIVE); 090000's down does the
 * VALIDATE scan (SHARE UPDATE EXCLUSIVE) in a separate transaction. Putting both steps in one
 * down file would hold ACCESS EXCLUSIVE for the whole transaction, including the validate scan —
 * exactly the long block the two-step split exists to avoid.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const UP = readFileSync(
  "supabase/migrations/20261224090000_user_settings_sex_unspecified.sql", "utf8",
);
const VALIDATE = readFileSync(
  "supabase/migrations/20261224090100_user_settings_sex_unspecified_validate.sql", "utf8",
);
const DOWN = readFileSync(
  "supabase/migrations/down/20261224090000_user_settings_sex_unspecified.down.sql", "utf8",
);
const DOWN_VALIDATE = readFileSync(
  "supabase/migrations/down/20261224090100_user_settings_sex_unspecified_validate.down.sql",
  "utf8",
);

describe("20261224090000_user_settings_sex_unspecified.sql", () => {
  it("drops and re-adds the sex check to accept 'unspecified', added NOT VALID", () => {
    expect(UP).toContain("drop constraint if exists user_settings_sex_check");
    expect(UP).toMatch(
      /add constraint user_settings_sex_check\s*\n\s*check \(sex in \('female', 'male', 'unspecified'\)\) not valid/,
    );
  });

  it("validates the constraint in a separate step", () => {
    expect(VALIDATE).toContain("validate constraint user_settings_sex_check");
  });
});

describe("rollback (down files), split across two transactions in run order", () => {
  it("090100's down (runs FIRST) refuses while any 'unspecified' row exists, then re-adds the " +
    "old two-value check NOT VALID — no validate here", () => {
    expect(DOWN_VALIDATE).toContain("sex = 'unspecified'");
    expect(DOWN_VALIDATE).toContain("raise exception");
    expect(DOWN_VALIDATE).toMatch(/check \(sex in \('female', 'male'\)\) not valid/);
    expect(DOWN_VALIDATE).not.toMatch(/\bvalidate constraint\b/);
  });

  it("090000's down (runs SECOND) only validates — no drop/add, so no second ACCESS EXCLUSIVE", () => {
    expect(DOWN).toContain("validate constraint user_settings_sex_check");
    expect(DOWN).not.toContain("drop constraint");
    expect(DOWN).not.toContain("add constraint");
  });
});
