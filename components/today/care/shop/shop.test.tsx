// @vitest-environment jsdom
/**
 * Sprout's shop (owner, 2026-10-07): Seeds buy items for Sprout, who tries them on and wears them.
 * The rules mirror the server contract asked for in UI-NEEDS SPROUT-CARE: a purchase is idempotent on
 * its action id, the balance never goes below zero, and only an owned item is worn, in its own slot.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { useState } from "react";
import CareShop from "./CareShop";

const sound = vi.hoisted(() => ({ play: vi.fn(), unlockAudio: vi.fn(), muted: false }));
vi.mock("@/components/today/care/sound", () => ({
  play: sound.play, unlockAudio: sound.unlockAudio, readMuted: () => sound.muted, silence: () => {},
}));
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEAVES, LEDGER_COPY, SHOP_ITEMS, SLOTS, itemById, placesFor } from "./catalog";
import { MASCOTS, MASCOT_KEYS } from "@/components/today/island/mascots";
import { equip, pendingSeeds, purchase, seeds, type ShopState } from "./shop-state";

const SHOP_CSS = readFileSync(join(process.cwd(), "components/today/care/shop/Shop.module.css"), "utf8");

/** A click that lets the shop's rules (async, so the server can decide on Today) settle. */
const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };

afterEach(() => { cleanup(); sound.play.mockClear(); sound.unlockAudio.mockClear(); sound.muted = false; });

const START: ShopState = {
  balance: 42, owned: ["leaf-pin"], equipped: { pin: "leaf-pin" }, rev: 1, receipts: {},
  ledger: [{ id: "d1", kind: "day_recorded", delta: 2, localDate: "2026-10-07", status: "pending" },
    { id: "c6", kind: "day_complete", delta: 2, localDate: "2026-10-06", status: "settled" }],
};

describe("the shop's rules", () => {
  it("debits and grants at once, and a retry with the same action id answers the first receipt", () => {
    const first = purchase(START, "bucket-hat", "a1", "2026-10-07");
    expect(first.ok && first.receipt).toEqual({ actionId: "a1", itemId: "bucket-hat", price: 25, balance: 17 });
    if (!first.ok) throw new Error("expected a purchase");
    expect(first.state.owned).toContain("bucket-hat");
    expect(first.state.ledger[0]).toMatchObject({ kind: "purchase", delta: -25, status: "settled" });
    const again = purchase(first.state, "bucket-hat", "a1", "2026-10-07");
    expect(again.ok && again.replay).toBe(true);
    expect(again.ok && again.state.balance).toBe(17);
    expect(purchase(first.state, "glasses", "a1", "2026-10-07")).toEqual({ ok: false, code: "action_conflict" });
  });

  it("never lets the balance go below zero, and never sells an item twice", () => {
    expect(purchase({ ...START, balance: 20 }, "sunglasses", "a2", "2026-10-07")).toEqual({ ok: false, code: "insufficient", short: 15 });
    expect(purchase(START, "leaf-pin", "a3", "2026-10-07")).toEqual({ ok: false, code: "owned" });
    expect(purchase(START, "a-unicorn", "a4", "2026-10-07")).toEqual({ ok: false, code: "unknown_item" });
  });

  it("wears only an owned item, only in its own slot, and takes it off", () => {
    expect(equip(START, "head", "bucket-hat")).toEqual({ ok: false, code: "not_owned" });
    expect(equip(START, "eyes", "leaf-pin")).toEqual({ ok: false, code: "wrong_slot" });
    const off = equip(START, "pin", null);
    expect(off.ok && off.state.equipped.pin).toBeUndefined();
    expect(off.ok && off.state.rev).toBe(2);
  });

  it("counts pending Seeds and says Seeds in words", () => {
    expect(pendingSeeds(START)).toBe(2);
    expect(seeds(1)).toBe("1 Seed");
    expect(seeds(1250)).toBe("1,250 Seeds");
  });

  it("has a place for every item, in a known slot, and copy that never rewards eating less", () => {
    const slots = new Set(SLOTS.map((s) => s.slot));
    for (const item of SHOP_ITEMS) {
      // A wearable has a place on Sprout; a care item has a scene instead.
      if (item.slot === "care") expect(item.scene).toBeTruthy();
      else {
        expect(slots.has(item.slot)).toBe(true);
        expect(item.places.length).toBeGreaterThan(0);
      }
      expect(item.price).toBeGreaterThan(0);
    }
    for (const line of Object.values(LEDGER_COPY)) expect(line).not.toMatch(/\b(less|under|fast|skip|calorie)/i);
  });

  it("fits every wearable on every companion, except a hat on Pod, over the 768 px art", () => {
    for (const item of SHOP_ITEMS.filter((entry) => !entry.scene)) {
      for (const mascot of MASCOT_KEYS) {
        const places = placesFor(item, mascot);
        if (mascot === "peapod" && item.slot === "head") { expect(places).toBeNull(); continue; }
        expect(places, `${item.id} on ${mascot}`).not.toBeNull();
        for (const place of places ?? []) {
          // The part's box overlaps the art (shorts may hang below it: they are clipped to the body).
          const h = place.w / item.aspect;
          expect(place.x).toBeGreaterThan(0); expect(place.x).toBeLessThan(768);
          expect(place.y + h / 2).toBeGreaterThan(0); expect(place.y - h / 2).toBeLessThan(768);
          expect(place.w).toBeGreaterThan(0);
        }
      }
    }
    // Every leaf drawn over a hat, and every outline a pair of shorts is clipped to, is a real file.
    for (const src of Object.values(LEAVES)) expect(existsSync(join(process.cwd(), "public", src!))).toBe(true);
    for (const mascot of MASCOT_KEYS) {
      expect(existsSync(join(process.cwd(), "public", MASCOTS[mascot].art.content))).toBe(true);
      if (mascot !== "sprout") expect(SHOP_CSS).toContain(`[data-mascot="${mascot}"]`);
    }
  });
});

