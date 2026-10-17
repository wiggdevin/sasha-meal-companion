# Stale branches to remove (2026-10-17)

Every branch below sat on the history from before the repository moved accounts, so none shares a
merge base with `main` and none can merge. Each one's work is already on `main`, or was parked by an
owner decision. A cloud thread cannot delete branches, so the Mac session removes them. Keep each
head as a tag first so nothing is lost:

```sh
for b in chore/genai-2-28-0 claude/project-thread-p7jn28 feat/cards-redesign-v4 \
  wip/2026-10-08-account-deletion wip/2026-10-08-duplicate-card wip/2026-10-08-voice-retire-account-zone; do
  git push origin "origin/$b:refs/tags/archive/$b" && git push origin --delete "$b"
done
```

Restore one with `git push origin archive/<branch>:refs/heads/<branch>`.

| Branch | Head | Why it is stale |
|---|---|---|
| `chore/genai-2-28-0` | `732f57e` | `@google/genai` 2.28.0 is on `main` (`package.json`); the other commits are old merged PRs. |
| `claude/project-thread-p7jn28` | `23c0302` | W069 API parsers merged as #194. |
| `feat/cards-redesign-v4` | `16f7c10` | Cards v4 parked by owner decision (2026-10-17); kept as a tag only. |
| `wip/2026-10-08-account-deletion` | `893dfb5` | Account deletion is on `main` (`20261231230000_delete_account`, behind `ACCOUNT_DELETION_ENABLED`). |
| `wip/2026-10-08-duplicate-card` | `3d60f3a` | The "Logged twice?" card is on `main` (`components/today/DuplicateEntryCard.tsx`). |
| `wip/2026-10-08-voice-retire-account-zone` | `73ff98e` | The voice cleanup is on `main` (`20270102090000_voice_ears_cleanup`). |
