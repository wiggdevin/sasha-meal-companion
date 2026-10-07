-- Second (and last) step of the rollback: validates, in its own transaction, the check
-- 20261224090100's down file added NOT VALID (Sol r2 WARN — see that file's header for why the
-- two steps are split this way). VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE (reads and
-- writes continue) for one scan of user_settings; the exists-check that proved this scan will
-- pass already ran in the prior step.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

alter table public.user_settings validate constraint user_settings_sex_check;

comment on column public.user_settings.sex is null;