function Harness({ start }: { start: ShopState }) {
  const [state, setState] = useState(start);
  return <CareShop state={state} onChange={setState} today="2026-10-07" />;
}
const shop = (start = START) => render(<MotionConfig reducedMotion="always"><Harness start={start} /></MotionConfig>);
const live = () => document.querySelector("[aria-live]")?.textContent;

describe("CareShop", () => {
  it("tries an item on, buys it with its price and the balance after in words, and puts it on", async () => {
    shop();
    await click(screen.getByRole("button", { name: "Bucket hat, 25 Seeds" }));
    expect(screen.getByText("Balance after: 17 Seeds.")).toBeTruthy();
    expect(screen.getByRole("img", { name: /wearing leaf pin, bucket hat/ })).toBeTruthy();
    await click(screen.getByRole("button", { name: "Buy the bucket hat for 25 Seeds" }));
    expect(live()).toBe("The bucket hat is yours, and Sprout has it on. 17 Seeds.");
    expect(screen.getByRole("button", { name: /17 Seeds/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bucket hat, yours, on Sprout" })).toBeTruthy();
  });

  it("speaks of a pair in the plural", async () => {
    shop();
    await click(screen.getByRole("button", { name: "Mittens, 20 Seeds" }));
    await click(screen.getByRole("button", { name: "Buy the mittens for 20 Seeds" }));
    expect(live()).toBe("The mittens are yours, and Sprout has them on. 22 Seeds.");
  });

  it("will not buy what the Seeds do not cover, and says how many more", async () => {
    shop({ ...START, balance: 3 });
    await click(screen.getByRole("button", { name: "Sunglasses, 35 Seeds" }));
    expect(screen.getByText("32 Seeds more to go.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Buy the sunglasses for 35 Seeds" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("takes an owned item off and puts it back on", async () => {
    shop();
    await click(screen.getByRole("button", { name: "Leaf pin, yours, on Sprout" }));
    await click(screen.getByRole("button", { name: "Take off" }));
    expect(live()).toBe("Sprout takes off the leaf pin.");
    await click(screen.getByRole("button", { name: "Leaf pin, yours" }));
    await click(screen.getByRole("button", { name: "Wear" }));
    expect(live()).toBe("Sprout puts on the leaf pin.");
  });

  it("keeps keyboard focus on the action button when Buy turns into Take off", async () => {
    shop();
    await click(screen.getByRole("button", { name: "Bucket hat, 25 Seeds" }));
    const buyBtn = screen.getByRole("button", { name: "Buy the bucket hat for 25 Seeds" });
    buyBtn.focus();
    await click(buyBtn);
    // The slot now reads Take off: focus must have stayed on the same button, not fallen to <body>.
    expect(document.activeElement?.textContent).toBe("Take off");
  });

  it("returns focus to the item's tile when Take off empties the action row", async () => {
    shop();
    await click(screen.getByRole("button", { name: "Leaf pin, yours, on Sprout" }));
    await click(screen.getByRole("button", { name: "Take off" }));
    // Take off deselects (nothing left to preview), so the action row disappears; focus must land
    // back on the leaf pin's own tile rather than falling through to the page.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Leaf pin, yours" }));
  });

  it("says Sprout tries on an owned-but-unworn item too, and clears the line on deselect", async () => {
    shop({ ...START, owned: [...START.owned, "bucket-hat"] });
    await click(screen.getByRole("button", { name: "Bucket hat, yours" }));
    expect(live()).toBe("Sprout tries on the bucket hat.");
    await click(screen.getByRole("button", { name: "Bucket hat, yours" }));
    expect(live()).toBe("");
  });

  it("shows recent Seeds from the balance, pending ones as tonight", async () => {
    shop();
    const balance = screen.getByRole("button", { name: /42 Seeds\. Show recent Seeds/ });
    expect(balance.getAttribute("aria-expanded")).toBe("false");
    await click(balance);
    const ledger = screen.getByRole("region", { name: "Recent Seeds" });
    expect(ledger.textContent).toContain("A day recorded");
    expect(ledger.textContent).toContain("tonight");
    expect(itemById("leaf-pin")?.name).toBe("Leaf pin");
  });
});

describe("the purchase chime (Sol r1)", () => {
  const buyHat = async (motion: "never" | "always") => {
    render(<MotionConfig reducedMotion={motion}><Harness start={START} /></MotionConfig>);
    await click(screen.getByRole("button", { name: "Bucket hat, 25 Seeds" }));
    await click(screen.getByRole("button", { name: "Buy the bucket hat for 25 Seeds" }));
  };

  it("chimes on a purchase when sound is on", async () => {
    await buyHat("never");
    expect(sound.play).toHaveBeenCalledWith("chime");
  });

  it("stays quiet when the shared Sound off is set, or motion is reduced", async () => {
    sound.muted = true;
    await buyHat("never");
    cleanup();
    sound.muted = false;
    await buyHat("always");
    expect(sound.play).not.toHaveBeenCalled();
    expect(sound.unlockAudio).not.toHaveBeenCalled();
  });
});

describe("a reversed award (Sol r1)", () => {
  it("says it was reversed instead of reading as Seeds earned", async () => {
    shop({ ...START, ledger: [{ id: "r1", kind: "protein_goal", delta: 1, localDate: "2026-10-06", status: "reversed" }] });
    await click(screen.getByRole("button", { name: /Show recent Seeds/ }));
    expect(screen.getByRole("region", { name: "Recent Seeds" }).textContent).toContain("reversed, Oct 6");
  });
});

describe("a care scene: the massage (owner's list)", () => {
  it("is done for Sprout, never worn", () => {
    const bought = purchase(START, "massage", "m1", "2026-10-07");
    if (!bought.ok) throw new Error("expected a purchase");
    expect(equip(bought.state, "care", "massage")).toEqual({ ok: false, code: "not_wearable" });
    expect(equip(bought.state, "head", "massage")).toEqual({ ok: false, code: "not_wearable" });
  });

  it("plays at once when bought, says so, and closes with Done; Play brings it back", async () => {
    shop();
    await click(screen.getByRole("button", { name: "Massage, 30 Seeds" }));
    // Selecting it changes nothing Sprout wears.
    expect(screen.getByRole("img", { name: "Sprout, wearing leaf pin" })).toBeTruthy();
    await click(screen.getByRole("button", { name: "Buy the massage for 30 Seeds" }));
    expect(screen.getByRole("dialog", { name: "Care: Massage" })).toBeTruthy();
    expect(live()).toBe("The massage is yours. 12 Seeds.");
    // Reduced motion: the finished frame and its words at once, the frame already in full view (Sol r1).
    expect(screen.getByRole("dialog").textContent).toContain("Sprout feels brand new.");
    const after = [...screen.getByRole("dialog").querySelectorAll("img")].find((img) => img.getAttribute("src")?.includes("massage-2"));
    expect(after?.parentElement?.style.opacity).toBe("1");
    await click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await click(screen.getByRole("button", { name: "Play" }));
    expect(screen.getByRole("dialog", { name: "Care: Massage" })).toBeTruthy();
  });

  it("closes on Escape", async () => {
    shop({ ...START, owned: [...START.owned, "massage"] });
    await click(screen.getByRole("button", { name: "Massage, yours" }));
    await click(screen.getByRole("button", { name: "Play" }));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("cancels its pending plink and sparks when Done is clicked before they fire", async () => {
    vi.useFakeTimers();
    try {
      render(<MotionConfig reducedMotion="never"><Harness start={{ ...START, owned: [...START.owned, "massage"] }} /></MotionConfig>);
      await click(screen.getByRole("button", { name: "Massage, yours" }));
      await click(screen.getByRole("button", { name: "Play" }));
      expect(screen.getByRole("dialog", { name: "Care: Massage" })).toBeTruthy();
      sound.play.mockClear();
      // Closed well before the "after" timer (3800 ms) would otherwise flip the phase and plink.
      await click(screen.getByRole("button", { name: "Done" }));
      act(() => { vi.advanceTimersByTime(5000); });
      expect(sound.play).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
