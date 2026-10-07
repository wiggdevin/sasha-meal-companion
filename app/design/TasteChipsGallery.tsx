"use client";

/**
 * Phase 18 W5b-2 UI: the coach taste-chip confirm card and the Undo-list card it leaves behind, on
 * fixture data only — no account, no sync, no Supabase. Development only
 * (app/design/taste-chips/page.tsx).
 */
import CoachActionCard from "@/components/CoachActionCard";
import TasteChipsCard from "@/components/coach/TasteChipsCard";
import type { CoachAction } from "@/lib/coach/actions";
import type { TasteChipsProposal } from "@/lib/coach/taste-chips-card";
import type { ReactNode } from "react";

const MESSAGE = "3f1b1a2c-0000-4000-8000-0000000000aa";

const PROPOSAL: TasteChipsProposal = {
  kind: "taste_chips_proposal", v: 1, id: "gallery-proposal",
  dislikes: [{ key: "t:soft", label: "Soft textures", p: 0.93 }, { key: "f:mushroom", label: "Mushrooms", p: 0.88 }],
  cuisines: [{ key: "latin_american", label: "Mexican and Latin American", p: 0.86 }],
};

const TASTE_UNDO_ACTION = { kind: "confirm_taste_chips", actionId: "gallery-act-taste", flagged: [] } as unknown as CoachAction;

function Block({ title, children }: { title: string; children: ReactNode }) {
  return <section aria-label={title} className="flex flex-col gap-3">
    <h2 className="m-0 px-1 text-caption font-medium text-charcoal">{title}</h2>
    {children}
  </section>;
}

// Fixture seams (RoleConfirm's `confirm` prop pattern): this proposal is not a real saved card, so
// a signed-in dev session must never let the interactive card hit the live confirm/undo routes.
const fixtureConfirm = async () => ({ ok: false as const, reason: "refused" as const, status: 404,
  code: "unknown_proposal", message: "This is a fixture card — nothing here writes to a real account." });
const fixtureUndo = fixtureConfirm;

export default function TasteChipsGallery() {
  return <div className="flex flex-col gap-8 p-4">
    <Block title="Coach card — idle (nothing written yet)">
      <TasteChipsCard card={PROPOSAL} messageId={MESSAGE} confirm={fixtureConfirm} undo={fixtureUndo} />
    </Block>

    <Block title="Undo list — a receipted confirm_taste_chips record">
      <div className="px-3">
        <CoachActionCard
          action={TASTE_UNDO_ACTION}
          server={{ card: { type: "taste", kind: "confirm_taste_chips", title: "Taste preferences added",
            added: { dislikes: ["t:soft", "f:mushroom"], cuisines: ["latin_american"] }, complete: true },
            createdAt: "2026-10-05T12:00:00Z" }}
          status="applied" canUndo onRetry={() => {}} onUndo={() => {}}
        />
      </div>
    </Block>

    <Block title="Undo list — incomplete (receipt not read)">
      <div className="px-3">
        <CoachActionCard
          action={TASTE_UNDO_ACTION}
          server={{ card: { type: "taste", kind: "confirm_taste_chips", title: "Taste preferences added",
            added: { dislikes: [], cuisines: [] }, complete: false },
            createdAt: "2026-10-05T12:00:00Z" }}
          status="applied" canUndo={false} onRetry={() => {}} onUndo={() => {}}
        />
      </div>
    </Block>
  </div>;
}
