"use client";

import { useState } from "react";
import Button from "@/components/ui/Button";
import CareShop from "@/components/today/care/shop/CareShop";
import type { ShopState } from "@/components/today/care/shop/shop-state";
import styles from "@/app/design/ShopGallery.module.css";

const TODAY = "2026-10-07";

/** Sample Seeds and a leaf pin already on: what GET /api/care/shop will answer (UI-NEEDS SPROUT-CARE). */
const SAMPLE: ShopState = {
  balance: 42,
  owned: ["leaf-pin"],
  equipped: { pin: "leaf-pin" },
  rev: 1,
  receipts: {},
  ledger: [
    { id: "w1", kind: "water_goal", delta: 1, localDate: TODAY, status: "pending" },
    { id: "d1", kind: "day_recorded", delta: 2, localDate: TODAY, status: "pending" },
    { id: "c6", kind: "day_complete", delta: 2, localDate: "2026-10-06", status: "settled" },
    { id: "p6", kind: "protein_goal", delta: 1, localDate: "2026-10-06", status: "settled" },
    { id: "d6", kind: "day_recorded", delta: 2, localDate: "2026-10-06", status: "settled" },
    { id: "f5", kind: "five_day_week", delta: 5, localDate: "2026-10-05", status: "settled" },
  ],
};

/** Sprout's shop in a stand-in for the open well, on samples that never touch the account (2026-10-07). */
export default function ShopGallery() {
  const [state, setState] = useState<ShopState>(SAMPLE);
  return <main className="mx-auto flex max-w-[420px] flex-col gap-6 px-4 py-8">
    <h1 className="m-0 text-title text-charcoal">Sprout&apos;s shop</h1>
    <section aria-label="The open well" className={`matte ${styles.well}`}>
      <CareShop state={state} onChange={setState} today={TODAY} />
    </section>
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" onClick={() => setState(SAMPLE)}>Reset</Button>
      <Button variant="secondary" size="sm" onClick={() => setState((s) => ({ ...s, balance: s.balance + 25 }))}>Sample: +25 Seeds</Button>
      <Button variant="secondary" size="sm" onClick={() => setState((s) => ({ ...s, balance: 3 }))}>Sample: 3 Seeds</Button>
    </div>
  </main>;
}
