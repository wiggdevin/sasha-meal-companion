-- Reverse of 20261210090000_daily_energy.sql: the function first, then the view it reads. Both
-- are derived (no stored data), so nothing is lost. Deploy the app revert BEFORE running this:
-- the energy readers in lib/server select from daily_energy by name.
drop function if exists public.get_daily_energy(uuid, date);
drop view if exists public.daily_energy;
