// @vitest-environment jsdom
/**
 * Design §8.3 — the render spec for every phase `BarcodeScanSheet` puts on screen. The phase is
 * internal state driven by two external systems, so both are stubbed here and nothing else is:
 * the camera (`navigator.mediaDevices.getUserMedia`) and the decoding worker (a `Worker` whose
 * messages this file posts itself). The lookup (`scanGtin`) is stubbed the same way, because the
 * three phases after a reading are answers to it.
 *
 * Each assertion is the sheet's own subtitle in the DOM — the sentence a person reads — never the
 * `MESSAGES` map in source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { BarcodeRejected, ScanUnavailable } from "@/lib/barcode/client";
import { bindAccount, unbindAccount } from "@/lib/device/account";
import { TEST_USER } from "@/tests/helpers/account";

/** Phase 9 §0.1: every call acts for the bound account. */
beforeEach(() => { unbindAccount(); bindAccount(TEST_USER); });

const scanGtin = vi.fn();
vi.mock("@/lib/barcode/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scanGtin: (...args: unknown[]) => scanGtin(...args),
}));
vi.mock("@/lib/barcode/scan-cache", () => ({
  rememberScan: vi.fn(async () => {}),
  resolveOffline: vi.fn(async () => null),
  addPendingScan: vi.fn(),
}));

const BarcodeScanSheet = (await import("@/components/BarcodeScanSheet")).default;
const ScanConfirmSheet = (await import("@/components/ScanConfirmSheet")).default;

/** The one worker the sheet constructs, captured so a test can post a reading into it. */
let worker: { listeners: ((e: { data: unknown }) => void)[]; terminated: boolean };

function FakeWorker(this: unknown) {
  const made = {
    listeners: [] as ((e: { data: unknown }) => void)[],
    terminated: false,
    addEventListener(_type: string, fn: (e: { data: unknown }) => void) {
      made.listeners.push(fn);
    },
    postMessage() {},
    terminate() { made.terminated = true; },
  };
  worker = made;
  return made;
}

/** A stream with one track, enough for the sheet to reach `scanning`. */
function fakeStream(): MediaStream {
  const track = { stop: () => {}, getCapabilities: () => ({}), applyConstraints: async () => {} };
  return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
}

function camera(impl: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: impl }, configurable: true,
  });
}

/** One accepted reading is two matching frames inside the quorum window. */
async function readTwice(text = "05000000000000"): Promise<void> {
  await act(async () => {
    for (const listener of worker.listeners) {
      listener({ data: { id: 1, results: [{ text, format: "ean_13" }] } });
      listener({ data: { id: 2, results: [{ text, format: "ean_13" }] } });
    }
  });
}

function sheet() {
  return render(<BarcodeScanSheet onResolved={() => {}} onClose={() => {}} />);
}

beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker as unknown as typeof Worker);
  camera(async () => fakeStream());
  scanGtin.mockReset().mockResolvedValue({ status: "not_found", gtin14: "05000000000000" });
  window.HTMLMediaElement.prototype.play = vi.fn(async () => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("BarcodeScanSheet's phases", () => {
  it("opens starting, before the camera has answered", () => {
    camera(() => new Promise<MediaStream>(() => {}));
    sheet();
    expect(screen.getByText("Starting the camera…")).toBeTruthy();
  });

  it("says scanning once the camera is live", async () => {
    sheet();
    await screen.findByText("Point the camera at the barcode.");
  });

  it("says resolving while the lookup is in flight", async () => {
    scanGtin.mockReturnValue(new Promise(() => {}));
    sheet();
    await screen.findByText("Point the camera at the barcode.");
    await readTwice();
    await screen.findByText("Looking it up…");
  });

  it("says the camera is denied, and points at the way round it", async () => {
    camera(async () => { throw new DOMException("no", "NotAllowedError"); });
    sheet();
    await screen.findByText(
      "The camera is blocked. Allow it in Settings, or search for the food instead.");
  });

  it("says a rejected code is unreadable rather than blaming the food", async () => {
    scanGtin.mockRejectedValue(new BarcodeRejected("invalid_gtin"));
    sheet();
    await screen.findByText("Point the camera at the barcode.");
    await readTwice();
    await screen.findByText(
      "That is not a barcode we can read. Try the other side of the pack.");
  });

  it("says offline, and promises a retry, when the lookup cannot be reached", async () => {
    scanGtin.mockRejectedValue(new ScanUnavailable("05000000000000"));
    sheet();
    await screen.findByText("Point the camera at the barcode.");
    await readTwice();
    await screen.findByText(
      "No connection, and this one is not on the phone yet. It will retry when you are back.");
  });

  it("calls it a scanner error only after the failures are persistent", async () => {
    sheet();
    await screen.findByText("Point the camera at the barcode.");
    await act(async () => {
      for (let i = 0; i < 5; i += 1) {
        for (const listener of worker.listeners) listener({ data: { id: i, results: [], error: true } });
      }
    });
    await waitFor(() => expect(
      screen.getByText("The scanner isn't reading right now. Search for the food instead."),
    ).toBeTruthy());
  });
});

/** One match, enough to head the confirm sheet and fill the editor's fields. */
const MATCH: Record<string, unknown> = {
  foodRefId: "r-1", catalogFoodId: 1, revisionId: 3, description: "Oat crackers",
  brand: "Pantry", source: "off", qualityClass: "label", qualityFlags: [],
  per100g: { energy_kcal: 430, protein: 9 }, portions: [], ingredientsText: "Oats, sea salt",
  allergenTags: [], policy: { verdict: "allowed", marks: [] },
};

describe("ScanConfirmSheet's three answers", () => {
  const sheet = (response: unknown) => render(
    <ScanConfirmSheet response={response as never} slot="meal-2" onLogged={() => {}}
      onClose={() => {}} onSearch={() => {}} />);

  it("heads a match with the food it found, not the barcode", () => {
    sheet({ status: "resolved", gtin14: "05000000000000", cached: false, match: MATCH });
    expect(screen.getByText("Oat crackers")).toBeTruthy();
    expect(screen.queryByText("Which one?")).toBeNull();
  });

  it("asks which one on an ambiguous code rather than picking for the account", () => {
    sheet({ status: "ambiguous", gtin14: "05000000000000", cached: false,
      matches: [MATCH, { ...MATCH, revisionId: 4, description: "Oat crackers, thin" }] });
    expect(screen.getByText("Which one?")).toBeTruthy();
    expect(screen.getByText("This barcode matches more than one product.")).toBeTruthy();
  });

  it("says not found, and points at the pack, when the database has no such code", () => {
    sheet({ status: "not_found", gtin14: "05000000000000", searchHint: { name: "crackers" } });
    expect(screen.getByText("Not in the database")).toBeTruthy();
    expect(screen.getByText("Search for it by what is on the pack.")).toBeTruthy();
  });
});
