/**
 * T9 §1 guard — `/settings` is moved into smaller files, never rewritten.
 *
 * The page is a client component whose state arrives in an effect, so a plain
 * `renderToStaticMarkup` would only ever see the `store === null` early return.
 * `useEffect` is therefore mocked to run during render (React supports a
 * render-phase state update, and `loadStore` here returns one frozen object, so
 * the re-render bails out on the second pass instead of looping). Everything the
 * effects reach — the store, the two client fetchers, `window` — is pinned, so
 * the markup is a pure function of the fixture below.
 *
 * What it asserts: the exact markup for two fixed states. Any change to the
 * page's output, including a whitespace or class change, fails this test. That
 * is the point — §1 is a move.
 *
 * The baseline moved once on purpose, in the new-user run: design §5 deletes the authored ramp
 * and `RampControl` with it, and design §5.3 puts the "Finish your profile" card in the targets
 * group for an account with no revision. Both show in the refreshed snapshot. Nothing else about
 * the page changed, and the guard is as strict as it was. It moved again on 2026-10-03 for one
 * insertion: the Water section (unit chips) between the targets and the schedule. And on 2026-10-04
 * (UI pass U16/U17): no "Working around a job", no "Food preferences", calendar reminders inside the
 * meal-times card, and Data & account as one card. On 2026-10-05 (owner notes): "Body profile & units"
 * left for the profile card's details, Goals & targets became one card, and the daily targets show
 * each macro's amount and short name once. On 2026-10-07 (owner: "Choose a mascot"): one insertion,
 * the Your companion section after Cuisines; next/image is pinned to a plain img (its module reads
 * `document` when it loads, which this server render has not got).
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentType } from "react";
import type { Settings, Store } from "@/lib/types";

const BASE_SETTINGS: Settings = {
  trainingKcal: null,
  restKcal: null,
  proteinG: null,
  proteinLocked: true,
  slotTimes: {},
  shiftMinutes: 0,
  changedAt: null,
};

/** One frozen object per state: `setStore(loadStore())` must be reference-stable. */
const DEFAULT_STORE: Store = {
  version: 1, firstOpenedAt: "2026-09-01", settings: BASE_SETTINGS, days: {}, foods: {},
};
const PINNED_STORE: Store = {
  version: 1,
  firstOpenedAt: "2026-09-01",
  settings: {
    ...BASE_SETTINGS,
    trainingKcal: 2400,
    restKcal: 2000,
    proteinG: 150,
    proteinLocked: false,
    changedAt: "2026-09-16T10:00:00.000Z",
  },
  days: {},
  foods: {},
};

let current: Store = DEFAULT_STORE;

/**
 * The page mounts three effects; only the third (`setStore(loadStore())`) reaches the markup.
 * A render-phase update always schedules another pass in Fizz, equal state or not, so the budget
 * is spent on exactly that one pass — the second pass then runs no effects and the render settles.
 */
const PAGE_EFFECTS = 3;
let effectBudget = 0;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (fn: () => void | (() => void)) => {
      if (effectBudget > 0) { effectBudget -= 1; fn(); }
    },
  };
});

/** The one day this test is ever run on. `changedAt` in PINNED_STORE is the day before. */
const TODAY = "2026-09-17";

vi.mock("@/lib/settings/date", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings/date")>();
  return { ...actual, todayIso: () => TODAY };
});

vi.mock("next/image", () => ({
  // Lazy, as next/image renders without `priority`, so React adds no preload link to the markup.
  // eslint-disable-next-line @next/next/no-img-element -- a test double for next/image itself
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} loading="lazy" />,
}));

vi.mock("@/lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/store")>();
  return { ...actual, loadStore: () => current, saveStore: () => {} };
});

vi.mock("@/lib/health-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/health-client")>();
  return { ...actual, fetchDaily: () => new Promise(() => {}) };
});

