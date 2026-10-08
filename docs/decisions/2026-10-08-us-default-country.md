# Ruling 2026-10-08 — onboarding preselects a visible "I'm in the U.S." choice

Owner: Devin, through the orchestrator's decision log
(`~/.claude/goal-state/sasha-phase18/decisions.log`, 2026-10-08, "QUESTION SET v2 defaults
adopted", item 4). Question set: onboarding v2 `QUESTION-SET-v2.md` §9 Q4 and gap G13.

## Owner statement

All users are in the U.S. Onboarding may show one visible, pre-selected chip, **"I'm in the
U.S."**, so the U.S. population prior can apply. Settings can change it.

## What this permits

- Onboarding shows the country as one chip, pre-selected, on screen with the rest of the plan
  answers. The user can switch it off or pick another country before "Use this plan", and can
  change or clear it in Settings at any time.
- Leaving the chip on writes `user_settings.country_code = 'US'` through the existing settings
  sync op, the same field and the same omit/null rule as Settings (W5). Switching it off writes
  `null` (or the country the user picked).
- The chip is the user's explicit, editable choice. It is **not inference**: the value never comes
  from the time zone, the IP address, the locale, the phone's region, geolocation or any model.
  An account that never saw the chip (an older onboarding, a skipped flow) keeps `null` and the
  neutral prior until the user picks a country.

## What does not change

- Phase 18 D2 and spec §216 still hold: no state or region question, no race or ethnicity field,
  no required country screen (the chip is one control on an existing screen, and the flow does not
  stop on it).
- The U.S. prior applies only to `country_code = 'US'`, and only under the NCHS gate
  (`docs/decisions/2026-10-05-nhanes-aggregate-use.md`). Every other value, and `null`, is neutral.
- No AI payload carries `country_code` (`tests/ai/no-demographics-payload.test.ts`).
- Existing accounts are not backfilled. A U.S. value reaches an existing account only when its user
  sets one in Settings.

## Supersedes

The "Country is Settings-only" wording in `AGENTS.md` (the profile-pilot row) and in
`lib/server/profile-pilot.ts`'s header, and question set §1e's "Country → Settings" row: the
country is settable in Settings **and** as the one pre-selected onboarding chip described here.
