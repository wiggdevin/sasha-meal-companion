-- AI-integration audit P2 #15: the weekly review runs on each account's own Sunday evening and
-- lands with a badge. Additive only; nothing existing is rewritten.

-- The local week (its Monday) a weekly-review message reviews. Null on every other message and on
-- reviews written before this migration, which the guard below therefore never compares.
alter table public.coach_messages add column review_week date;

-- One review per account and local week. The hourly job also holds a job_runs lock per
-- (user, week); this is the backstop when a lock is reclaimed after its review already landed.
create unique index coach_messages_one_weekly_review
  on public.coach_messages (user_id, review_week) where review_week is not null;

-- Set when the server delivers a weekly review into the thread; cleared when the account opens it
-- (GET /api/coach/threads/[id], the user's own RLS update). Null = nothing unread.
alter table public.coach_threads add column unread_at timestamptz;
