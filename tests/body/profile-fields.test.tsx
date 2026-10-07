/**
 * T11b: the typed client for the four `user_settings` columns and the shape of the form that writes
 * them. Interaction is a manual phone gate (React Testing Library is not installed), so the state
 * transitions are the plain functions of `lib/body-profile-fields.ts` and the error state is a
 * static render of the view.
 *
 * Sol audit findings 2 and 7: what is typed stays typed until a commit, and a rejected save shows
 * the retry — the state helper test walks the sequence "1", "16", "165" that per-keystroke clamping
 * used to break.
 *
 * Third round, finding 4: a blur now tells THREE outcomes apart — a value, an intentional clear and
 * text that is not a number — and the last one keeps the draft, shows an inline error and enqueues
 * nothing; a birth year must be a whole number.
 *
 * Fifth round, finding 1: the retry re-commits through the same path, so a save that lands leaves
 * the box released and a later refresh reaches it (below).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { profileFromRow, profileToColumns } from "@/lib/body-profile-client";
import BodyProfileFields, { BodyProfileFieldsView } from "@/components/BodyProfileFields";
import {
  blurAction, blurOnEnter, commitPlan, draftsFromProfile, draftWith, EMPTY_DRAFTS,
  INVALID_NUMBER, INVALID_YEAR, NUMBER_FIELDS, numberDraft, refreshDrafts, SAVE_ERROR, sexOrNull,
  sexChange, type Drafts,
} from "@/lib/body-profile-fields";

describe("the typed body-profile client", () => {
  it("reads the four valid numeric columns without coercion", () => {
    expect(profileFromRow({ height_cm: 165, birth_year: 1996, sex: "female",
      body_fat_pct: 25 })).toEqual({ heightCm: 165, birthYear: 1996, sex: "female",
      bodyFatPct: 25 });
  });

  it("treats missing or nullable columns as absent and rejects malformed stored values", () => {
    const empty = { heightCm: null, birthYear: null, sex: null, bodyFatPct: null };
    expect(profileFromRow(undefined)).toEqual(empty);
    expect(profileFromRow({ height_cm: null, birth_year: null, sex: null,
      body_fat_pct: null })).toEqual(empty);
    expect(() => profileFromRow({ height_cm: "", birth_year: null, sex: "other",
      body_fat_pct: "x" })).toThrow();
  });

  it("writes the four columns in schema order, and nulls clear", () => {
    expect(profileToColumns({ heightCm: 165, birthYear: 1996, sex: "female", bodyFatPct: 25 }))
      .toEqual({ height_cm: 165, birth_year: 1996, sex: "female", body_fat_pct: 25 });
    expect(Object.keys(profileToColumns({ heightCm: null, birthYear: null, sex: null,
      bodyFatPct: null }))).toEqual(["height_cm", "birth_year", "sex", "body_fat_pct"]);
  });
});

describe("what a blur means (finding 4)", () => {
  const HEIGHT = NUMBER_FIELDS[0];
  const YEAR = NUMBER_FIELDS[1];
  const BODY_FAT = NUMBER_FIELDS[2];
  it("tells an intentional clear from text that is not a number", () => {
    expect(numberDraft(HEIGHT, "")).toEqual({ kind: "clear" });
    expect(numberDraft(HEIGHT, "   ")).toEqual({ kind: "clear" });
    expect(numberDraft(HEIGHT, "abc")).toEqual({ kind: "invalid", message: INVALID_NUMBER });
  });
  it("requires a whole birth year, while height and body fat may be fractional", () => {
    expect(numberDraft(YEAR, "1996")).toEqual({ kind: "value", value: 1996 });
    expect(numberDraft(YEAR, "1996.5")).toEqual({ kind: "invalid", message: INVALID_YEAR });
    expect(numberDraft(YEAR, "abc")).toEqual({ kind: "invalid", message: INVALID_NUMBER });
    expect(numberDraft(BODY_FAT, "25.5")).toEqual({ kind: "value", value: 25.5 });
  });
  it("rejects a number outside the field range instead of silently clamping it", () => {
    expect(numberDraft(HEIGHT, "165")).toEqual({ kind: "value", value: 165 });
    expect(numberDraft(HEIGHT, "1")).toMatchObject({ kind: "invalid" });
    expect(numberDraft(HEIGHT, "999")).toMatchObject({ kind: "invalid" });
    expect(numberDraft(BODY_FAT, "1")).toMatchObject({ kind: "invalid" });
    expect(commitPlan(HEIGHT, "999", 165)).toMatchObject({ kind: "keep" });
    expect(commitPlan(HEIGHT, "999", 165)).not.toHaveProperty("patch"); // nothing to enqueue
  });
  it("uses the current calendar year as the birth-year ceiling", () => {
    const currentYear = new Date().getFullYear();
    expect(YEAR.max).toBe(currentYear);
    expect(numberDraft(YEAR, String(currentYear))).toEqual({ kind: "value", value: currentYear });
    expect(numberDraft(YEAR, String(currentYear + 1))).toMatchObject({ kind: "invalid" });
    expect(commitPlan(YEAR, String(currentYear + 1), null)).not.toHaveProperty("patch");
  });

  it("never enqueues anything for an invalid draft — there is no patch to queue", () => {
    const plan = commitPlan(YEAR, "1996.5", 1996);
    expect(plan).toEqual({ kind: "keep", error: INVALID_YEAR });
    expect(plan).not.toHaveProperty("patch");
    expect(commitPlan(HEIGHT, "abc", 165)).toEqual({ kind: "keep", error: INVALID_NUMBER });
    expect(commitPlan(HEIGHT, "Infinity", 165)).toEqual({ kind: "keep", error: INVALID_NUMBER });
  });

  it("saves a value, clears an empty box, and skips a blur that changed nothing", () => {
    expect(commitPlan(HEIGHT, "165", null)).toEqual({ kind: "save", patch: { height_cm: 165 } });
    expect(commitPlan(HEIGHT, "", 165)).toEqual({ kind: "save", patch: { height_cm: null } });
    expect(commitPlan(HEIGHT, "", null)).toEqual({ kind: "unchanged" });
    expect(commitPlan(HEIGHT, "165", 165)).toEqual({ kind: "unchanged" });
  });

  it("turns a blur into the one move the field's coordinator makes", () => {
    expect(blurAction(YEAR, "1996.5", 1996)).toEqual({ kind: "keep", error: INVALID_YEAR });
    expect(blurAction(HEIGHT, "165", null)).toEqual({ kind: "write", patch: { height_cm: 165 } });
    expect(blurAction(HEIGHT, "", 165)).toEqual({ kind: "write", patch: { height_cm: null } });
    expect(blurAction(HEIGHT, "165", 165)).toEqual({ kind: "write", patch: null });
  });
});

describe("the draft while typing", () => {
  const HEIGHT = NUMBER_FIELDS[0];
  /** One keystroke, as the input's onChange would deliver it. */
  const type = (drafts: Drafts, raw: string) => draftWith(drafts, HEIGHT.key, raw);

  it("keeps the raw text of every keystroke, so 165 can be typed at all", () => {
    const one = type(EMPTY_DRAFTS, "1");
    expect(one.heightCm).toBe("1");                      // not clamped to "50"
    const sixteen = type(one, "16");
    expect(sixteen.heightCm).toBe("16");                 // not clamped to "50"
    const full = type(sixteen, "165");
    expect(full.heightCm).toBe("165");                   // not clamped to "260"
    // …and only the blur commit turns it into the column value.
    expect(commitPlan(HEIGHT, full.heightCm, null)).toEqual({ kind: "save",
      patch: { height_cm: 165 } });
  });

  it("validates only on the commit without rewriting the raw draft", () => {
    const tooTall = draftWith(EMPTY_DRAFTS, "heightCm", "999"); // exact text survives typing
    expect(tooTall.heightCm).toBe("999");
    expect(numberDraft(HEIGHT, tooTall.heightCm)).toMatchObject({ kind: "invalid" });
    expect(numberDraft(NUMBER_FIELDS[2], "25")).toEqual({ kind: "value", value: 25 });
  });

  it("commits Enter through the same blur path and ignores other keys", () => {
    const blur = vi.fn();
    blurOnEnter("Escape", blur);
    expect(blur).not.toHaveBeenCalled();
    blurOnEnter("Enter", blur);
    expect(blur).toHaveBeenCalledOnce();
  });

  it("echoes a stored profile back into the boxes, and clears a null one", () => {
    expect(draftsFromProfile({ heightCm: 165, birthYear: 1996, sex: "female", bodyFatPct: 25 }))
      .toEqual({ heightCm: "165", birthYear: "1996", bodyFatPct: "25", sex: "female" });
    expect(draftsFromProfile(null)).toEqual(EMPTY_DRAFTS);
    expect(draftsFromProfile({ heightCm: 165, birthYear: null, sex: null, bodyFatPct: 25 }))
      .toEqual({ heightCm: "165", birthYear: "", bodyFatPct: "25", sex: "" });
  });

  it("only accepts the two sexes the column's check allows", () => {
    expect(sexOrNull("female")).toBe("female");
    expect(sexOrNull("male")).toBe("male");
    expect(sexOrNull("")).toBeNull();
    expect(sexOrNull("other")).toBeUndefined();
  });

  it("keeps a new formula-sex selection as the recoverable controlled draft", () => {
    const selected = sexChange(EMPTY_DRAFTS, "female", null);
    expect(selected).toEqual({
      drafts: { ...EMPTY_DRAFTS, sex: "female" },
      patch: { sex: "female" },
    });
  });

  it("updates the controlled sex draft when a selection returns to the stored value", () => {
    expect(sexChange({ ...EMPTY_DRAFTS, sex: "male" }, "female", "female")).toEqual({
      drafts: { ...EMPTY_DRAFTS, sex: "female" },
      patch: null,
    });
  });

  // Fourth round, finding 4: a save's own signal and a sync pull both reload the profile. Replacing
  // every box on that reload used to wipe the text in a box she was still typing in — the refresh
  // of A took B's half-typed draft with it.
  it("refreshes only the boxes she is not holding", () => {
    const typed: Drafts = { heightCm: "165", birthYear: "16", bodyFatPct: "", sex: "" };

    // Field B (birth year) is being typed into; field A (height) is clean. The row moved to 170,
    // so A follows it and B keeps the "16" she has not committed.
    const refreshed = refreshDrafts(typed,
      draftsFromProfile({ heightCm: 170, birthYear: 1996, sex: "female", bodyFatPct: 25 }),
      new Set(["birthYear"]));
    expect(refreshed).toEqual({ heightCm: "170", birthYear: "16", bodyFatPct: "25",
      sex: "female" });

    // Nothing held: the whole form follows the row.
    expect(refreshDrafts(typed,
      draftsFromProfile({ heightCm: 170, birthYear: 1996, sex: "female", bodyFatPct: 25 }),
      new Set())).toEqual({ heightCm: "170", birthYear: "1996", bodyFatPct: "25",
      sex: "female" });

    // A focused box and a picker she just moved are hers too, and her text is never the row's.
    expect(refreshDrafts(typed, draftsFromProfile(null), new Set(["heightCm", "sex"])))
      .toEqual({ heightCm: "165", birthYear: "", bodyFatPct: "", sex: "" });
  });
});

