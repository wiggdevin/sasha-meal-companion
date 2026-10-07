-- architecture §2.2 rule 5 plus the coach's constraints:write. Phase 0 shipped api_tokens
-- with no scope constraint, so there is nothing to drop first — the `drop … if exists`
-- keeps the file re-runnable on a branch that already carries an earlier attempt.
alter table api_tokens drop constraint if exists api_tokens_scopes_known;
alter table api_tokens add constraint api_tokens_scopes_known
  check (scopes <@ array['read','log:write','constraints:write']::text[]);
