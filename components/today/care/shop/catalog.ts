/**
 * Sprout's shop (owner, 2026-10-07: "a shop with items … bought with points"; names and prices from
 * GPT-6 Astra's card spec §5). Points are Seeds, earned for taking care of yourself on the server's
 * ledger (UI-NEEDS SPROUT-CARE): no cash value, no loot boxes, no decay, nothing that buys back
 * affection, and nothing earned by eating less. Presentation only: what a person owns and wears comes
 * from the server; the gallery plays it on samples.
 *
 * Every wearable is a painted layer placed on Sprout's content pose (the 768 px hero art), never a
 * Sprout re-drawn per outfit (Astra §5): `places` are its boxes in that art's pixels.
 */

export type Slot = "head" | "eyes" | "hands" | "legs" | "pin" | "care";

/** A care scene: something done for Sprout, not worn; it plays, and plays again whenever asked. */
export type CareScene = "massage";

/** One painted part: its centre and width in the 768 px art, a turn in degrees, and a mirror. */
export type Place = { x: number; y: number; w: number; rotate?: number; mirror?: boolean };

export type ShopItem = {
  id: string;
  name: string;
  slot: Slot;
  /** Seeds. */
  price: number;
  art: string;
  /** The art's own width over height, so a part keeps its shape at any size. */
  aspect: number;
  places: Place[];
  /** Worn on the head: Sprout's leaf is drawn again over it, so the sprout grows through. */
  underLeaf?: boolean;
  /** Clipped to Sprout's own outline, so it follows the body (shorts). */
  clipToBody?: boolean;
  /** A plural noun ("the mittens are"), for the words said about it. */
  plural?: boolean;
  /** A care item (slot "care"): the scene it plays. It has no places; it is never worn. */
  scene?: CareScene;
};

/** The order parts are drawn in, back to front; the leaf goes over the head slot. */
export const SLOTS: readonly { slot: Slot; label: string }[] = [
  { slot: "legs", label: "Legs" },
  { slot: "hands", label: "Hands" },
  { slot: "pin", label: "Pin" },
  { slot: "eyes", label: "Eyes" },
  { slot: "head", label: "Head" },
];

/** Sprout's leaf alone, in the content pose's 768 px frame (drawn over a hat). */
export const SPROUT_LEAF = "/pet/shop/sprout-leaf.webp";

export const SHOP_ITEMS: readonly ShopItem[] = [
  { id: "leaf-pin", name: "Leaf pin", slot: "pin", price: 10, art: "/pet/shop/leaf-pin.webp", aspect: 1.714,
    places: [{ x: 500, y: 466, w: 64, rotate: 12 }] },
  { id: "mittens", name: "Mittens", plural: true, slot: "hands", price: 20, art: "/pet/shop/mitten.webp", aspect: 0.758,
    places: [{ x: 150, y: 492, w: 118, rotate: -18, mirror: true }, { x: 622, y: 484, w: 118, rotate: 18 }] },
  { id: "bucket-hat", name: "Bucket hat", slot: "head", price: 25, art: "/pet/shop/bucket-hat.webp", aspect: 1.648,
    places: [{ x: 384, y: 176, w: 330, rotate: -6 }], underLeaf: true },
  { id: "knitted-hat", name: "Knitted hat", slot: "head", price: 25, art: "/pet/shop/knitted-hat.webp", aspect: 1.005,
    places: [{ x: 384, y: 146, w: 292 }], underLeaf: true },
  { id: "glasses", name: "Round glasses", plural: true, slot: "eyes", price: 30, art: "/pet/shop/glasses.webp", aspect: 2.56,
    places: [{ x: 420, y: 362, w: 300 }] },
  { id: "sunglasses", name: "Sunglasses", plural: true, slot: "eyes", price: 35, art: "/pet/shop/sunglasses.webp", aspect: 2.233,
    places: [{ x: 420, y: 362, w: 310 }] },
  { id: "shorts", name: "Shorts", plural: true, slot: "legs", price: 40, art: "/pet/shop/shorts.webp", aspect: 1.6,
    places: [{ x: 386, y: 668, w: 520 }], clipToBody: true },
  { id: "massage", name: "Massage", slot: "care", price: 30, art: "/pet/care/massage-1.webp", aspect: 1.286,
    places: [], scene: "massage" },
];

export const itemById = (id: string): ShopItem | undefined => SHOP_ITEMS.find((item) => item.id === id);

/** "the bucket hat is" / "the mittens are", and "it" / "them", for what is said about an item. */
export const words = (item: ShopItem) => ({
  the: `the ${item.name.toLowerCase()}`,
  is: item.plural ? "are" : "is",
  it: item.plural ? "them" : "it",
});

/** What earned or spent Seeds (the server ledger's `kind`). Copy observes; nothing rewards eating less. */
export type LedgerKind = "day_recorded" | "day_complete" | "protein_goal" | "water_goal" | "weigh_in_week"
  | "five_day_week" | "purchase";

export const LEDGER_COPY: Record<LedgerKind, string> = {
  day_recorded: "A day recorded",
  day_complete: "Day marked complete",
  protein_goal: "Protein goal recorded",
  water_goal: "Water goal recorded",
  weigh_in_week: "Three weigh-in days",
  five_day_week: "Five days this week",
  purchase: "Bought",
};

export type LedgerRow = {
  id: string;
  kind: LedgerKind;
  delta: number;
  /** The account's local date, YYYY-MM-DD. */
  localDate: string;
  /** Daily awards settle after the account's day closes (Astra §5). */
  status: "pending" | "settled" | "reversed";
  itemId?: string;
};