vi.mock("@/lib/estimator-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/estimator-client")>();
  return {
    ...actual,
    fetchExpenditure: () => new Promise(() => {}),
    fetchTargets: () => new Promise(() => {}),
  };
});

const noop = () => {};
vi.stubGlobal("window", {
  addEventListener: noop, removeEventListener: noop,
  setInterval: () => 0, clearInterval: noop,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
});

// Resolving and transforming the settings page's whole component tree (`import("@/app/settings/page")`)
// is a one-time cold-module cost, not per-test work — paying it inside the first test's own 5s
// default budget made that test time out under the full suite's default parallelism (many workers
// doing module transforms at once). `beforeAll` pays it once, with a budget sized for that load,
// and every test then only measures the actual render.
let SettingsPage: ComponentType | null = null;

beforeAll(async () => {
  SettingsPage = (await import("@/app/settings/page")).default;
}, 20_000);

async function markupFor(store: Store): Promise<string> {
  current = store;
  effectBudget = PAGE_EFFECTS;
  const Page = SettingsPage!;
  return renderToStaticMarkup(<Page />);
}

describe("the effect budget", () => {
  /**
   * The budget is spent once and then effects become no-ops, so a FOURTH mount effect would be
   * skipped in silence and whatever it puts on the screen would quietly leave the snapshot.
   * Counting the source keeps the two honest about each other.
   */
  it("matches the number of effects the settings controller actually mounts", () => {
    const page = readFileSync("components/settings/use-settings-controller.ts", "utf8");
    // A call at the start of its own line: the import and the one in a comment are not mounts.
    expect(page.match(/^\s*useEffect\(/gm) ?? []).toHaveLength(PAGE_EFFECTS);
  });
});

describe("the settings page's static markup is fixed by its state", () => {
  it("renders the settings sections in user order", async () => {
    const markup = await markupFor(DEFAULT_STORE);
    const headings = [
      "Profile",
      "Health connections",
      "Goals &amp; targets",
      "Schedule &amp; reminders",
      "Data &amp; account",
    ];
    const positions = headings.map((heading) => markup.indexOf(heading));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(markup).not.toContain("What you burn");
    expect(markup).not.toContain("Weight trend");
    expect(markup.indexOf("Account email")).toBeGreaterThan(positions.at(-1)!);
  });

  it("uses second-person copy without operator or infrastructure language", async () => {
    const markup = await markupFor(DEFAULT_STORE);
    expect(markup).not.toMatch(/\b(?:devin|she|her)\b|ingest token/i);
  });

  it("keeps guidance disclosed, body fields singular, and targets consolidated", async () => {
    const markup = await markupFor(DEFAULT_STORE);

    // U16/U17 (2026-10-04): "Working around a job" only repeated "Shift the whole day", and "Food
    // preferences" only linked back to Foods; both are gone, and calendar reminders joined the
    // meal-times card.
    expect(markup).not.toContain("Working around a job");
    expect(markup).not.toContain("Food preferences");
    expect(markup.match(/Calendar reminders/g)).toHaveLength(1);
    // 2026-10-05 (owner): "Body profile & units" repeated what Edit profile edits. It left; the
    // profile card shows the details instead, so no body field is edited on the page itself.
    expect(markup).not.toContain("Body profile &amp; units");
    for (const label of ["Height unit", "Weight unit", "Birth year", "Body fat percentage"]) {
      expect(markup).not.toContain(`aria-label="${label}"`);
    }
    expect(markup.match(/>Height</g)).toHaveLength(1);
    expect(markup.match(/aria-label="Goals &amp; targets"/g)).toHaveLength(1);
  });

  it("renders the coach's plan, unpinned", async () => {
    const markup = await markupFor(DEFAULT_STORE);
    expect(markup).toMatchSnapshot();
  });

  it("renders every pin, the unlocked protein panel and the reset button", async () => {
    const markup = await markupFor(PINNED_STORE);
    expect(markup).toMatchSnapshot();
  });
});