describe("BodyProfileFieldsView", () => {
  const props = { drafts: EMPTY_DRAFTS, error: null, onEdit: () => {}, onCommit: () => {},
    onSex: () => {}, onRetry: () => {} };
  const markup = renderToStaticMarkup(<BodyProfileFieldsView {...props} drafts={{
    heightCm: "165", birthYear: "1996", bodyFatPct: "25", sex: "female" }} />);

  it("renders all four fields with accessible names", () => {
    for (const label of ['aria-label="Height"', 'aria-label="Birth year"',
      'aria-label="Body fat"', 'aria-label="Sex used in formula"']) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Female");
    expect(markup).toMatch(/role="combobox" aria-label="Sex used in formula"[^>]*>\s*<span[^>]*>Female<\/span>/);
    expect(markup).toContain('aria-label="Feet"');
    expect(markup).toContain('aria-label="Inches"');
    expect(markup.match(/value="5"/g) ?? []).toHaveLength(2);
  });

  it("says out loud that these never change a target", () => {
    expect(markup).toContain("Targets change only through the weekly proposal.");
    expect(markup).toContain("not medical advice");
    expect(markup).toContain("your clinician");
    expect(markup).toContain("physiological formula input, not your gender identity");
    expect(markup).not.toContain("Try again");
  });

  it("uses text-backed numeric controls so the exact invalid draft remains visible", () => {
    expect(markup.match(/type="text"/g) ?? []).toHaveLength(4);
    for (const mode of ['inputMode="decimal"', 'inputMode="numeric"']) expect(markup).toContain(mode);
  });

  it("renders every numeric control in a visible well with muted placeholder copy", () => {
    for (const label of ["Feet", "Inches", "Birth year", "Body fat"]) {
      const input = markup.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
      expect(input).toContain("well");
      expect(input).toContain("placeholder:text-muted");
      expect(input).toMatch(/placeholder="[^"]+"/);
    }
  });
  it("shows the inline error with a 44 px retry when a save was rejected", () => {
    const failed = renderToStaticMarkup(<BodyProfileFieldsView {...props}
      error={SAVE_ERROR} />);
    // SSR escapes the apostrophe, so compare against the escaped copy the phone will see.
    expect(failed).toContain(SAVE_ERROR.replace("'", "&#x27;"));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Try again");
    expect(failed).toContain("min-h-11");
  });

  // Finding 4: the invalid draft stays in the box, tells her why, and goes nowhere near the outbox.
  it("keeps an invalid draft in the box with the inline message under that row", () => {
    const markup = renderToStaticMarkup(<BodyProfileFieldsView {...props} drafts={{
      heightCm: "165", birthYear: "1e", bodyFatPct: "25", sex: "female" }}
      draftErrors={{ birthYear: INVALID_NUMBER }} />);
    expect(markup).toContain('value="1e"');
    expect(markup).toContain(INVALID_NUMBER);
    expect(markup).toContain('role="alert"');
    expect(markup).toMatch(/aria-label="Birth year"[^>]*aria-invalid="true"[^>]*aria-describedby="body-profile-birthYear-error"/);
    expect(markup).toContain('id="body-profile-birthYear-error"');
    expect(markup.match(/role="alert"/g) ?? []).toHaveLength(1);
    expect(markup).not.toContain("Try again");
  });
});

describe("BodyProfileFields", () => {
  it("mounts the four fields and the no-target line", () => {
    const markup = renderToStaticMarkup(<BodyProfileFields />);
    expect(markup).toContain('aria-label="Height"');
    expect(markup).toContain("Targets change only through the weekly proposal.");
  });
});
