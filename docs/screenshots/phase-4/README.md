# Phase 4 capture — phone screenshots

Six shots, taken on Devin's phone against the preview deploy, one method per deploy
(`00-contracts.md` §9 step 4). Drop the PNGs in this folder with these names; they are the evidence
for spec §10 AC1, AC11 and AC12 and for the README's ASSUMED decision 4.

| File | What it must show |
|---|---|
| `01-actions.png` | The `+` menu with exactly the enabled capture actions above the water row, every row ≥ 44 px. |
| `02-text-draft.png` | A three-item draft from typed text, with the spend note "n of 30 today" under the title. |
| `03-voice-recording.png` | The countdown ring mid-clip, with the seconds remaining in the centre. |
| `04-label-confirm.png` | A label draft with the label-food card and "Save as my food" visible. |
| `05-photo-focus.png` | A plate draft opening with the first grams stepper focused and Save enabled. |
| `06-offline.png` | Airplane mode: the four actions disabled and the sheet's "Capture needs a connection" line with the search button. |

A blocked item (AC9) has no screenshot of its own: it appears in `04-label-confirm.png` as a red
dot pill with Save greyed out, taken with an apple-containing pouch.

## Manual gate (phone, one sitting)

Run on the preview, with `CAPTURE_METHODS` and `NEXT_PUBLIC_CAPTURE_METHODS` set to the same list
(contracts §6, §9 step 4):

1. Type a three-item meal, check the items, Save. The entry appears under "Also today" with the
   type glyph.
2. Hold the mic button, say the same meal, release, replay, Use this clip, Save.
3. Photograph a pouch label, confirm the ingredients line, leave "Save as my food" on, Save.
4. Photograph a plate; confirm the first grams stepper has focus and that saving without
   touching it stores `was_edited = false`.
5. Airplane mode: confirm the four actions are disabled with "needs a connection" and that the
   sheet's search button still logs a food.
6. An apple-containing pouch: confirm the red pill and that Save stays disabled until the item
   is removed.

Record the result in the PR body: one line per step, pass or fail, plus the six file names.

**Not run on this branch.** Steps 2, 3, 4 and 6 need Lane M's routes on a preview deploy, and the
routes are not on this checkout, so the whole gate runs at integration (contracts §9 step 4). Until
it is run and recorded, spec AC1, AC3, AC5 and AC8 are undemonstrated: nothing in this folder or in
the branch shots below is evidence for them. Steps 1 and 5 run on the branch preview with the
actions rendered and no method enabled.

## Branch harness shots (2026-09-11)

Nine more shots came from this branch itself, ahead of the phone gate above, per the controller's
ruling that every sheet mode needs a screenshot on the branch:

- `b-01-text-entry.png` — `initialMode="text"`, empty box
- `b-02-text-draft.png` — the confirm view after "Check it" on a typed meal (3 items, spend note
  "4 of 30 today")
- `b-03-voice-idle.png` — `initialMode="voice"`, hold-to-record button
- `b-03-voice-recording.png` — countdown ring mid-clip with seconds in the centre
- `b-04-label-capture.png` — `initialMode="label"`, "Scan the label" button
- `b-04-label-confirm.png` — label draft: label-food card, "Saving as my food", one blocked item
  (red dot pill) with Save disabled
- `b-05-photo-capture.png` — `initialMode="photo"`, "Photograph the plate" button
- `b-05-photo-focus.png` — plate draft, first grams stepper focused, one low-confidence "check
  this" line with alternatives
- `b-06-offline.png` — "Capture needs a connection. Search still works." with the Search your
  foods button

These came from a temporary `/auth/capture-preview` page with Lane M's routes faked in
`window.fetch`, deleted before this commit.
