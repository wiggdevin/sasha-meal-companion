/**
 * T2 (B-03): "Log a food" shipped four 50 %-opacity placeholder buttons — Type / Speak / Scan /
 * Photo — that took no interaction, so the row was a dead end on the one screen where a tap
 * looks like it should do something. The row now draws `captureActions()` and each button opens
 * the same capture flow the FAB opens; with no methods enabled it is not drawn at all.
 *
 * @testing-library/react is not installed and no dependency may be added, so taps are a manual
 * phone gate: the close-then-open handler is a pure function tested with spies, and the markup is
 * asserted with `renderToStaticMarkup` — the tests/health/sparkline.test.ts pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import CaptureRow, { closeThenCapture } from "@/components/CaptureRow";
import LogFoodSheet from "@/components/LogFoodSheet";
import { CAPTURE_LABELS, SHORT_CAPTURE_LABELS, captureActions } from "@/lib/capture-client";

// A row that resolves through the catalog calls useRouter().push, which throws outside an
// app-router tree ("invariant expected app router to be mounted") — this static render has none.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const NOOP = () => {};
const FLAG_KEYS = ["CAPTURE_METHODS", "NEXT_PUBLIC_CAPTURE_METHODS", "NEXT_PUBLIC_FEATURE_SCAN"] as const;

let saved: Partial<Record<(typeof FLAG_KEYS)[number], string>> = {};

// `captureActions()` with no argument is the real bundle path (audit T2/P1): it reads the same
// flags the browser bundle inlines. These tests drive it through `process.env` instead of stubbing
// it, so a render says "the sheet wires the row" without a mock standing in for the flag reader.
const TEXT_PHOTO = ["text", "photo"] as const;

function actionsFor(methods: readonly ("text" | "voice" | "label" | "photo")[]) {
  vi.stubEnv("NEXT_PUBLIC_CAPTURE_METHODS", methods.join(","));
  return captureActions();
}

/** Capture buttons, counted by their accessible name. The sheet draws its own buttons too, so a
 *  bare `<button` count would measure the chrome as well as the row. */
function captureButtonLabels(markup: string): string[] {
  return Object.values(CAPTURE_LABELS).filter((full) => markup.includes(`aria-label="${full}"`));
}

beforeEach(() => {
  saved = {};
  for (const key of FLAG_KEYS) {
    if (process.env[key] !== undefined) saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of FLAG_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("CaptureRow — no method enabled (production today)", () => {
  it("draws nothing at all rather than dead buttons", () => {
    const markup = renderToStaticMarkup(<CaptureRow actions={captureActions()} onCapture={NOOP} />);
    expect(markup).not.toContain("<button");
    expect(markup).toBe("");
  });

  it("still draws the barcode row when its flag hands one in", () => {
    const markup = renderToStaticMarkup(
      <CaptureRow actions={captureActions()} onCapture={NOOP} scan={NOOP} />,
    );
    expect(markup.match(/<button/g) ?? []).toHaveLength(1);
    expect(markup).toContain("Scan");
  });
});

describe("captureActions — an explicit record never falls through to ambient flags", () => {
  it("returns nothing for an empty record even when CAPTURE_METHODS is set around it", () => {
    vi.stubEnv("CAPTURE_METHODS", "text");
    expect(captureActions({})).toEqual([]);
    expect(captureActions({ NEXT_PUBLIC_CAPTURE_METHODS: "" })).toEqual([]);
  });
});

describe("CaptureRow — enabled methods are live", () => {
  // Built inside the hook, after the file-level cleanup, so the stub never outlives one test.
  let actions: ReturnType<typeof actionsFor>;
  beforeEach(() => {
    actions = actionsFor(TEXT_PHOTO);
  });

  it("is one button per enabled method, drawn short and named in full", () => {
    const markup = renderToStaticMarkup(<CaptureRow actions={actions} onCapture={NOOP} />);
    expect(captureButtonLabels(markup)).toEqual([CAPTURE_LABELS.text, CAPTURE_LABELS.photo]);
    expect(markup).toContain(`>${SHORT_CAPTURE_LABELS.text}<`);
    expect(markup).toContain(`>${SHORT_CAPTURE_LABELS.photo}<`);
    expect(markup).not.toContain(`>${SHORT_CAPTURE_LABELS.voice}<`);
    expect(markup).not.toContain(`>${SHORT_CAPTURE_LABELS.label}<`);
    // The full line is still there, as the accessible name.
    expect(markup).toContain(`aria-label="${CAPTURE_LABELS.text}"`);
    expect(markup).toContain(`aria-label="${CAPTURE_LABELS.photo}"`);
  });

  it("carries none of the placeholder's dead-button markings", () => {
    const markup = renderToStaticMarkup(<CaptureRow actions={actions} onCapture={NOOP} />);
    expect(markup).not.toContain("aria-disabled");
    expect(markup).not.toContain("opacity-50");
    expect(markup).not.toContain("tabindex");
  });

  it("keeps a 44 px target per button", () => {
    const markup = renderToStaticMarkup(<CaptureRow actions={actions} onCapture={NOOP} />);
    expect(markup.match(/min-h-11/g) ?? []).toHaveLength(2);
  });
});

describe("closeThenCapture", () => {
  it("closes the sheet before the capture flow opens, never after", () => {
    const order: string[] = [];
    const open = closeThenCapture(
      () => order.push("close"),
      (method) => order.push(`open:${method}`),
    );
    open("text");
    expect(order).toEqual(["close", "open:text"]);
  });
});

describe("LogFoodSheet with every capture flag unset", () => {
  it("renders no capture row and no dead placeholder buttons", () => {
    const markup = renderToStaticMarkup(
      <LogFoodSheet
        mode="food"
        mine={{}}
        slot="meal-1"
        onAdd={NOOP}
        onSomethingElse={NOOP}
        onClose={NOOP}
        onCapture={NOOP}
      />,
    );
    for (const label of Object.values(CAPTURE_LABELS)) expect(markup).not.toContain(label);
    expect(markup).not.toContain("aria-disabled");
    expect(markup).not.toContain("opacity-50");
    for (const placeholder of [">Type<", ">Say or type<", ">Speak<", ">Scan<", ">Photo<"]) {
      expect(markup).not.toContain(placeholder);
    }
  });
});

describe("LogFoodSheet with two methods enabled (audit T2/P2)", () => {
  it("draws the row inside the sheet: exactly two buttons, short word, full accessible name", () => {
    const actions = actionsFor(TEXT_PHOTO);
    expect(actions).toHaveLength(2);
    const markup = renderToStaticMarkup(
      <LogFoodSheet
        mode="food"
        mine={{}}
        slot="meal-1"
        onAdd={NOOP}
        onSomethingElse={NOOP}
        onClose={NOOP}
        onCapture={NOOP}
      />,
    );
    expect(captureButtonLabels(markup)).toEqual([CAPTURE_LABELS.text, CAPTURE_LABELS.photo]);
    expect(markup).toContain(`>${SHORT_CAPTURE_LABELS.text}<`);
    expect(markup).toContain(`>${SHORT_CAPTURE_LABELS.photo}<`);
    expect(markup).not.toContain(`>${SHORT_CAPTURE_LABELS.voice}<`);
    expect(markup).not.toContain(`>${SHORT_CAPTURE_LABELS.label}<`);
    expect(markup).not.toContain("aria-disabled");
    expect(markup).not.toContain("opacity-50");
    // The default view is search, so the row the buttons came from is the search sheet's own.
    expect(markup).toContain('placeholder="e.g. chicken, banana, chkn brst"');
  });
});
