// Part of the contracts §9 step 1 flag-off regression: with NEXT_PUBLIC_CATALOG_SEARCH unset,
// LogFoodSheet's search view must not render the favorites strip lane L's hand-off adds above
// CatalogSearch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import LogFoodSheet from "@/components/LogFoodSheet";

// A favorited recipe's onPick calls useRouter().push, which throws outside an app-router tree
// (the "invariant expected app router to be mounted" this static render has none of).
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

// The real FavoritesStrip only renders once its useEffect's listFavorites() call resolves, which
// never happens under renderToStaticMarkup (no effects run) — so it emits nothing regardless of
// LogFoodSheet's flag gate, and a bare render can't tell "gate removed it" from "no rows yet".
// Stub it to render unconditionally so the assertion below actually exercises LogFoodSheet's
// `useCatalog ? <FavoritesStrip /> : ...` gate: if that gate were dropped, this stub would show up
// in the flag-off markup and the test would fail.
vi.mock("@/components/FavoritesStrip", () => ({
  default: () => <div aria-label="Favorites" />,
}));

let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env.NEXT_PUBLIC_CATALOG_SEARCH;
  delete process.env.NEXT_PUBLIC_CATALOG_SEARCH;
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.NEXT_PUBLIC_CATALOG_SEARCH;
  else process.env.NEXT_PUBLIC_CATALOG_SEARCH = savedFlag;
});

describe("LogFoodSheet — catalog search flag off", () => {
  it("shows the search view with favorites hidden while the catalog flag is off", () => {
    const markup = renderToStaticMarkup(
      <LogFoodSheet mode="food" mine={{}} slot="meal-1" onAdd={() => {}}
        onSomethingElse={() => {}} onClose={() => {}} onCapture={() => {}} />,
    );
    expect(markup).not.toContain('aria-label="Favorites"');
  });
});
