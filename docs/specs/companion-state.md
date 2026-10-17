# Companion state: streaks, growth and wearables (W145)

Status: spec, 2026-10-17. Builds no stored state. The only change that ships with it is
`supabase/migrations/20270105120000_care_items_mascots_widen.sql` (wearables for every companion).
Per-companion pond, water and outfit art is a separate art step (B267) and waits on art credits.

## What exists today

| Piece | Where | Stored? |
|---|---|---|
| The chosen companion (`sprout`, `blueberry` "Blu", `mushroom` "Button", `peapod` "Pod") | `user_settings.mascot` (migration `20261225090000`), read through `lib/profile/mascot.ts` | Yes, per account, synced like every `user_settings` field |
| Mood (`content`, `joyful`, `sleepy`) and vitality | `lib/today/pet-mood.ts`, computed from the viewed day | No. Never stored |
| Seeds (points) | `care_points_ledger`, written by `care_points_sync` (`20261225090100`, fixed in `20270104090000`) | Yes, per account |
| Shop, owned items, what is worn | `care_items`, `care_inventory`, `care_equipped` (`20261225090200`) | Yes, per account (one `equipped` map, one `rev`) |
| Awards | `care_accolades` (`20261225090300`), including `seven-days`, `thirty-days`, `welcome-back` | Yes, per account |
| The well's inbox | `care_messages` (`20261225090400`), type `streak` allowed | Yes, but only `accolade` rows are ever written |
| "The log grew today" | `care_log_grew` (`20261225090500`), reads `change_log` + `log_entries` | No |

`care_items.mascots` means **can wear**: the companions whose art has a place for the item. It
matches `canWear` in `components/today/care/shop/catalog.ts` (Sprout's `places` plus each other
companion's `fits`); a widen-only update keeps any companion a row already listed, so a hand-edited
row can list more than `canWear`. After `20270105120000`: the leaf pin, mittens, both glasses and the shorts
list all four; the bucket hat and knitted hat list Sprout, Blu and Button (Pod has no head). The
server never enforces the column: `care_equip` does not read it and `GET /api/care/shop` only
reports it, so the phone decides from `catalog.ts`. `tests/migrations/care-items-mascots.test.ts`
freezes the migration's lists as `canWear` stood on 2026-10-17; a later catalog change that adds a
fit ships its own widening migration.

## Stored fields (design for the follow-up build)

Decisions:

1. **Per account, never per companion.** Streak days, growth stage, Seeds, owned items and awards
   belong to the person. Switching companion in Settings keeps all of it; the new companion simply
   wears what fits it. An item it cannot wear stays owned and stays in `care_equipped`; the phone
   skips drawing it (`placesFor` returns null) and draws it again when the person switches back.
2. **Computed on read first.** Both numbers come from rows the server already keeps, so the first
   build adds a read function, not a table:
   - **Streak days**: consecutive local dates, ending at the account's day (or the day before,
     while today is still open), that carry a settled or pending `day_recorded` row in
     `care_points_ledger`. The same evidence earns Seeds, so the two never disagree. A gap ends
     the streak; nothing is taken away for it. Known gap: `care_points_sync` only awards a date
     the phone syncs on (or one date either side, `20270104090000_care_ledger_fixes.sql`), so a
     day that was recorded but never synced near its own date has no row and breaks the streak.
     Accepted for v1; the follow-up build can backfill a closed week's `day_recorded` rows from
     `log_entries` when it reads progress.
   - **The 7-day beads**: Monday to Sunday of the account's current local week (the week
     `five_day_week` counts), each true when that date has a `day_recorded` row. This is the `days: boolean[7]` the `streak` note already draws
     (`components/today/care/CareNotes.tsx`, parsed in `useCare.ts`).
   - **Growth stage**: lifetime count of distinct dates with a `day_recorded` row, bucketed into
     stages (proposed: 1 seedling at 0, 2 sprouting at 7, 3 leafy at 30, 4 blooming at 90). A quiet
     stretch never shrinks the companion. A reversed ledger row (`status = 'reversed'`) does not
     count, so a correction that removes a recorded day can, rarely, drop a stage; computed on
     read, that is accepted rather than stored. If it ever shows, the stored row below keeps the
     highest stage reached.
3. **Stored only if reading gets slow.** If the read ever has to scan too far, add one row per
   account (`care_progress (user_id pk, longest_streak, stage, stage_reached_at, rev)`), written
   only by the server function that already holds the `:care_points` lock. Not built now.

Wire contract (to add to `lib/care/contract.ts` when built): `CareProgress = { streakDays: number;
days: boolean[]; stage: 1 | 2 | 3 | 4; countedDays: number }`, returned as a `progress` field on
`GET /api/care/points` (which already syncs the ledger for the account's day before answering).

## Sync path

- The companion choice syncs through the op log: `user_settings` op → `/api/sync/ops` →
  `_sync_upsert` (the `mascot` branch added in `20261225090000`, still in the current body,
  `20261230090400_recipe_energy_rule.sql`).
- Everything else in care is server-computed and read through `app/api/care/*`, never written by
  the phone: `GET /api/care/points` runs `care_points_sync` for the account's day (`resolveCareDay`,
  `lib/server/care-zone.ts`) and answers `{ balance, pending, recent }`; `GET /api/care/shop`
  answers items, owned, equipped and `rev`; purchases and equips go through `care_purchase` and
  `care_equip` (the shop read also carries `balance`); messages through `GET /api/care/messages` and `care_message_mark`. Shapes live in
  `lib/care/contract.ts`; the phone reads them in `components/today/care/care-api.ts` and
  `useCare.ts`.
- Streak and growth follow the same path: derived in SQL from the ledger under the account's own
  zone, returned on the points read, never sent by the phone.

## Who writes `streak` messages

Only the server. `care_messages` grants `authenticated` select only; inserts are the service role
or a `security definer` function. The proposed writer is `care_points_sync` itself, right after it
awards a `day_recorded` row, at most one `streak` message per milestone per local week (so at most
three a week):

- when the week's beads reach 3, 5 and 7 recorded days (one message each, keyed by week and count so
  a repeat sync writes nothing);
- payload `{ text, days }`, where `days` is the 7-bead array and `text` is one line from the
  approved copy list below.

No message is written for a missed day, a broken streak or a falling count.

## Copy rules (OD19 and the care rules)

From OD19 (`docs/decisions/2026-10-12-owner-decisions.md`) and the existing care modules:

- OD19: a food or water shortfall never makes the companion sad. It reacts negatively only when
  poked (`components/today/scene/sulk.ts`).
- Care rule (this spec): a missed or unrecorded day never makes it sad either.
- The words observe. They never tell anyone to eat, eat less, drink or log, and never mention
  weight, calories or a target missed.
- No loss framing: no "don't break your streak", no "you lost", no countdowns, no decay. A streak
  that ends is not mentioned; the next recorded day starts a new one quietly.
- Nothing is earned by eating less, and nothing buys back affection (`catalog.ts` header).
- Lines use the chosen companion's name (`named` in `components/today/island/mascots.ts`).
- Draft lines for review: "Three days recorded this week." / "Five days this week. {Name} noticed."
  / "Every day this week, recorded." / growth: "{Name} has grown a new leaf."

## Devin rules on copy

Devin approves or edits, before any `streak` message or growth line ships:

1. The four draft lines above, word for word.
2. Whether the bead count (3, 5, 7) triggers a message at all, or only the 7th day does.
3. The growth stage names and thresholds (7, 30, 90 recorded days).
4. Whether the streak number itself is ever shown, or only the beads.

Until he rules, the build ships the read (`progress`) without writing any `streak` message.
