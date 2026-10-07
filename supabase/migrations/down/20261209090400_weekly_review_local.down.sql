-- Reverse of 20261209090400_weekly_review_local.sql. The unread mark and the review week are
-- derived bookkeeping: dropping them loses no review text.
alter table public.coach_threads drop column if exists unread_at;
drop index if exists public.coach_messages_one_weekly_review;
alter table public.coach_messages drop column if exists review_week;
