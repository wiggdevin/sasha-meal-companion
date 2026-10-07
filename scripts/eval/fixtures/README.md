# Phase 4 eval fixtures

Thirty files, named exactly as `scripts/eval/phase-4-capture.jsonl` names them. They are **not**
committed: they are Sasha's own photos and recordings, and this repository is not where her plate
photos live. Drop them here before a run; `.gitignore` keeps everything in this folder except this
README out of git.

Ten voice clips (`voice-01…10`, `.m4a`, under 30 s, recorded on the phone through the capture sheet
so the container is the real one iOS produces):
`voice-01-eggs-avocado`, `voice-02-chicken-squash`, `voice-03-steak-potato`, `voice-04-tuna`,
`voice-05-rice-cakes`, `voice-06-salmon`, `voice-07-banana-mct`, `voice-08-cod-sweet-potato`,
`voice-09-pouch`, `voice-10-pork-cassava`.

Ten label photos (`label-01…10`, `.jpg`, the nutrition panel and the ingredient list both legible):
`label-01-fruit-pouch`, `label-02-rice-cake`, `label-03-sunflower-butter`, `label-04-canned-salmon`,
`label-05-sardines`, `label-06-avocado-mayo`, `label-07-olives`, `label-08-mct-oil`,
`label-09-hot-chocolate`, `label-10-apple-pouch` (this last one must contain apple — it is the
`blocked` case, spec AC9).

Ten plate photos (`plate-01…10`, `.jpg`, one plate per photo, taken from above):
`plate-01-eggs-avocado`, `plate-02-chicken-rice`, `plate-03-steak-potato`, `plate-04-salmon-squash`,
`plate-05-cod-sweet-potato`, `plate-06-tuna-salad`, `plate-07-rice-cakes`, `plate-08-pork-cassava`,
`plate-09-lamb-melon`, `plate-10-banana-pouch`.

After dropping a file, fill in that line's `expect` array in the jsonl with what the food actually
was and roughly what it weighed. A line with an empty `expect` is run and printed but scored
nowhere, because scoring against an expectation nobody wrote reports our own guess back to us.
