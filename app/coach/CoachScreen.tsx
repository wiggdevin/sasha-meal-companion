"use client";

/* The Coach tab's mount: the chat (components/coach/CoachConversation, shared with the dock's chat
   overlay) under the assistant header, or the unavailable card when the coach is off. */

import { useCapabilities } from "@/components/CapabilitiesProvider";
import CoachConversation from "@/components/coach/CoachConversation";
import CoachFrame from "@/components/coach/CoachFrame";
import CoachHeader, { ConversationCount } from "@/components/coach/CoachHeader";
import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import UnreadDot from "@/components/ui/UnreadDot";
import { UNREAD_SUFFIX, useHasUnread } from "@/components/coach/unread-threads";
import type { ChatScope } from "@/components/dock/chat-scope";
import { ASSISTANT_NAME } from "@/lib/brand";

export {
  cachedCoachThread, rememberCoachThread, resumeChat, subscribeCoachResume,
} from "@/components/coach/coach-resume";

/** On /coach itself an ask is about anything (owner, 2026-10-04: global-bound). */
const GLOBAL: ChatScope = { kind: "global" };

function Bar({ children }: { children: React.ReactNode }) {
  return <div className="ground px-4 pb-3" style={{ paddingTop: "calc(var(--safe-top) + 8px)" }}>{children}</div>;
}

export default function CoachScreen() {
  const { coach } = useCapabilities();
  const unread = useHasUnread();

  return (
    <main className="mx-auto w-full max-w-[390px]">
      {coach ? (
        <CoachConversation scope={GLOBAL} variant="page" renderHeader={({ thinking, count, openConversations }) =>
          <Bar><CoachHeader variant="page" scope={GLOBAL} thinking={thinking}
            trailing={<Button variant="secondary" size="sm" onClick={openConversations}
              aria-label={[count > 0 ? `Conversations, ${count} saved` : "Conversations",
                unread ? UNREAD_SUFFIX : null].filter(Boolean).join(", ")}>
              Conversations{count > 0 && <ConversationCount count={count} />}
              <UnreadDot show={unread} className="ml-1.5" />
            </Button>} /></Bar>} />
      ) : (
        <CoachFrame header={<Bar><CoachHeader variant="page" scope={GLOBAL} thinking={false} /></Bar>}
          transcript={<div className="px-4 py-5">
          <section className="shell">
          <Notice tone="attention" title={`${ASSISTANT_NAME} is unavailable right now. Try again in a minute.`} />
          </section>
        </div>} composer={<div />} />
      )}
    </main>
  );
}
