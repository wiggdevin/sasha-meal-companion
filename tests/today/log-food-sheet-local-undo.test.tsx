// @vitest-environment jsdom
/**
 * A pick or meal the commit did not send stays on this phone as a `localOnlyCard`
 * (lib/log/picked-commit.ts): `localOnly: true`, no revision, every line under a `local:` ref. Undo
 * (lib/log/delete-entry.ts `forgetLoggedEntry`) then owes the server nothing — including a single
 * catalog pick, whose `foodId` keeps its `catalog:` id. Driven through the sheet, then deleted for
 * real against fake IndexedDB.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CachedRevision } from "@/lib/db/catalog-cache";
import { unbindAccount, type AccountHandle } from "@/lib/device/account";
import { forgetLoggedEntry } from "@/lib/log-commit-client";
import { mealCard } from "@/lib/log/meal-card";
import { readPending } from "@/lib/log/pending";
import { resetFoodRefCache } from "@/lib/log-client";
import { addExtra, getDay } from "@/lib/store";
import type { LoggedFood } from "@/lib/types";
import { resetTestAccount } from "@/tests/helpers/account";

const CATALOG_REF = "cccccccc-3333-4333-8333-333333333333";
const commit = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/components/FavoritesStrip", () => ({ default: () => null }));
vi.mock("@/lib/supabase/client", () => ({
  browserClient: () => { throw new Error("the server must not be asked about a local entry"); },
}));
vi.mock("@/components/Sheet", () => ({
  default: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) =>
    <div>{children}{footer}</div>,
  Pill: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    <button type="button" onClick={onClick}>{children}</button>,
}));
vi.mock("@/components/CatalogSearch", () => ({
  default: ({ onPick }: { onPick: (row: unknown) => void }) => (
    <button type="button" onClick={() => onPick({ key: "c7", catalogFoodId: 7, revisionId: 910,
      description: "Bread", brand: null, sourceTile: "USDA", prefStatus: null, qualityFlags: [],
      offPlan: [], offline: false, score: 1 })}>Catalog bread</button>
  ),
}));
vi.mock("@/lib/catalog-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/catalog-client")>();
  return { ...actual, getFoodDetail: vi.fn(async () => ({ kind: "cached", revision: REVISION })) };
});
vi.mock("@/lib/log-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log-client")>();
  return { ...actual, resolveFoodRef: vi.fn(async () => CATALOG_REF) };
});
vi.mock("@/lib/log-commit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/log-commit-client")>();
  return { ...actual, commitLogEntry: commit };
});

const REVISION = {
  revision_id: 910, catalog_food_id: 7, description: "Bread", brand: null,
  source: "fdc_branded", version_label: "v1",
  per_100g: { energy_kcal: 265, protein: 9, carbohydrate: 49, fat_total: 3.2 }, portions: [],
  cached_at: "2026-11-02T17:00:00.000Z",
} as unknown as CachedRevision;

let h: AccountHandle;
let savedFlag: string | undefined;

beforeEach(async () => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  h = await resetTestAccount();
  resetFoodRefCache();
  savedFlag = process.env.NEXT_PUBLIC_CATALOG_SEARCH;
  process.env.NEXT_PUBLIC_CATALOG_SEARCH = "1";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (savedFlag === undefined) delete process.env.NEXT_PUBLIC_CATALOG_SEARCH;
  else process.env.NEXT_PUBLIC_CATALOG_SEARCH = savedFlag;
});

/** Pick the catalog bread, sign out, tap the confirm button; the card the sheet hands Today. */
async function signedOutLog(mode: "food" | "meal"): Promise<LoggedFood> {
  const { default: LogFoodSheet } = await import("@/components/LogFoodSheet");
  const onAdd = vi.fn();
  render(<LogFoodSheet mode={mode} mine={{}} slot="meal-1" onAdd={onAdd}
    onSomethingElse={() => {}} onClose={() => {}} onCapture={() => {}} />);
  if (mode === "meal") fireEvent.click(screen.getByRole("button", { name: "Add a food to this meal" }));
  fireEvent.click(screen.getByRole("button", { name: "Catalog bread" }));
  const confirm = await screen.findByRole("button", { name: mode === "meal" ? /^Add to meal · / : /^Log it · / });
  await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  if (mode === "meal") fireEvent.click(confirm);
  unbindAccount();
  fireEvent.click(mode === "meal" ? screen.getByRole("button", { name: "Log this meal" }) : confirm);
  await waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
  expect(commit).not.toHaveBeenCalled();
  expect(onAdd.mock.calls[0][2]).toBe("Saved on this phone only. It could not reach your account.");
  return onAdd.mock.calls[0][0] as LoggedFood;
}

/** Put the card on the day as the page would, delete it as Undo does, and read what is owed. */
async function undo(card: LoggedFood) {
  h = await resetTestAccount();
  const date = "2026-11-02";
  addExtra(date, card);
  await forgetLoggedEntry(date, card.id, h).catch(() => undefined);
  return { onDay: getDay(date)?.extras ?? [], owed: (await readPending(h)).filter((r) => r.entryId === card.id) };
}

describe("a log the commit did not send", () => {
  it("keeps a signed-out single catalog pick as a local-only card that Undo owes nothing for", async () => {
    const card = await signedOutLog("food");
    expect(card.foodId).toBe("catalog:7");
    expect(card.localOnly).toBe(true);
    expect(card.rev).toBeUndefined();
    expect(card.items?.map((i) => i.food_ref_id)).toEqual(["local:catalog:7"]);
    expect(await undo(card)).toEqual({ onDay: [], owed: [] });
  });

  it("keeps a signed-out meal as a local-only card that Undo owes nothing for", async () => {
    const card = await signedOutLog("meal");
    expect(card).toMatchObject({ foodId: "meal", localOnly: true });
    expect(card.items?.every((i) => i.food_ref_id.startsWith("local:"))).toBe(true);
    expect(await undo(card)).toEqual({ onDay: [], owed: [] });
  });

  it("would owe a delete for the same catalog lines left unmarked (the bug)", async () => {
    const card = await signedOutLog("meal");
    const unmarked = mealCard({ entryId: card.id, at: new Date(card.at), name: "", note: "",
      catalogItems: [], items: [{ ...card.items![0], id: "x", foodId: "catalog:7", name: "Bread",
        portionLabel: "100 g", qty: 100, grams: 100, macros: card.macros, at: card.at,
        items: [{ ...card.items![0], food_ref_id: CATALOG_REF }] } as unknown as LoggedFood] });
    const { owed } = await undo(unmarked);
    expect(owed.map((r) => r.state)).toEqual(["deleted"]);
  });
});
