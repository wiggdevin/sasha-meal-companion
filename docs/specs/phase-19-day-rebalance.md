# Phase 19: Rebalance my day

Date: 2026-10-05. Revision 10. Owner: Devin.
Status: spec only. Nothing here is built. Base: `main` at 1ffe893 (PR #422). Every file:line
citation was checked against that commit.

**Revision 10** applies the round-8 review (FAIL, one BLOCK and one WARN): `projectPanelSlots` takes the date's `StoredDay` and derives `eatenEnergyBasis` from stored state, never from a meal's display name.

**Revision 9** applies the round-7 review (FAIL, three BLOCKs and one WARN). A slot with food
logged under it is never missed, and it stays a remaining card while its planned meal is uneaten
(§5.2). The "Clearing a meal…" explainer leaves v1 (§6.1). `ResolvedSlot` and `resolveDay` do not
change: the two projection fields move to a pure lib type, `PanelSlot`, built by
`projectPanelSlots` (§4), so R1 touches `lib/` only. Every listed card kind is tested for exactly
one link (§7).

**Revision 8** applied option A of the round-6 re-plan (owner's delegate, 2026-10-05): v1 is an
honest, read-only state panel. Each listed meal has one "View meal" link to its Today card; the
panel lists no actions and claims no action or missed-label parity with `SlotCard`. Intake counts
only recorded energy (`recordedKcal`): a frozen estimate and the legacy `macros.kcal` fallback in
`day.consumed.kcal` are not evidence of known intake. Two pure projection fields, `cleared` and
`eatenEnergyBasis`, let the panel tell an explicit Clear from an empty slot and an estimate from a
record (revision 9 moved them off `ResolvedSlot`). §14 records the five round-6 findings as resolved.

**Revision 7** made one missed rule (`isMissedSlot`, §5.2) shared by the panel and Today's card.
Revision 8 keeps the rule for the panel only; the card's unused `isMissed` prop is removed (§6.1).

**Revision 6** applied the round-5 review (FAIL, three BLOCKs and one WARN): energy is known only
by the one energy rule's item function; a partly measured day joins the same lower-bound state,
renamed `incomplete_intake`; the panel's actions cover every action Today's card offers (withdrawn
in revision 8); and the flag has no development fallback.

**Revision 5** applied the round-4 review (FAIL) and the owner's delegated decisions: the R0 drift
study leaves v1 for Phase 19b (D10); the panel carries energy coverage and has an
`unknown_intake` state (renamed `incomplete_intake` in revision 6); the classifier checks the
date first, using `targetDayFor`.

**Revision 4 rescoped v1** (decision D9). Three GPT-6 Sol review rounds of the full planner
(revisions 1 to 3, 3cc0d87, 93a33f9, 73512f4) each returned FAIL. The owner delegated the call, and
option A of Sol's re-plan was taken: v1 is a **read-only panel** that shows today's numbers and the
missed and remaining meals, and links each meal to the actions Today already has. Everything that
writes a plan (resizing, batch apply, marks, the coach action) moves to **Phase 19b** (§10), each
item with the design fix the reviews require. §14 says how every review finding is resolved by the
cut or assigned to 19b.

**Source of intent.** The owner's request, captured in
`docs/plans/2026-10-05-day-rebalance-and-live-widget.md` (cited below as "the plan").

**Honesty labels.** Every research claim carries **[PUBLISHED]** (stated in the cited source) or
**[ESTIMATE]** (our inference or a starting value). Every threshold in §5 is a proposed starting
value, not a measurement. No query in §3 has been run. No latency has been measured.

**This spec is the backend lane's contract.** The UI lane owns the live widget shell on the
Calendar face of the Day card (the plan:73-77). This spec defines the "Rebalance my day" panel's
data, states, copy and its links to Today's cards. It does not design the shell. v1 is a state
panel: it says where the day stands and links each missed or remaining meal to its Today card,
where the existing actions are.

---

## 1. What the owner asked for, and what v1 delivers

| The plan asks for | v1 | Later |
|---|---|---|
| A button on Today that recalculates the rest of the day from the calories left (the plan:9-10) | The panel shows the target, the energy recorded so far, what is left when intake is fully known, and the meals still ahead. Recalculation of generated meals already happens on every change (§2). | Option sheet with computed plans (19b) |
| When over, shrink the remaining meals or remove one (the plan:11-12) | Each remaining meal has a "View meal" link to its Today card, where Clear, Delete, Edit and Swap already are | Trim and ranked skip options (19b) |
| At the bottom of the Calendar face, in a live widget whose default panel is rebalance (the plan:13-23) | The panel's data contract; the UI lane builds the shell | |
| Remove missed cards, then enlarge the rest or move the shake later (the plan:26-28) | Missed meals are highlighted and each links to its Today card | Multi-slot clear or move, enlarge, actions inside the panel (19b) |
| Lean on calorie-dense allowed foods in a short window (the plan:28-29) | Not in v1 | Add a side or dense food (19b) |
| Understand why days drift first (the plan:30-31, 69-71) | The published research in §3.1; v1 starts from the thresholds it supports | R0 drift study on the app's data (19b, §3.2) |
| A decision tree that learns later (the plan:32-33) | A pure classifier that picks the panel's state, copy and highlights | Learned ordering (19b) |

## 2. Today's model, verified in code

| Fact | Where |
|---|---|
| `resolveDay(store, date, waterCups, eligibleFoodIds)` is pure and returns every slot with its time, meal, macros and eaten state, plus `targets` and `consumed`. | `lib/resolve.ts:227-336` |
| The device-local day is `targetDayFor(now)`, the one phone rule for a target revision's day: never the UTC date. Today's own `toIsoDate` gives the same local date. | `lib/targets/revision.ts:320-329`; `app/page.tsx:94-96`, `:431-433` |
| The target for a date is the revision in force on that date (`effective_from <= date`, highest `rev`), read through `targetRevisionOn`; its training weekdays set the day type. | `lib/plan/slot-share.ts:49-67`; `lib/targets.ts:24-53`; `AGENTS.md` "Source of truth for numbers" |
| **`day.consumed.kcal` is Today's display total, not evidence of known intake.** It sums every eaten slot's `macros` and every entry's `entryMacros`, rounded once. An eaten slot shown as a frozen estimate adds its estimate. `entryMacros` adds an item's legacy `macros.kcal` when its snapshot is empty, and the entry's own `macros` when no item is measured (absent or all-empty `items`). Only a snapshot item with no usable energy adds nothing. | `lib/resolve.ts:270-273`, `:294`, `:315-322`; `lib/plan/entry-macros.ts:17-50` |
| A logged item's kcal follows the one energy rule: reported, else calculated, else unknown (`itemKcal` returns null). | `lib/nutrients/energy.ts:28-40` |
| **A timestamp-only eaten mark** (an eaten slot with no recipe snapshot and no saved food) is frozen. With a log filed under the slot, the log is the record and the slot counts 0 ("Eaten meal (counted in your log)"). Without one, it counts its frozen share of the target as an estimate ("Eaten meal (estimate)"), or nothing when there is no target ("Eaten meal (nutrition unknown)"). The Plan panel's logged shell also makes the log the record. | `lib/plan/eaten-estimate.ts:1-15`, `:22-28`, `:42-61`, `:73-94`; `lib/plan/slot-share.ts:107-118`, `:168-175` |
| **An explicit Clear** is stored as `SlotOverride.cleared` (`clearMeal`). `resolveDay` maps it to `meal: null`, the same value an unplanned empty slot has, and `ResolvedSlot` carries no cleared state. A deleted (`removed`), uneaten slot is not in `slots` at all. | `lib/types.ts:257-258`, `:336-354`; `lib/today/meal-actions.ts:22-27`; `lib/resolve.ts:258`; `lib/plan/slot-share.ts:69-80` |
| An eaten slot whose only record is a time-edit snapshot resolves to `meal: null` and `eaten: false` once a log is filed under it: the snapshot is suppressed and nothing else is shown. | `lib/resolve.ts:252-266`, `:273`; `lib/plan/eaten-estimate.ts:63-71` |
| **The ordinary Log Food sheet files food under the current slot without marking the meal eaten.** Its slot is the current slot; its completion only upserts the log entry. So a planned, uneaten meal can have food logged under it and still need attention. | `app/page.tsx:1056-1061`, `:527-532`; `components/LogFoodSheet.tsx:287` |
| A day with a partly measured recipe serving is shown as "at least". | `lib/resolve.ts:116-123` |
| Today renders from the accepted-recipe projection, not the raw store. | `app/page.tsx:436-441`; `lib/recipes/accepted-overlay.ts:31-32` |
| **Skipping a meal already rebalances the generated meals.** A cleared slot is fixed at zero, and the open (app-generated) slots share what is left of the day evenly, so each grows. Eating more shrinks them. Meals the user saved keep their own size. | `lib/plan/slot-share.ts:1-11`, `:144-148`, `:177-200`, `:212-220` |
| Today's existing per-meal actions: Clear and Delete with an Undo notice (`changeMeal`), Edit through `saveSlotEdit` and `saveMealEdit`, the time through `saveSlotTime`, and Swap through `MealSwapSheet`. | `app/page.tsx:593-629`, `:794`; `lib/today/meal-actions.ts:22-33` |
| A cleared meal is brought back by the clear notice's Undo, or by the coach's `restore_slot`. | `app/page.tsx:628`, `:631-646`; `lib/coach/actions/skip-slot.ts:66-77` |
| **`SlotCard`'s controls depend on more than the slot.** An empty standard card shows only "Plan"; an empty focus card shows "Plan with the coach" and "Log what you ate"; an attached flow hides both. The `isMissed` prop is declared but never read, and Today's card shows no missed label (a test asserts a missed card does not say "Not logged"). | `components/SlotCard.tsx:96-127`, `:258-297`; `app/page.tsx:986-990`, `:1006`; `tests/cards/today.test.tsx:217-221` |
| The recipe pilot's per-user gate is an env allowlist. | `lib/server/recipe-access.ts:7-17` |

So v1 needs no new writer. The day already re-shares itself when the user acts. What is missing is
a place that says where the day stands, which meals went by, and where to act on each. The panel
must tell recorded energy from an estimate, and an explicit Clear from an empty slot; today's
`ResolvedDay` cannot, so R1 adds a pure projection beside it (§4, §5.2).

## 3. Research

### 3.1 Why a day drifts: published evidence

| # | Finding | Label | Source |
|---|---|---|---|
| R1 | In U.S. adults, 24 % skipped breakfast, 19 % lunch and 7 % dinner (two-day average, NHANES 2007-2016, n = 23,488). | [PUBLISHED] | Zeballos E, Todd JE. Public Health Nutr. 2020;23(18):3346-3355. doi:10.1017/S1368980020000683 |
| R2 | Skipping a meal lowers the day's energy: breakfast by about 1,053 kJ net, lunch by about 1,226 kJ, after only partial compensation at the next meal (+193 kJ, +369 kJ). | [PUBLISHED] | Zeballos and Todd 2020, as R1 |
| R3 | Skipping breakfast raised lunch intake by about 144 kcal, for a net deficit of about 408 kcal. Compensation is partial. | [PUBLISHED] | Levitsky DA, Pacanowski CR. Physiol Behav. 2013;119:9-16. PMID 23672851 |
| R4 | In a randomized trial, lunch rose after a skipped breakfast but did not make up for it. | [PUBLISHED] | Chowdhury EA et al. (Bath Breakfast Project). Am J Clin Nutr. 2016;103(3):747-756 |
| R5 | Days without breakfast differ from the same person's breakfast days in eating times, meal and snack pattern and macro intake. A missed meal changes the whole day, not one slot. | [PUBLISHED] | Kant AK, Graubard BI. Am J Clin Nutr. 2015;102(3):661-670. PMID 26178722 |
| R6 | Breakfast is the most often skipped meal in young adults; time scarcity raised the odds of skipping breakfast and lunch. | [PUBLISHED] | Pendergast FJ et al. Int J Behav Nutr Phys Act. 2016;13:125. doi:10.1186/s12966-016-0451-1; Pendergast FJ et al. 2019, PMC6448264 |
| R7 | In a smartphone logging study (n = 156), more than half of adults ate over 15 h or more a day, with under 25 % of calories before noon and over 35 % after 18:00. Timing is erratic, not three fixed meals. | [PUBLISHED] | Gill S, Panda S. Cell Metab. 2015;22(5):789-798. PMID 26411343 |
| R8 | U.S. adults get about 23 % of daily energy from snacks. | [PUBLISHED] | USDA ARS What We Eat in America snack brief (NBK603801); Piernas C, Popkin BM. J Nutr. 2010 |
| R9 | Adherence, not diet type, predicted weight loss in a four-diet trial. One-year dropout was 48-50 % on the most rigid diets and 35 % on the more flexible ones. | [PUBLISHED] | Dansinger ML et al. JAMA. 2005;293(1):43-53. PMID 15632335 |
| R10 | Within-diet adherence correlated with 12-month weight change (rs 0.34-0.42). | [PUBLISHED] | Alhassan S et al. Int J Obes. 2008;32:985-991. PMID 18268511 |
| R11 | Rigid all-or-nothing control is linked to more disinhibited eating; flexible control is linked to better regulation. | [PUBLISHED] | Westenhoefer J et al. Int J Eat Disord. 1999;26(1):53-64. PMID 10349584 |
| R12 | Adherence falls over time as hunger rises; tailored, flexible plans help. | [PUBLISHED] | Gibson AA, Sainsbury A. Behav Sci. 2017;7(3):44 |
| R13 | Self-reported intake runs about 12-14 % low in men and 16-20 % low in women on 24 h recalls. | [PUBLISHED] | Subar AF et al. (OPEN). Am J Epidemiol. 2003;158(1):1-13. PMID 12835280 |
| R14 | Food logging declines over months (4.0 to 2.2 entries a day over 18 months). | [PUBLISHED] | Burke LE et al. J Am Diet Assoc. 2011;111(1):92-102 |
| R15 | A label's calories may legally read up to 20 % low (actual up to 120 % of declared). | [PUBLISHED] | 21 CFR 101.9(g)(5) |
| R16 | Even protein across three meals gave more 24 h muscle protein synthesis than a skewed day at equal totals. | [PUBLISHED] | Mamerow MM et al. J Nutr. 2014;144(6):876-880. PMID 24477298 |
| R17 | High-energy-dense foods (the CDC brief's example: pretzels at 4.0 kcal/g) deliver a set of calories in a small amount of food. | [PUBLISHED] | CDC Research to Practice brief, "Low-Energy-Dense Foods and Weight Management" |

**What we take from it.**

- **Under-eating is mostly timing.** About a quarter of adults skip breakfast on a given day (R1),
  and people do not make it up later (R2-R4). So "under, after a missed meal" should be the most
  common drift. [ESTIMATE]
- **Over-eating is mostly unplanned snacks.** Snacks carry about a fifth of energy (R8) and late
  eating is common (R7). [ESTIMATE]
- **A logged "under" may be an under-log.** Self-report runs 12-20 % low (R13) and logging fades
  (R14). The panel must not push large late meals on a day that may simply be under-logged. This
  sets the tolerance band and the day-over state (§5). [ESTIMATE]
- **Offer choices; do not punish.** Flexible control and adherence beat rigid compensation (R9-R12).
  v1 shows the day and the user's own existing choices; it prescribes nothing, and nothing ever
  carries to tomorrow.
  [ESTIMATE]
- **Protein stays where it is.** Protein spread over meals has its own value (R16). v1 resizes
  nothing; Phase 19b's resizing keeps the AGENTS.md rule that no protein portion moves. [ESTIMATE]

### 3.2 Phase 19b: R0 drift study (draft queries; not in v1)

**Moved out of v1** (decision D10). The queries below are a draft for Phase 19b. The round-4 review
found five defects; each is a required fix before R0 runs (§10, "R0 drift study"). Until R0 runs,
v1 uses the 90-minute grace and the `max(100, 5 % of T)` tolerance as starting values.

The plan asks to show the owner the cause mix before the tree is fixed (the plan:69-71). These are
read-only, aggregate-only queries. They have not been run. They must not run against production
from this spec.

**How to run.** Restore to a branch with `scripts/restore-to-branch.sh`, run with the branch's
service role, and drop the branch after. Each query returns counts and rates only: no food names,
notes, titles, item rows or timestamps leave the query. Any cell with fewer than 5 account-days is
suppressed. Per-account rows go only to that account's owner, and only for accounts with recorded consent (decision D7).

**What the data cannot say.** The server does not store a generated plate's planned size; it
lives only in the phone's resolve. So "planned" per slot is approximated by the even share
(`target ÷ planned slots`), the same rule `frozenShare` uses (`lib/plan/slot-share.ts:107-118`). A
tick's `eaten_at` is the tap time, not the eating time. Undescribed eaten slots have no kcal and are
counted, never estimated.

**Common CTE: the target and day type in force.** The revision in force on a date is
`effective_from <= date`, highest `rev` (`AGENTS.md` "Source of truth for numbers"). Weekday
numbering matches `dayTypeFor` (`getDay()`, Sunday 0; `lib/plan.ts:27-38`).

```sql
-- params: :from, :to (dates)
with days as (
  select pd.user_id, pd.local_date, pd.item_overrides, pd.eaten_slots,
         pd.day_complete_at, pd.day_type_override
    from plan_days pd
   where pd.local_date between :from and :to
), rev as (
  select distinct on (d.user_id, d.local_date)
         d.user_id, d.local_date, tp.kcal_train, tp.kcal_rest, tp.input_training_weekdays
    from days d
    join target_profiles tp on tp.user_id = d.user_id and tp.effective_from <= d.local_date
   order by d.user_id, d.local_date, tp.rev desc
), target as (
  select d.*,
         -- mealCountFor (lib/plan.ts:52-57): the stored choice, else by the training kcal
         coalesce(s.meals_per_day, case when r.kcal_train <= 1800 then 3
                                        when r.kcal_train <= 2600 then 4 else 5 end) as meal_count,
         case
           when d.day_type_override is not null then (d.day_type_override <> 'rest')
           else extract(dow from d.local_date)::int = any(coalesce(r.input_training_weekdays, '{}'))
         end as training,
         r.kcal_train, r.kcal_rest
    from days d
    join rev r using (user_id, local_date)
    join user_settings s on s.user_id = d.user_id
)
select * from target;  -- the base every query below starts from
```

**Q1. Day drift: eaten against target, on fully logged days only.** A day counts only when the user
marked it fully logged (`day_complete_at`, TDEE step E6), so under-logging does not read as
under-eating.

```sql
, eaten_slots_kcal as (
  select t.user_id, t.local_date,
         coalesce(sum(case when m.value->>'eaten_at' is not null then (
           select sum((c->'macros'->>'kcal')::numeric)
             from jsonb_array_elements(coalesce(
               m.value->'consumed'->'components',
               t.item_overrides->m.key->'components', '[]'::jsonb)) c) end), 0) as slot_kcal,
         count(*) filter (where m.value->>'eaten_at' is not null
           and jsonb_array_length(coalesce(m.value->'consumed'->'components',
               t.item_overrides->m.key->'components', '[]'::jsonb)) = 0) as undescribed
    from target t
    cross join lateral jsonb_each(t.eaten_slots) m
   group by t.user_id, t.local_date
), day as (
  select t.user_id, t.local_date,
         case when t.training then t.kcal_train else t.kcal_rest end as target_kcal,
         coalesce(e.slot_kcal, 0) + coalesce(de.amount, 0) as eaten_kcal,
         coalesce(e.undescribed, 0) as undescribed
    from target t
    left join eaten_slots_kcal e using (user_id, local_date)
    left join daily_energy de using (user_id, local_date)
   where t.day_complete_at is not null
)
select case
         when undescribed > 0 then 'unknown'
         when eaten_kcal < target_kcal * 0.95 then 'under'
         when eaten_kcal > target_kcal * 1.05 then 'over'
         else 'on' end as drift,
       width_bucket((eaten_kcal - target_kcal) / nullif(target_kcal, 0), -0.5, 0.5, 10) as bucket,
       count(*) as days
  from day
 group by 1, 2
having count(*) >= 5
 order by 1, 2;
```

`daily_energy` is the one energy rule for logged items (`supabase/migrations/20261210090000_daily_energy.sql:12-36`).
Two approximations, both stated in the report: an eaten slot whose override is a `followPlan`
snapshot counts its snapshot, while the phone counts only the log once one is filed under the slot
(`lib/resolve.ts:249-254`); and the two-sided ±5 % band here is a fixed proxy for the §5.2
tolerance.

**Q2. Per-slot outcome: eaten, skipped, removed, logged under, or untouched.**

```sql
, slots as (
  select t.user_id, t.local_date, sid.slot,
         (t.eaten_slots->sid.slot->>'eaten_at') is not null as ticked,
         coalesce((t.item_overrides->sid.slot->>'cleared')::boolean, false) as skipped,
         coalesce((t.item_overrides->sid.slot->>'removed')::boolean, false) as removed,
         (t.item_overrides->sid.slot ? 'time') as moved,
         exists (select 1 from log_entries le
                  where le.user_id = t.user_id and le.local_date = t.local_date
                    and le.slot = sid.slot and le.deleted_at is null) as logged_under
    from target t
    cross join lateral unnest(array['meal-1','meal-2','meal-3','meal-4','meal-5','meal-6']) sid(slot)
   where substring(sid.slot from 6)::int <= t.meal_count
)
select slot,
       count(*) as slot_days,
       round(avg((ticked or logged_under)::int), 3) as eaten_rate,
       round(avg(skipped::int), 3) as skipped_rate,
       round(avg(removed::int), 3) as removed_rate,
       round(avg(moved::int), 3) as moved_rate,
       round(avg((not ticked and not logged_under and not skipped and not removed)::int), 3)
         as untouched_rate
  from slots
 group by slot
having count(*) >= 5
 order by slot;
```

An "untouched" slot on a past date is the closest the data gets to a silently missed meal.

**Q3. Eaten size against the even share, per slot.** Only slots whose eaten content is described.

```sql
, described as (
  select t.user_id, t.local_date, m.key as slot,
         (select sum((c->'macros'->>'kcal')::numeric)
            from jsonb_array_elements(coalesce(m.value->'consumed'->'components',
                 t.item_overrides->m.key->'components')) c) as kcal,
         (case when t.training then t.kcal_train else t.kcal_rest end)
           / t.meal_count as even_share
    from target t
    cross join lateral jsonb_each(t.eaten_slots) m
   where m.value->>'eaten_at' is not null and m.key like 'meal-%'
)
select slot,
       width_bucket(kcal / nullif(even_share, 0), 0, 2, 8) as ratio_bucket,
       count(*) as slot_days
  from described
 where kcal is not null
 group by 1, 2
having count(*) >= 5
 order by 1, 2;
```

**Q4. First-meal time against the planned first slot.** Earliest of a tick and a live log, in a
stored zone: the day's own log entries' `tz` first, then the account's `user_settings.time_zone`
(synced since `supabase/migrations/20261026090100_neutral_user_defaults.sql:58-67`). A day with no
stored zone is left out of the curve and counted as `no_zone`; it never falls back to UTC, which
would shift a tick-only day by hours. The planned time is `user_settings.slot_times->'meal-1'` plus `shift_minutes`;
an account on default times is reported as its own bucket, because the defaults live in code
(`lib/plan.ts`), not in the database.

```sql
, firsts as (
  select t.user_id, t.local_date,
         least(
           (select min((m.value->>'eaten_at')::timestamptz)
              from jsonb_each(t.eaten_slots) m where m.value->>'eaten_at' is not null),
           (select min(le.eaten_at) from log_entries le
             where le.user_id = t.user_id and le.local_date = t.local_date
               and le.deleted_at is null)) as first_at,
         coalesce(
           (select le.tz from log_entries le
             where le.user_id = t.user_id and le.local_date = t.local_date
               and le.deleted_at is null
             order by le.eaten_at limit 1),
           s.time_zone) as tz,
         s.slot_times->>'meal-1' as planned_clock, s.shift_minutes
    from target t join user_settings s on s.user_id = t.user_id
)
select case when tz is null then 'no_zone'
            when planned_clock is null then 'default schedule'
            else width_bucket(
              extract(epoch from ((first_at at time zone tz)::time
                - (planned_clock::time + make_interval(mins => shift_minutes)))) / 60,
              -120, 240, 12)::text end as late_bucket_30min,
       extract(isodow from local_date) >= 6 as weekend,
       count(*) as days
  from firsts
 where first_at is not null
 group by 1, 2
having count(*) >= 5
 order by 2, 1;
```

**Q5. Unplanned eating: logs outside meal slots.** Count and energy share of entries filed under
`snack` (the only log slot that is not a plan slot, `lib/coach/actions/fields.ts:29`).

```sql
, item_energy as (   -- the daily_energy rule, per entry slot
  select le.user_id, le.local_date, le.slot,
         case when jsonb_typeof(li.snapshot->'energy_kcal'->'amount') = 'number'
                   and (li.snapshot->'energy_kcal'->>'amount')::numeric >= 0
                then (li.snapshot->'energy_kcal'->>'amount')::numeric
              when jsonb_typeof(li.snapshot->'energy_kcal_calc'->'amount') = 'number'
                   and (li.snapshot->'energy_kcal_calc'->>'amount')::numeric >= 0
                then (li.snapshot->'energy_kcal_calc'->>'amount')::numeric end as kcal
    from log_entries le
    join log_items li on li.entry_id = le.id
    join target t on t.user_id = le.user_id and t.local_date = le.local_date
   where le.deleted_at is null
), per_day as (
  select user_id, local_date,
         count(*) filter (where slot = 'snack') as snack_items,
         sum(kcal) filter (where slot = 'snack') as snack_kcal,
         sum(kcal) as logged_kcal,
         count(*) filter (where kcal is null) as unknown_items
    from item_energy
   group by 1, 2
)
select count(*) as days,
       round(avg(snack_items), 2) as snack_items_per_day,
       round(sum(snack_kcal) / nullif(sum(logged_kcal), 0), 3) as snack_share_of_logged_kcal,
       sum(unknown_items) as items_with_unknown_energy
  from per_day
having count(*) >= 5;
```

The share is of logged energy only; eaten plan slots are not in `log_entries`. Unknown energy is
counted, never read as 0 (`AGENTS.md`, the energy rule).

**The cause mix the owner sees (R0 output).** One page, per account the owner may see and pooled:
the drift split (Q1), the per-slot outcome (Q2), the size ratio (Q3), the lateness curve split by
weekday and weekend (Q4) and the snack share (Q5). The thresholds in §5.2 are then confirmed or
moved by the owner in `docs/decisions/`. This does not gate v1 (D10).

## 4. Principles (v1)

1. **Read-only.** v1 adds no writer, no new **persisted** field, no migration and no coach action.
   Every change the panel leads to goes through an action Today already has, on Today's card.
   v1 makes **no change to the `ResolvedSlot` or `ResolvedDay` types**, so every existing typed
   fixture stays valid. `resolveDay` takes one bounded correction (R1, re-plan option A): a saved
   historical ritual with nothing stored to describe it (its library meal comes from the date
   rotation or a saved swap id, a planned choice) and a log filed under it shows the existing
   logged shell ("Eaten meal (counted in your log)", components and macros zero), so the log
   counts once; before, Today added the library meal and the log (a 125 kcal Latte plus a 100 kcal
   log read 225). With no log, and with explicitly saved food lines, the display is unchanged.
   Beside it, R1 adds a pure lib projection:

   ```ts
   // lib/plan/panel-slots.ts (pure)
   export type PanelSlot = ResolvedSlot & {
     cleared: boolean;
     eatenEnergyBasis: "none" | "components" | "estimate" | "log" | "unknown";
   };
   export function projectPanelSlots(day: ResolvedDay,
     stored: StoredDay | undefined): PanelSlot[];
   ```

   Its inputs are explicit: the resolved day (its slots and `extras`, the date's logs) and the
   same date's `StoredDay` from the store Today resolved from (`app/page.tsx:436-441` reads the
   same day). It never reads the store itself. One `PanelSlot` per `day.slots` entry, same order.
   It lives in `lib/plan/`, beside the slot-share and eaten-estimate rules it reads; `lib/today/`
   belongs to the UI lane.

   `cleared` is true only when the date's override is an explicit Clear
   (`stored.itemOverrides[slot].cleared === true`, the value `resolveDay` reads at
   `lib/resolve.ts:258`); `meal === null` never stands in for it. `eatenEnergyBasis` says what an
   eaten slot's energy rests on. It is read from **stored state through the same pure helpers
   `resolveDay` uses**, never from a display name (round 8: a saved meal may carry any title,
   including "Eaten meal (estimate)", `lib/plan-day-client.ts:315`):

   | Value | When |
   |---|---|
   | `none` | `stored.eaten[slot]` is not set |
   | `log` | eaten, and a log entry is filed under the slot (`slotHasOwnLog(stored, slot)`, `lib/plan/eaten-estimate.ts:59-61`) while the slot is undescribed (`undescribedEatenSlots(stored, [slot])`, `:22`) or is the Plan panel's logged shell (`isLoggedShell`, `:43-46`): the log is the record and the slot contributes 0 |
   | `estimate` | eaten, undescribed (`undescribedEatenSlots`), no own log, and the resolved slot carries the frozen share (`slot.macros.kcal > 0`, set by `eatenEstimateMeal`, `:88-94`) |
   | `components` | eaten, not undescribed, and `slot.components` holds at least one food line (a recipe snapshot, a time-edit snapshot, or a saved edit) |
   | `unknown` | every other eaten slot: undescribed with no share (no target revision), a logged shell whose log was deleted, or a described slot with no food lines |

   `isLoggedShell` keys on a stored override title; that is the existing stored contract the
   Plan panel writes and `resolveDay` already honours (`consumedSnapshot`, `:53-56`), so the panel
   agrees with Today by construction. No rule reads `meal.name`.

   Removed, uneaten slots stay absent from `resolved.slots`. The projection changes no stored
   day, no sync payload, no server schema and no existing type, so R1 needs no edit under
   `components/` or `tests/cards/` to pass the type check.
2. **The target revision is the authority.** The panel shows the revision in force on the device's
   local day and never edits it.
3. **One predicate.** Over, under and within are decided by one function (§5.1), used by the
   classifier, the panel copy and the tests. No other code compares a day to its target for this
   panel.
4. **No promises.** The panel shows the day as it is now. It never shows a projected result of an
   action. After any action, it re-reads the day.
5. **Today only.** The panel shows on the device's local today and is hidden on every other date.
6. **Offers, not corrections.** Copy never says "fix" or "make up for" (R11). It names the state
   and the user's own options.
7. **Pure and tested.** The predicate and the classifier are pure functions with boundary tests.

## 5. The predicate and the classifier

### 5.1 The one predicate

```ts
// lib/rebalance/balance.ts (pure). The only place a day is compared with its target here.
export const BALANCE_TOLERANCE = { minKcal: 100, share: 0.05 } as const;

/** kcal against target: "over" above target + tol, "under" below target − tol, else "within". */
export function balanceOf(kcal: number, targetKcal: number): "over" | "under" | "within";
export function toleranceFor(targetKcal: number): number;   // max(100, round(0.05 × T))
```

Reason for the band: label error (R15) and self-report error (R13) make a smaller band chase
noise; 100 kcal is about one piece of fruit; a meal "fits" at 10 % (`lib/meals/size.ts:151-155`)
and meal errors partly cancel over a day. [ESTIMATE]

### 5.2 The day's numbers

`dayBalance(day: ResolvedDay, slots: PanelSlot[], now: { date: string; minutes: number }): DayBalance` (pure, in
`lib/rebalance/balance.ts`), where `now.date` is `targetDayFor(nowDate)`
(`lib/targets/revision.ts:327-329`). `day` comes from the same `resolveDay` call Today renders from
(accepted-recipe projection included, `app/page.tsx:436-441`), so the panel and the cards read the
same slots, times and meals. `DayBalance` carries T, the `IntakeEvidence` below, `left`,
`planned`, the missed and remaining slots, and W.

| Symbol | Meaning |
|---|---|
| T | `day.targets.kcal`: the revision in force on the device's local day, for its day type |
| slots | `projectPanelSlots(day, stored)`: every rule below reads these `PanelSlot`s |
| recordedKcal | The energy the day has a record for, summed and rounded once: for each slot with `eatenEnergyBasis === "components"`, the kcal of its food lines (`slot.macros.kcal`, their sum); plus, for each logged item in `day.extras`, `itemKcal(item.snapshot ?? {})` when it is not null. It never reads `day.consumed.kcal`, `entryMacros`, an entry's or an item's `macros.kcal`, or an `estimate` slot's `slot.macros.kcal`. A `0` from `itemKcal` is a known zero. |
| estimatedSlots | slots with `eatenEnergyBasis === "estimate"` |
| unknownSlots | slots with `eatenEnergyBasis === "unknown"` |
| unknownItems | logged items in `day.extras` for which `itemKcal(item.snapshot ?? {}) === null` (`lib/nutrients/energy.ts:37-40`), the one energy rule's item function. Nothing else decides it: a finite `macros.kcal` never counts as known. An empty snapshot is unknown, including the `snapshot: {}` with `macros.kcal: 0` placeholder that `lib/log/reconcile.ts:385-396` writes. |
| unknownEntries | log entries in `day.extras` whose `items` is absent or empty: an unknown source, whatever their `macros.kcal` says |
| partial | `dayHasPartialNutrition(day)`: a partly measured recipe serving is on the day (`lib/resolve.ts:116-123`) |
| status | `incomplete` when `unknownSlots`, `unknownItems` or `unknownEntries` is above 0, or `partial`; else `estimated` when `estimatedSlots` is above 0; else `complete`. |
| left | T − recordedKcal, only when `status === "complete"`; otherwise null |
| missed | `isMissedSlot(slot, day, now)`, the one missed rule below |
| remaining | a slot that is not eaten, not `cleared` and not missed, except a slot whose log is its record (`meal === null`, not eaten and `slotHasOwnLog`). A planned, uneaten meal with food logged under it stays remaining. |
| planned | Only when `status === "complete"`: recordedKcal + the kcal of the remaining cards as shown. This is the plan as it stands, not a forecast: missed cards are left out because they went by. Otherwise null. |
| Z | the eating end: `max(latest planned slot time today, 21:30)` (`lib/today/meal-actions.ts:14-19`; `lib/meals/occasion.ts:28-34`) |
| W | Z − now, in minutes |

The intake evidence travels as one object:

```ts
type IntakeEvidence = {
  recordedKcal: number;
  status: "complete" | "estimated" | "incomplete";
  estimatedSlots: number;
  unknownSlots: number;
  unknownItems: number;
  unknownEntries: number;
  partial: boolean;
};
```

On a `complete` day, `recordedKcal` equals `day.consumed.kcal`: no estimate, no legacy fallback and
no unknown item is in either sum. A saved swap id is a planned choice, not consumed-food
evidence: an eaten ritual described only by one counts as `log` when a log is filed under it
(and Today shows the logged shell, §4), else `unknown`. On any other day the two can differ, and only `recordedKcal` is
shown. v1 shows no "at most N kcal left" figure.

**The one missed rule.** R1 exports a pure function. The panel is its only caller in v1; Today's
card does not render a missed state (§2):

```ts
// lib/rebalance/missed.ts (pure)
export function isMissedSlot(slot: PanelSlot, day: ResolvedDay,
  now: { date: string; minutes: number }, graceMin = 90): boolean;
```

A slot is missed when all of these hold:

1. It is not eaten, and `slot.cleared` is false. The check reads `cleared` explicitly; an unplanned
   empty slot (`meal === null`, not cleared) stays eligible. A deleted slot is not in `day.slots`.
2. No log entry is filed under the slot (`slotHasOwnLog(day, slot.slot)`,
   `lib/plan/eaten-estimate.ts:58-61`). A slot with food logged under it is never missed: the user
   has acted on it. This also covers the eaten slot that resolves to `eaten: false` (§2). Whether
   it is still listed is the `remaining` rule's call: it stays remaining while its planned meal is
   uneaten (`meal !== null`), and leaves both lists when the log is its record (`meal === null`).
3. **The day has activity**: a slot is eaten, or the day is a floor day, or a gut or weight entry
   is on it, or any entry is logged. This is Today's existing condition (`dayHasActivity`,
   `app/page.tsx:839-843`) plus logged entries, so an untouched day never shouts "missed".
4. The day is past (`day.date < now.date`), or it is today and
   `now.minutes >= slot.time + graceMin`.

Today's inline rule (`app/page.tsx:986-990`) has no grace and excludes the current slot instead.
Its only use is the `isMissed` prop, which `SlotCard` declares and never reads
(`components/SlotCard.tsx:96-127`). The panel's rule replaces it for the panel only: a slot is not
missed until 90 minutes after its time, which also covers the slot now in progress. The UI
hand-off deletes the prop and the inline calculation (§6.1); v1 makes no claim that Today's card
and the panel label the same slots missed.

Missed-meal grace is 90 minutes after the slot's time: a tick is often late, timing is erratic
(R7), and 90 minutes is under the 150-minute meal spacing (`lib/today/meal-actions.ts:14-19`), so a
meal reads as missed before the next is due. [ESTIMATE] (D8)

### 5.3 The classifier

`classifyDay(viewedDate: string, today: string, balance: DayBalance | null): PanelState` (pure,
`lib/rebalance/classify.ts`), where `today = targetDayFor(now)`. It picks the panel's state, copy
keys and highlighted cards only. Run top to bottom; the first match wins. The date is checked first,
so no other date ever reaches a state that reads its numbers.

| # | State | Rule | Highlights | Reason |
|---|---|---|---|---|
| 1 | `hidden` | `viewedDate !== targetDayFor(now)` | none | Today only, by the one device-local rule. Checked before anything else. |
| 2 | `no_target` | `T` is null (`needs_profile`) | none | The revision owns the numbers; with none there is nothing to compare. |
| 3 | `incomplete_intake` | `status` is `estimated` or `incomplete` (a frozen estimate, an unknown eaten slot, an unknown item or entry, or a partly measured serving) | missed cards, if any | Intake is not fully known, so a definite "left", under or over would be a guess. Checked before any balance comparison. Copy: "Intake is not fully known"; "At least {recordedKcal} kcal accounted for" only when `recordedKcal > 0`; then the applicable estimate, unknown or partial line (§6.2). No left or planned figure, no nudge. |
| 4 | `spent` | `balanceOf(recordedKcal, T) === "over"` | remaining cards | Already past the target from what was recorded. |
| 5 | `no_action` | no missed and no remaining card, or `W < 30` | none | Nothing left that an action could change; late in the day an "under" is the most likely to be an under-log (R13). Copy: "Nothing left to change today" or "Tomorrow starts fresh". |
| 6 | `over` | `balanceOf(planned, T) === "over"` | remaining cards | The plan as it stands ends over. |
| 7 | `under` | `balanceOf(planned, T) === "under"` | missed cards first, then remaining | Usually a missed meal (R1 to R4). |
| 8 | `on_track` | otherwise | missed cards, if any | |

`spent`, `over`, `under` and `on_track` all require `status === "complete"`; `spent`, `over` and
`under` use `balanceOf`, and no state compares kcal to T any other way. No copy ever says "at
least" followed by `day.consumed.kcal` or a frozen estimate. A missed card is always listed,
whatever the state, so the user can open it on Today.

## 6. Panel data contract (for the UI lane)

```ts
// lib/rebalance/panel.ts (pure) and useRebalancePanel(date) (client hook, read-only)
export type RebalancePanel =
  | { show: false }
  | {
      show: true;
      state: "no_target" | "incomplete_intake" | "on_track" | "under" | "over" | "spent" | "no_action";
      tone: "quiet" | "nudge";          // nudge for under, over, spent; quiet otherwise, incomplete_intake included
      copyKey: PanelCopyKey;            // one reviewed string per state (§6.2, D6)
      numbers: {
        targetKcal: number | null;
        recordedKcal: number;                              // section 5.2; never day.consumed.kcal
        leftKcal: number | null;                           // null unless intake.status is "complete"
        plannedKcal: number | null;                        // null unless intake.status is "complete"
        intake: {                                          // IntakeEvidence without recordedKcal, section 5.2
          status: "complete" | "estimated" | "incomplete";
          estimatedSlots: number; unknownSlots: number;
          unknownItems: number; unknownEntries: number; partial: boolean;
        };
        proteinTargetG: number | null;
        proteinConsumedG: number | null;                   // day.consumed.protein, only when intake.status is "complete"
      };
      cards: {
        slot: SlotId; label: string; time: string; kcal: number;
        status: "missed" | "remaining"; highlight: boolean;
      }[];
    };

// The panel component's props. onOpenSlot is UI-owned: it takes the user to that slot's Today card.
type RebalancePanelProps = { panel: RebalancePanel; onOpenSlot: (slot: SlotId) => void };
```

### 6.1 Links, not writes

- **No action list and no parity claim.** The panel lists no actions. It makes no claim that its
  cards offer what `SlotCard` offers, or that its missed label matches anything Today's card
  shows. `SlotCard`'s controls depend on the variant, an attached flow and the expanded detail
  (§2), so a list built from the slot alone would be wrong. Full action and visible missed-card
  parity is a Phase 19b item (§10).
- **One link per card.** Each listed card, missed or remaining, empty or planned, focus or
  standard, has one "View meal" link that calls `onOpenSlot(card.slot)`. The UI lane owns where it
  goes: Today's card for that slot, where Clear, Delete, Edit, the time, Swap, Plan and Log already
  are. The panel never calls a writer and never builds an override.
- **The panel renders the missed status itself**, from `isMissedSlot` (§5.2): the card's `status`
  is `"missed"` and its label says the meal went by. Today's card does not change.
- **UI hand-off (R2).** The UI lane removes the unused `isMissed` prop from `SlotCard`
  (`components/SlotCard.tsx:126-127`), the inline calculation in `app/page.tsx` (`dayHasActivity`
  at `:839-843`, `isPastDay` at `:434` and the rule at `:986-990`, all used only by it) and the
  `isMissed={isMissed}` argument at `:1006`, and drops `isMissed` from the test callers that pass
  it (`components/SlotCard*.test.tsx`, `tests/cards/today.test.tsx`,
  `tests/design/overflow.test.tsx`).
- An eaten card, a cleared card (`slot.cleared`), a slot whose log is its record (`meal === null`
  with a log filed under it) and a deleted card are not listed. A planned, uneaten meal with food
  logged under it is listed as remaining. A cleared card is brought back by the clear notice's
  Undo, as today.
- **No explainer about clearing.** The panel offers no Clear, so v1 carries no "Clearing a meal…"
  line. Such copy is a 19b item (§10).
- After any action, and on every store change, `SYNCED_EVENT` (`lib/sync/client.ts:36`) and the
  minute tick, the hook re-runs `resolveDay` and `classifyDay`. It shows the new state; it never
  predicts one.

### 6.2 States and copy

| State | Tone | Headline (draft, for clinical review) | Sub |
|---|---|---|---|
| no_target | quiet | Set up your targets | "Set up" links to onboarding |
| incomplete_intake | quiet | Intake is not fully known | "At least {recordedKcal} kcal accounted for" only when `recordedKcal > 0`; then each line that applies: "{n} eaten meal is an estimate" (`estimatedSlots`), "{n} eaten meal has no calorie record" (`unknownSlots`), "{n} logged food has no calorie value" (`unknownItems + unknownEntries`), "A recipe is only partly measured" (`partial`); plural for n > 1. No left or planned figure. |
| on_track | quiet | On track | "{left} kcal left" |
| under | nudge | {left} kcal left today | "Breakfast went by" when a card is missed |
| over | nudge | Your plan comes to {planned − T} kcal over | "You can open a meal below to clear or change it" |
| spent | nudge | {recordedKcal − T} kcal past today's target | "Tomorrow starts fresh" |
| no_action | quiet | Nothing left to change today | "Tomorrow starts fresh" late in the day |

- Button label and panel name: "Rebalance my day" (D1). The widget opens on this panel when the
  tone is `nudge`; otherwise on the user's last panel (D3, the UI lane implements it).
- Numbers through `KcalText`; colour through roles only; at least 44 px targets; tone changes on a
  named spring (`AGENTS.md` design contract).
- **Gate.** The copy for `under`, `over`, `spent` and `incomplete_intake`, and which cards are
  highlighted in each, pass the clinical review (D6) before the panel ships. The review alone gates
  the flag (D10). Until then the panel stays behind the
  `rebalance` flag, off by default: a `REBALANCE_PANEL_USER_IDS` env allowlist of account UUIDs.
  The panel shows only for an allowlisted account (or `*`). An empty or missing allowlist never
  turns it on, in any environment: unlike `recipeAccessEnabled`
  (`lib/server/recipe-access.ts:8-17`), there is **no development or localhost fallback**, because
  the clinical gate covers every environment a person might use.

## 7. Tests (v1)

| Test | File | Proves |
|---|---|---|
| Predicate | `lib/rebalance/balance.test.ts` | `balanceOf` at T ± tol, ± tol ± 1, for T = 1,200, 2,000 and 3,000 (tol 100, 100, 150). |
| One predicate | same | A source scan of `lib/rebalance/` and the panel component finds no comparison of kcal with a target outside `balance.ts`, and both the classifier and the panel import `balanceOf`. |
| Day numbers | same | `dayBalance` on fixtures: cleared and deleted cards excluded; eaten cards excluded; a slot whose log is its record (`meal === null`, a log filed under it) excluded; a planned, uneaten meal with food logged under it listed as remaining; `planned` excludes missed. On every `complete` fixture, `recordedKcal === day.consumed.kcal`. |
| Missed rule | `lib/rebalance/missed.test.ts` | `isMissedSlot`: missed at exactly slot time + 90 min, not at + 89; not missed on a day with no activity; missed once one slot is eaten, or one entry is logged; every uneaten, uncleared slot of a past active day is missed unless a log is filed under it; eaten and cleared slots never are. |
| Target in force | `lib/rebalance/balance.test.ts` | A day after a future-dated revision's `effective_from` uses the new revision; a day before it uses the old; no revision gives `no_target`. |
| Energy rule | same | An entry with reported energy and one with calculated only give `recordedKcal` = reported + calculated and `status: "complete"`. A source scan of `lib/rebalance/` finds `recordedKcal` and `unknownItems` decided only through `itemKcal` and `eatenEnergyBasis`, with no read of `macros.kcal`, `entryMacros` or `consumed.kcal`. |
| Unknown energy | `lib/rebalance/classify.test.ts` | T 2,000, nothing else eaten, one logged item with 25 g protein and no `energy_kcal` or `energy_kcal_calc`: the state is `incomplete_intake`, `recordedKcal` is 0, `leftKcal` and `plannedKcal` are null, the headline is "Intake is not fully known", and the panel text contains no "kcal left" and no "at least". |
| Empty snapshot | same | One logged item with `snapshot: {}` and `macros.kcal: 0` (the reconcile placeholder): `unknownItems` is 1 and the state is `incomplete_intake`. |
| Partial recipe | same | T 2,000 and one 200 kcal partly measured recipe serving (`nutritionPartial: true`): the state is `incomplete_intake`, `status` is `incomplete`, `leftKcal` and `plannedKcal` are null, and the panel text contains "At least 200 kcal accounted for" and "A recipe is only partly measured", and no "kcal left". |
| **Frozen estimate** (round-6 BLOCK 1) | `lib/rebalance/balance.test.ts` | A timestamp-only eaten mark with a 600 kcal frozen share: the slot has `eatenEnergyBasis: "estimate"`; `recordedKcal` is 0; `status` is `estimated`; `leftKcal` and `plannedKcal` are null. The panel text contains neither "600 kcal eaten" nor "at least 600". Filing a log under the slot changes its basis to `"log"` and counts the log's items once. |
| **Legacy macro fallback** (round-6 BLOCK 2) | same | One item with `macros.kcal: 800` and `itemKcal === null` beside a valid 200 kcal item: `recordedKcal` is 200, `unknownItems` is 1, and no displayed lower bound is above 200. Repeat with `items` absent and `entry.macros.kcal: 800`: `unknownEntries` is 1 and no text claims 800 kcal. |
| **Basis ignores names** (round-8 BLOCK) | `lib/plan/panel-slots.test.ts` | Save an eaten, food-less meal edit titled "Eaten meal (estimate)" and another titled "Eaten meal (counted in your log)" with no log filed: neither projects as `estimate` nor `log` (both `unknown`, or `components` when they hold food lines). A real frozen estimate (undescribed, share present, no own log) projects `estimate`; the same slot with a log filed under it projects `log`; with no target revision it projects `unknown`. No code path in `panel-slots.ts` reads `meal.name` (source check). |
| **Clear is not empty** (round-6 BLOCK 3) | `lib/plan/panel-slots.test.ts` and `lib/rebalance/missed.test.ts` | Resolve two `meal: null` slots, one explicitly cleared and one never planned, then project them with `projectPanelSlots`. Only the first `PanelSlot` has `cleared: true`; `resolveDay`'s output and the `ResolvedSlot` type are unchanged (no `cleared` key on either slot). After activity and the grace, only the second can be missed or remaining. An uneaten removed slot is absent from `day.slots`. |
| **Food logged under a planned meal** (round-7 BLOCK 1) | `lib/rebalance/balance.test.ts` | A planned, uneaten Meal 2 with one food logged under it through the Log Food sheet's path (an entry with `slot: "meal-2"`, no eaten mark), on an active day, 3 hours after its time: Meal 2 is listed as `remaining`, never `missed`, and its card kcal counts in `planned`. The same slot with `meal === null` (its log is its record) is in neither list. |
| **One link per card kind** (round-7 WARN) | `tests/rebalance/panel.test.tsx` | A fixture holds one card of each listed kind: missed, remaining with a meal, remaining empty (`meal === null`, no log) and remaining with food logged under it. Each renders exactly one link, and activating it calls `onOpenSlot` once with that card's slot. |
| **No action list** (round-6 BLOCK 4) | `tests/rebalance/panel.test.tsx` | The panel contract has no `actions` array. An empty focus card and an empty standard card each get the same single link, which calls `onOpenSlot(slot)`. The test makes no assertion that the panel's links match `SlotCard`'s buttons: today the standard empty card shows Plan, the focus empty card Plan and Log (`components/SlotCard.tsx:258-297`). |
| **Missed label is the panel's own** (round-6 BLOCK 5) | same, and `tests/rebalance/no-ismissed.test.ts` | The panel's missed label and list come from `isMissedSlot`. A UI test asserts "View meal" reaches the correct Today card. After the UI hand-off, compilation and a source scan confirm that `SlotCard` has no `isMissed` prop and `app/page.tsx` has no inline missed calculation. Passing a prop is never counted as a parity test. |
| Accepted recipe | `lib/rebalance/classify.test.ts` | An accepted 700 kcal recipe at Meal 3 (through `withAcceptedRecipeSelections`) is a remaining 700 kcal card and counts in `planned`. |
| Date first | `lib/rebalance/classify.test.ts` | Yesterday (`targetDayFor(now)` minus one day) with no target returns `hidden`, not `no_target`; tomorrow with a target returns `hidden`; a device clock near midnight uses the local date, not UTC. |
| Classifier | `lib/rebalance/classify.test.ts` | Each row of §5.3 at its boundary, including 12:00, T 1,800, `recordedKcal` 2,000 on a `complete` day, every meal eaten → `spent` with no cards, and the same at 21:45 → `spent`; no cards and `recordedKcal` within → `no_action`; an `estimated` day with no cards → `incomplete_intake`, not `no_action`. |
| Read-only | `tests/rebalance/import-graph.test.ts` | Nothing under `lib/rebalance/` imports `lib/plan-day-client.ts`, `lib/store.ts` writers, `lib/sync/*` writers or `lib/coach/actions/*`. |
| Re-read | `tests/rebalance/panel.test.tsx` | Clear a remaining card on Today (through `changeMeal`): the panel re-renders from the new day (its numbers equal a fresh `resolveDay`), and shows no projected value before the write lands. |
| Flag | same | Empty, missing and whitespace-only allowlists hide the panel with `NODE_ENV` set to `development` and a `localhost` or `127.0.0.1` Supabase URL, and in production; an allowlist naming another account hides it; one naming this account, or `*`, shows it. |

## 8. Latency budget (proposed, not measured)

| Hop | Budget (p95) |
|---|---|
| `dayBalance` + `classifyDay` | 5 ms on a mid phone |
| Panel re-render after a store change | one frame after the existing Today re-render |

The panel reuses Today's `resolveDay` result; it adds no fetch. Measured with
`mark("rebalance", "classify")` (`lib/timing.ts:111`) once the flag is on for test users.

## 9. Slices (v1)

| Slice | Contents | Acceptance (measurable) |
|---|---|---|
| **R1. Panel projection, predicate and classifier** | `lib/plan/panel-slots.ts`: the `PanelSlot` type and the pure `projectPanelSlots(day, stored)` (§4), with its test; `ResolvedSlot` and `ResolvedDay` unchanged, and `resolveDay`'s one bounded correction for a logged historical ritual (§4); the intake evidence aggregation (`recordedKcal`, `status` and the counts, §5.2); `lib/rebalance/{balance,classify,missed}.ts` and their tests. Pure. Uses `targetDayFor` for the local day. | The predicate, one-predicate, missed rule, day numbers, target in force, energy rule, unknown energy, empty snapshot, partial recipe, frozen estimate, legacy macro fallback, clear is not empty, food logged under a planned meal, accepted recipe, date-first and classifier tests in §7 pass; 100 % branch coverage of `panel-slots.ts`, `balance.ts`, `classify.ts` and `missed.ts`; the one-predicate scan passes; the PR changes code under `lib/` only (plus this spec), and `tsc --noEmit` passes with no edit under `components/` or `tests/cards/`; the existing `resolveDay` tests pass, changed only where a fixture encoded the ritual-plus-log double count; p95 ≤ 5 ms over 10,000 generated days in a bench. |
| **R2. Panel data and links** | `lib/rebalance/panel.ts`, `useRebalancePanel`, the copy table, the `REBALANCE_PANEL_USER_IDS` gate, and one read-only "View meal" link per card through the UI-owned `onOpenSlot(slot)`. The UI hand-off (§6.1) owns the navigation and removes `SlotCard`'s unused `isMissed` prop and the inline calculation at `app/page.tsx:986-990`. Hands the contract to the UI lane. | The read-only, re-read, no-action-list, one-link-per-card-kind, missed-label and flag tests pass; zero new writers (import-graph test); zero new migrations (`supabase/migrations/` unchanged in the PR); the panel shows `incomplete_intake` with no left or planned figure for the unknown-energy, empty-snapshot, partial-recipe, frozen-estimate and legacy-fallback fixtures; "View meal" reaches the correct Today card for an empty focus card and an empty standard card; no `isMissed` prop or inline missed calculation remains (compilation and source scan); the flag test passes in development on localhost with an empty allowlist (panel hidden); the flag turns on for any user only after the D6 review sign-off is recorded in `docs/decisions/`. No acceptance item claims action or missed-label parity with `SlotCard`. |

R2 needs R1 and the UI lane's shell. Nothing in v1 waits for R0 (D10).

## 10. Later (Phase 19b)

Each follow-up is out of v1. Each lists the design fix the reviews require before it can be built.

| Follow-up | Required design fix (from the reviews) |
|---|---|
| **R0 drift study** (§3.2) | Branch-only, read-only, aggregate-only, as drafted. Before it runs: (1) filter to consented or synthetic accounts before the common CTE, and reject any unapproved account before any query runs; (2) choose the revision in force by latest `effective_from`, then highest `rev` (the app's rule); (3) when `input_training_weekdays` is null, fall back to the account's settings weekdays, as `targetDayType` does (`lib/targets.ts:43-53`); (4) define Q2's account-day cohort to include dates with no `plan_days` row, or label Q2 "stored plan days only"; (5) compute Q4's shifted clock with Today's same-day clamp (`shiftTime`, `lib/plan.ts:81-85`). Its output retunes the grace (D8) and the tolerance. Consent: D7. |
| **Portion resizing: trim and enlarge** | Resize only app-generated plates, never authored meals (Phase 17, `docs/specs/phase-17-meal-occasion.md:34-36`); never a protein line; every line inside its band; every option's projected day must meet every revision floor, with no exemption; retained locked and authored meals and every still-shown missed meal count in every projection. |
| **Clear or move several missed meals at once** | Every missed slot is either in the option's edits (skip or move) or counted in its projection, so the preview equals the write; test with two missed meals. |
| **Add a side or a calorie-dense food** | Only foods the current admitted set allows (today the verified eligible view; Phase 18's admission and rules token when it lands); nothing added offline or with no current view. |
| **Projected ranking of options** | Compare missed-meal options against the likely-uneaten baseline (the day without the missed meals), not against the plan as shown, so clearing a missed meal is not scored as a loss. |
| **Materialization and the rebalance mark** | A mark that identifies the app's plate (`source` plus a hash of the written components); every components-changing writer clears it (including `saveMealEdit`, `lib/plan-day-client.ts:289-344`); the classifier trusts it only while the hash matches; and the mark is part of the slot identity that apply and Undo compare. |
| **Batch apply and one Undo** | A log-aware atomic write boundary, or a revision check at write time: `addExtra` (`lib/store.ts:284-287`) writes a log outside the plan-day queue (`lib/sync/plan-day-queue.ts:15-23`), so revalidating inside that queue alone does not see a log that lands between plan and write. Apply and Undo read, merge and write the full `item_overrides` map, revalidate the touched slots inside the write boundary, and refuse the whole write on any mismatch; untouched slots survive both. |
| **Coach `rebalance_day`** | The action carries the exact previewed edit list's `editsHash`; apply refuses unless re-planning yields the identical edits; the basis uses only server-reproducible inputs (`plan_days` rev, target revision id and rev, the day's log ids and revs, `constraint_profiles` rev); the server builder overlays accepted selections like Today; the clinical review covers the option logic. |
| **Actions in the panel, and action and missed-card parity** | Only if still wanted after v1. A lib-owned `slotCardActions(slot, { variant, attached, expanded, canSwap, handlers })` drives both `SlotCard`'s rendered controls and the panel's list; the variant alone is not enough, because an attached flow and the expanded detail also change the controls (`components/SlotCard.tsx:187-191`, `:258-297`). `isMissedSlot` drives a visible missed state on Today's card. Rendered tests cover focus, standard, attached and expanded cards. Passing either result into `SlotCard` as an unread prop does not count. |
| **Copy about clearing** | Any line that says clearing a meal shares its calories with other meals shows only when `lib/plan/slot-share.ts` has a recipient for that day: an open slot remains (`count > 0`, `:193-194`). With every other meal saved, eaten or cleared, nothing is shared and the line must not appear. |
| **Learned ordering** | Reorders only, from the account's own history on the phone, after 14 marked-complete days; never adds an option or moves a threshold. |

Revisions 1 to 3 (3cc0d87, 93a33f9, 73512f4) hold the full planner design these items start from.

## 11. Risks (v1)

| Risk | Mitigation |
|---|---|
| An "under" is really an under-log (R13). | The tolerance band; `no_action` late in the day; copy states numbers and never says the user must eat more. |
| Over and spent copy could feed restrictive patterns (R11). | The clinical review gate (D6) on that copy and on which cards are highlighted, behind an off flag. |
| The panel and the cards disagree. | Both read the same `resolveDay` result; the re-read test. The panel uses its own missed label (`isMissedSlot`) and links to the card; it claims no action or missed-label parity with `SlotCard`. |
| The panel overstates what was eaten. | Only `recordedKcal` is shown; a frozen estimate or a legacy `macros.kcal` fallback never counts; an estimated or incomplete day shows no left or planned figure (§5.2, §5.3 row 3). |
| Users expect the button to compute a plan. | The panel says what the user can do and that clearing re-shares the app's meals; 19b adds computed options after its design passes review. |

## 12. Decisions (2026-10-05)

The owner delegated these decisions on 2026-10-05.

| # | Decision | Reason |
|---|---|---|
| D1 | The name is **"Rebalance my day"**. | It says what happens without blame. "Fix my day" implies the day was wrong (R11). |
| D2 | **Never skip a meal by default.** In v1 the panel skips nothing: clearing a meal is the user's own existing action. In 19b, "Skip a meal" appears only when trimming cannot get within range, and ranks last. | Skipping is the bigger change; the user chooses it. |
| D3 | **Widget memory:** open on the rebalance panel when its tone is `nudge`; otherwise on the last panel the user chose. | The panel earns its place when it has news. The UI lane implements the memory. |
| D4 | **Today only.** Nothing carries to tomorrow. | The target revision owns the numbers; carrying calories forward is compensation (R11). |
| D5 | **Authored meals are not resized.** v1 resizes nothing; 19b resizes app-generated plates only. | Phase 17 rules that user-set meals are never rescaled (`docs/specs/phase-17-meal-occasion.md:34-36`). |
| D6 | **Clinical review gate.** The same qualified clinical reviewer as Phase 18 (its owner question 3) reviews the `under`, `over` and `spent` copy and which cards each highlights, before the panel ships. The panel stays behind the off-by-default `rebalance` flag until the sign-off is recorded in `docs/decisions/`. 19b's option logic needs its own review. | Over and spent readings are the riskiest moments for a person with a history of disordered eating. |
| D7 | **R0 on the first client's data waits for her consent.** Until the owner records it in `docs/decisions/`, R0 (now Phase 19b) runs on a restored branch with synthetic or consented accounts only. | Her days are health data. An open owner action; it blocks nothing in v1. |
| D8 | **Missed-meal grace starts at 90 minutes**, retuned from the R0 lateness curve (Q4) once 19b runs it. | Under the 150-minute meal spacing; the account data sets the final value. |
| D9 | **v1 is the read-only panel (option A of Sol's re-plan).** Resizing, batch writes, marks and the coach action move to 19b. | Three review rounds each found new blocking defects in the batch-writing planner, mostly at the write boundary. The read-only panel delivers the owner's visible ask (where the day stands, what went by, what to do) on paths that already work, with no new write risk. |

| D10 | **R0 leaves v1** for Phase 19b. v1 ships with the 90-minute grace and the `max(100, 5 % of T)` tolerance as starting values. The clinical copy review alone gates the flag. | The round-4 review found five defects in the draft queries. The thresholds have published support (§5.1, §5.2), and the read-only panel changes no plan, so measuring first is not needed to ship it safely. |

**Open owner action.** Record the first client's consent for R0 (D7), or confirm R0 runs on
synthetic and consented accounts only. Phase 19b only.

## 13. Out of scope (v1)

- Any new plan write, persisted field, mark or migration; any coach action (19b).
- Actions inside the panel, and action or missed-label parity with `SlotCard` (19b).
- Changing targets, macros or the revision.
- Carrying anything to another date.
- The widget shell, swipe, panel picker and Settings (UI lane).

## 14. Review findings: resolved by the cut or assigned to 19b

### Round 8 (revision 10)

| Finding | Resolution |
|---|---|
| BLOCK: `eatenEnergyBasis` read from `meal.name`; a saved meal titled "Eaten meal (estimate)" would be misread | Resolved: `projectPanelSlots(day, stored)` takes the date's `StoredDay` and derives the basis from stored state through `undescribedEatenSlots`, `slotHasOwnLog` and `isLoggedShell`, the helpers `resolveDay` uses (§4); test "Basis ignores names". |
| WARN: "read from the resolved slot alone" contradicted the `log` rule reading `extras` | Resolved: the sentence is gone; inputs are stated as the resolved day plus the stored day. |

### Round 7 (revision 9)

The round-7 review of revision 8 returned FAIL: three BLOCKs and one WARN. The owner's delegate
decided each fix; revision 9 resolves them.

| Finding | Outcome |
|---|---|
| BLOCK 1: the own-log rule hid a planned, uneaten meal that the Log Food sheet had filed food under | Resolved: a slot with a log filed under it is never missed, and stays remaining while it has an uneaten planned meal; it leaves both lists only when its log is its record (`meal === null`) (§2, §5.2, §6.1); tests "Day numbers" and "Food logged under a planned meal". |
| BLOCK 2: the "Clearing a meal…" explainer promised a redistribution that need not happen | Resolved: the line is removed from v1 (§6.1); 19b "Copy about clearing" requires a slot-share recipient before any such copy shows (§10). |
| BLOCK 3: required `ResolvedSlot` fields broke typed fixtures outside `lib/` | Resolved: `ResolvedSlot` and `resolveDay` do not change; `PanelSlot` and `projectPanelSlots` are a pure lib projection, and R1 must pass `tsc` with no edit under `components/` or `tests/cards/` (§4, §5.2, §9 R1); test "Clear is not empty". |
| WARN: the link tests did not cover every listed card kind | Resolved: test "One link per card kind" (§7). |

### Round 6 (revision 8, re-plan option A)

The round-6 review of revision 7 returned five BLOCKs. The owner's delegate chose option A of the
re-plan: an honest, read-only panel. Each finding is resolved by a contract change and an
acceptance test (§7).

| Finding | Outcome |
|---|---|
| BLOCK 1: a frozen estimate counted as known intake | Resolved: `eatenEnergyBasis` marks the estimate (§4); `recordedKcal` leaves it out, and an estimated day is `incomplete_intake` with no left or planned figure (§5.2, §5.3 row 3, §6.2); test "Frozen estimate". |
| BLOCK 2: the legacy `macros.kcal` fallback inflated "at least" | Resolved: `recordedKcal` sums `itemKcal` only and never reads `entryMacros`, `macros.kcal` or `day.consumed.kcal`; an entry with no items counts in `unknownEntries`; "at most" and `leftAtMost` are gone (§5.2, §6); test "Legacy macro fallback". |
| BLOCK 3: an explicit Clear was mistaken for an empty slot | Resolved: `cleared` (on `PanelSlot` since revision 9) comes from the override, never from `meal === null`; `isMissedSlot` rejects `cleared` explicitly and keeps an unplanned empty slot eligible (§4, §5.2); test "Clear is not empty". |
| BLOCK 4: the action list ignored the card variant | Resolved: the panel lists no actions (`cards[].actions` and `slotCardActions` are removed); each card has one "View meal" link through `onOpenSlot(slot)`; no parity is claimed (§6, §6.1). Full action parity is a 19b item (§10); test "No action list". |
| BLOCK 5: the unused `isMissed` prop was used as proof of parity | Resolved: the panel renders its own missed label from `isMissedSlot`; the UI hand-off removes the unread prop and the inline calculation (§5.2, §6.1, R2); test "Missed label is the panel's own". Visible missed-card parity is a 19b item. |

### Line change (revision 7)

| Point | Outcome |
|---|---|
| Two missed rules (the card's inline rule and the panel's grace) | Superseded in revision 8: one pure `isMissedSlot` with the 90-minute grace and the day-has-activity condition, used by the panel only. `SlotCard` never read `isMissed`, so the prop and the inline rule are removed (§5.2, §6.1). The "Missed parity" test is replaced by "Missed label is the panel's own". |

### Round 5 (revision 5)

| Finding | Outcome |
|---|---|
| BLOCK: a finite `macros.kcal` placeholder could count as known energy | Resolved: `unknownItems` is decided only by `itemKcal`; an empty snapshot, including reconcile's `macros.kcal: 0` placeholder, is unknown (§5.2); tests "Energy rule" (source scan) and "Empty snapshot". |
| BLOCK: a partly measured day showed a definite "left" | Resolved: `partial` joins the lower-bound state, renamed `incomplete_intake`: "at least N kcal eaten", "at most N kcal left", no nudge (§5.2, §5.3 row 3, §6.2); test "Partial recipe" (200 kcal against 2,000). Revised in revision 8: the copy reads "Intake is not fully known" and "At least {recordedKcal} kcal accounted for"; "at most N kcal left" is removed (round 6, BLOCK 2). |
| BLOCK: the action type missed actions Today's card offers | Resolved: `SlotCardAction` lists every `SlotCard` handler, Plan and "Log what you ate" included; one shared `slotCardActions` decides them for both (§6.1); the link-parity test covers every card kind and the empty uneaten card. Withdrawn in revision 8: the panel lists no actions and claims no parity; each card links to Today (round 6, BLOCK 4). |
| WARN: the flag could fall back to on in development | Resolved: no development or localhost fallback; an empty allowlist never shows the panel (§6.2); test "Flag". |

### Round 4 (revision 4)

| Finding | Outcome |
|---|---|
| R0 queries: unapproved accounts filtered after the common CTE | Assigned to 19b "R0 drift study", fix (1); R0 leaves v1 (D10). |
| R0 queries: revision chosen by `rev` alone | Assigned to 19b, fix (2): latest `effective_from`, then `rev`. |
| R0 queries: null `input_training_weekdays` ignored the account settings | Assigned to 19b, fix (3): fall back as `targetDayType` does. |
| R0 queries: Q2's account-day cohort undefined | Assigned to 19b, fix (4): include dates with no `plan_days` row, or label stored-only. |
| R0 queries: Q4's shift ignored Today's clamp | Assigned to 19b, fix (5): `shiftTime`'s same-day clamp. |
| R0 confirmation in the flag gate | Resolved: removed; the clinical copy review alone gates the flag (§6.2, R2, D10). |
| BLOCK: the panel read unknown energy as a definite number | Resolved: `energy` coverage in the contract, a lower-bound state (now `incomplete_intake`) with "at least N kcal eaten" and no definite "left" or nudge (§5.2, §5.3 row 3, §6); test "Unknown energy". Revised in revision 8: the coverage is `IntakeEvidence` and the lower bound is `recordedKcal` (round 6, BLOCKs 1 and 2). |
| BLOCK: `no_target` was checked before the date | Resolved: `hidden` first by `targetDayFor`, then `no_target` (§5.3); test "Date first". |

### Round 3 (re-plan of revision 3)

These are the blocking points named in the owner-delegated re-plan that led to the cut.

| Finding | Outcome |
|---|---|
| Missed-meal options were ranked against the plan as shown, not the likely-uneaten baseline | Resolved by the cut: v1 ranks nothing. 19b "Projected ranking". |
| The rebalance mark was not part of the identity apply and Undo compare | Resolved by the cut: v1 writes no mark. 19b "Materialization and the rebalance mark". |
| Revalidating inside the plan-day queue misses a log, because `addExtra` writes outside it | Resolved by the cut: v1 has no batch write. 19b "Batch apply and one Undo" (log-aware boundary or revision check). |

### Round 2 (revision 3)

| Finding | Outcome |
|---|---|
| BLOCK 1: the builder missed accepted recipe selections | Resolved: the panel reads Today's own `resolveDay` result, projection included (§5.2; test "Accepted recipe"). 19b's server builder must overlay them too. |
| BLOCK 2: missed slots left out of P but still shown | Resolved by the cut: v1 shows no projection of an action. `planned` is labelled as the plan as it stands, and every missed card is listed. 19b "Clear or move several missed meals". |
| BLOCK 3: `saveMealEdit` kept the rebalance mark | Resolved by the cut: no mark. 19b "Materialization and the rebalance mark". |
| BLOCK 4: the coach basis did not bind the option | Resolved by the cut: no coach action. 19b "Coach `rebalance_day`". |
| BLOCK 5: staleness checked outside the plan-day queue | Resolved by the cut: no batch write. 19b "Batch apply and one Undo". |

### Round 1 (revision 2)

| Finding | Outcome |
|---|---|
| BLOCK 1: retained locked meals missing from P | Resolved: `planned` counts every remaining card, locked recipes included (§5.2). 19b "Portion resizing" keeps the rule. |
| BLOCK 2: apply and Undo overwrote the full map | Resolved by the cut: no new writer; Today's existing single-slot writers merge as before. 19b "Batch apply and one Undo". |
| BLOCK 3: authored meals could be resized | Resolved by the cut: v1 resizes nothing (D5). 19b "Portion resizing". |
| BLOCK 4: no defined no-action outcome | Resolved: `no_action` state (§5.3 row 5) and its tests. |
| BLOCK 5: floor not enforced on the result | Resolved by the cut: v1 offers no computed result. 19b "Portion resizing" (every option meets every floor). |
| BLOCK 6: basis used phone-local inputs | Resolved by the cut: no basis without a coach action. 19b "Coach `rebalance_day`". |
| WARN 7: Q4 fell back to UTC | Resolved: Q4 uses the day's log zone, then `user_settings.time_zone`, else leaves the day out (§3.2). |
| WARN 8: clinical review covered wording only | Resolved for v1: D6 covers the copy and the highlighted cards per state, and gates the flag. 19b's option logic needs its own review. |
