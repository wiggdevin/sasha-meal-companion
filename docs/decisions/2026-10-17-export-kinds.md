# Export kinds exposed in Settings (2026-10-17)

`/api/export` serves eight kinds: meals, progress, recipes, favorites, water, body-profile,
body-data and the paged legacy map. `ExportCard` offers two, meals and daily progress, and its copy
names exactly those ("Your logged meals and your daily totals").

Decision: keep two for the in-house prototype. The other kinds stay API-only. Coach transcripts and
a profile export are not exposed: transcripts carry health text and have no reader yet. Revisit
before anyone outside in-house testing uses the app.
