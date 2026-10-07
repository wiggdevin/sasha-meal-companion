-- Rolls back 20261118090000_allergen_evidence.sql. Both tables hold derived evidence and the
-- user's own label checks; the policy then falls back to reading legacy tags, which is the
-- pre-Phase-13 behaviour. The user's checks are lost on rollback.
drop table if exists user_allergen_checks;
drop table if exists food_allergen_evidence;
drop table if exists _p13_allergen_alias;
drop table if exists _p13_allergen_key;
drop function if exists public._validate_allergen_check_food_key();
-- finding #1 (FIX): the monotonic-write guard's trigger function and its rank helper. The trigger
-- itself is dropped along with food_allergen_evidence above.
drop function if exists public._p13_monotonic_allergen_evidence();
drop function if exists public._p13_allergen_evidence_rank(text);
