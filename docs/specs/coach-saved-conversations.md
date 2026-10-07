# Saved Coach conversations

Coach supports eight active, user-created chats per account. A ninth chat is refused with
`409 chat_limit` and asks the person to continue an existing chat. The database insert trigger
serializes concurrent inserts for one account. It never deletes or rewrites old chats: accounts
already over eight retain every existing row and transcript, but cannot create another chat
until they are below the cap. Existing thread deletion remains available through the old API;
the new picker does not introduce an archive or delete action.

PlanSheet now sends `surface: "plan"` on all of its turns. Its server-created threads have
`kind: "plan"`, are private working transcripts, and do not appear in the Coach picker or
count toward eight. Existing `kind: "chat"` PlanSheet rows are left as they were because a
title or text heuristic cannot safely prove provenance. The old weekly review kind remains.
The database rejects direct authenticated inserts of non-chat kinds and fixes kind after
creation. A continued turn must match its thread kind and account.

The visible chat picker selects one saved chat or starts a blank chat. The server transcript
continues to page by sequence (50 messages per request); local storage remains only a recent
cache. The selected chat pointer is account-scoped and is accepted only if an active owned chat
appears in the fresh list. A new blank chat is persisted with its first saved turn, so failed
first turns do not consume the eight-chat allowance.

The explicit “Ask from history” source picker sends `historySourceThreadId` with a text turn.
The server verifies the source is an active chat of the signed-in account before querying
messages. Indexed full-text search covers the whole retained transcript; broad prompts show
the latest saved excerpts. Up to four matching messages enter one bounded, read-only Coach
synthesis call, using the existing attested model route and spend limits. A reply with missing
or invalid numbered citations falls back to labeled saved excerpts. No action, meal card,
draft, or current-day claim is produced by this path. Source IDs are saved beside the reply;
the citation endpoint resolves quoted evidence only against a currently owned, active source.
The cited excerpts are evidence for review, not a claim that the model's synthesis has been
independently fact-checked.

A clear, single question about the past conversation also uses the same read-only lookup
for the current active chat, including a bounded window of adjacent messages. Mixed questions
that request a current action stay on the normal Coach path. Historical food mentions are
shown as dated evidence instead of being checked as new meal recommendations.

The migration is `20261126090000_coach_conversations.sql`. Apply it with the repo's normal
reviewed migration procedure. It preserves all existing rows and adds a GIN search index.
