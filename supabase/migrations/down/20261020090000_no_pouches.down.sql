-- Rollback of 20261020090000_no_pouches. Deliberately a no-op.
--
-- The up migration moves pouch-named foods from 'eats' to 'avoid'. It does not record which rows
-- it touched, and it cannot: a row already on 'avoid' before the migration is indistinguishable
-- afterwards from one the migration moved. Reversing it blind would put every pouch food back on
-- 'eats', including ones Sasha herself had already retired — the exact harm this file exists to
-- avoid.
--
-- 'avoid' is also not a destructive state in this app: nothing is deleted, the note survives, and
-- she can move any single food back to Eats from Foods > Avoids with one tap. That tap is the
-- rollback. If the whole change is ever reverted, revert the app code and let her re-mark the one
-- or two foods she wants; do not run a bulk update here.

do $$
begin
  raise notice 'no_pouches: down migration is a documented no-op — see the header';
end
$$;
