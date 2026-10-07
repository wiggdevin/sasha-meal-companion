-- T1 (docs/plans/2026-09-17-t1-avoid-list-policy.md) §4: the five switches are on.
--
-- `banned_categories` has defaulted to `{simple_sugars}` since the Phase 0 shell
-- (20260911000200_user_schema.sql), and no migration ever set the other four. So Foods > Avoids
-- rendered five rules from lib/reference.ts and enforced one, and she had no way to tell which.
-- All five are her stated rules (targets.md §2, §8), so all five are the default and all five are
-- added to any row that is missing one.
--
-- `rev` IS bumped, and that is the point. It is the compare-and-swap arbiter for
-- PUT /api/constraints (lib/server/constraints.ts). A tab that loaded her profile BEFORE this
-- migration still holds `{simple_sugars}` and the old rev; saving a condition from it afterwards
-- would PUT that one-key array at a rev the server still matched, switching four rules back off
-- with nothing said. The bump makes that save answer `conflict`, and components/AvoidRules.tsx
-- already renders "Your rules changed elsewhere. Check them and try again." for exactly that.

alter table constraint_profiles
  alter column banned_categories
  set default '{raw_cruciferous,raw_leafy_greens,onion_garlic,beans,simple_sugars}';

update constraint_profiles
   set banned_categories = (
         select array_agg(distinct key order by key)
           from unnest(banned_categories
                       || '{raw_cruciferous,raw_leafy_greens,onion_garlic,beans,simple_sugars}'::text[])
                as key),
       rev = rev + 1
 where not (banned_categories
            @> '{raw_cruciferous,raw_leafy_greens,onion_garlic,beans,simple_sugars}'::text[]);
