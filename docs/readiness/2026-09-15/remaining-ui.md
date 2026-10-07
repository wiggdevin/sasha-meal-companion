# Remaining food-flow UI checks — 2026-09-15

Environment: local app `http://localhost:3101`, synthetic account, EGO task space 6 / page p3. Shared authenticated browser state; no production account writes or AI/provider requests. p1/p2 untouched. Source is the coordinating agent's local verification build; this does not prove production UI behavior.

| Flow | Observed result | Limits |
|---|---|---|
| Add preset | Added Salmon, cooked from Foods → Add a food. It appeared in My Foods and remained after reload. | Other presets not sampled. |
| Manual simple sugar | Typed Honey in Something else. UI displayed “Simple sugars are off the plan — coach's call.” and Add to my foods was disabled. | Existing honey migration and exact name sugar not exercised. |
| Off-plan logging | Pot pie, chicken showed “Off-plan: gluten. Logging it is still the right call.” Portion could be added and the resulting meal saved. After reload the entry displayed off-plan. | Gluten exercised, not the dairy-specific acceptance example. |
| Multi-food log | Saved QA p3 chicken rice with Pot pie, chicken (210 g) and Rice cake (3 g). Meal editor showed both foods; one 213 g entry survived reload, showing 547.26 kcal, 19.62 P, 52.73 C, 28.56 F and off-plan. | Two foods tested, not the three-food acceptance example; no independent DB read. |
| Recipe off-plan rejection | Not exercised within the bounded pass. | Remains unverified interactively. |

Synthetic changes retained: Salmon preset on Eats; meal QA p3 chicken rice on September 15. No cleanup or deletion of other synthetic records. p3 remains open; task space was not finished.
