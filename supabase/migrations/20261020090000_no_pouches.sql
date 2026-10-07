-- Fruit pouches are off the plan (2026-09-18, Devin's instruction: they make her bloat).
--
-- The app half of this change replaces the `pouches-pre` options with real-food carbs and drops
-- the fruit-pouch food from `lib/foods.ts`. That only fixes what the seed offers. Anything she
-- already marked as an Eats food on the phone lives in `user_foods`, and its Eats/Avoid state
-- lives in `user_food_prefs`, keyed by `food_refs.id` — so a pouch she added herself would still
-- read "eats" and still pass `evaluatePolicy`'s avoid-list check.
--
-- So: every user's pouch-named food moves to `avoid`. Nothing is deleted — "avoid" is how this
-- app retires a food (lib/foods.ts header), and the row keeps its note so it can come back if she
-- ever tolerates one.
--
-- Idempotent: the `status <> 'avoid'` guard means a second run touches nothing and reports 0.
--
-- `rev` is bumped for the same reason 20261018090100 bumps it: the sync layer
-- (lib/foods/prefs-client.ts) writes prefs newer-wins by rev, and a phone holding the old rev
-- must not push 'eats' back over this.

do $$
declare
  moved integer;
begin
  update user_food_prefs p
     set status = 'avoid',
         rev = p.rev + 1,
         updated_at = now()
    from food_refs r
    join user_foods f on f.id = r.user_food_id
   where r.id = p.food_ref_id
     and r.kind = 'user'
     and f.name ilike '%pouch%'
     and p.status <> 'avoid';

  get diagnostics moved = row_count;
  raise notice 'no_pouches: moved % user_food_prefs row(s) to avoid', moved;
end
$$;
