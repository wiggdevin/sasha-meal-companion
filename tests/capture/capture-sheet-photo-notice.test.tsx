/** @vitest-environment jsdom */
/**
 * Phase 18 W12-F (docs/specs/phase-18-open-world-foods.md "The W12 boundary" item 2, acceptance 8):
 * before the camera opens, one line asks the user to keep medicines, prescriptions and labels with
 * names out of the frame. CaptureSheet's "photo" (plate) and "label" (nutrition panel) modes both
 * open a camera through PhotoCapture and both reach a model (lib/capture-client's captureMedia), so
 * both need the notice, present beside the control before any tap — never a blocking dialog. Reuses
 * components/ui/PhotoPrivacyNotice.tsx unchanged, the same component feat/ui-photo-notice added for
 * the Plan sheet.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CaptureSheet from "@/components/CaptureSheet";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

afterEach(() => cleanup());

const noop = () => {};
const NOTICE_TEXT = /keep medicines, prescriptions and labels/i;

describe("CaptureSheet's photo-capture notice", () => {
  it("is present before the plate photo control is ever tapped", () => {
    render(<CaptureSheet open initialMode="photo" onClose={noop} onLogged={noop} onOpenSearch={noop} />);
    expect(screen.getByRole("button", { name: "Photograph the plate" })).toBeTruthy();
    expect(screen.getByText(NOTICE_TEXT)).toBeTruthy();
  });

  it("is present before the label photo control is ever tapped, beside the nutrition-panel copy", () => {
    render(<CaptureSheet open initialMode="label" onClose={noop} onLogged={noop} onOpenSearch={noop} />);
    expect(screen.getByRole("button", { name: "Scan the label" })).toBeTruthy();
    // The notice is about medicines/prescriptions/labels WITH NAMES; it does not contradict this
    // mode's own purpose (photographing a nutrition label), so both lines coexist unchanged.
    expect(screen.getByText("Photograph the nutrition panel.")).toBeTruthy();
    expect(screen.getByText(NOTICE_TEXT)).toBeTruthy();
  });

  it("does not appear for text capture, which has no camera", () => {
    render(<CaptureSheet open initialMode="text" onClose={noop} onLogged={noop} onOpenSearch={noop} />);
    expect(screen.queryByText(NOTICE_TEXT)).toBeNull();
  });

  it("does not appear for voice capture, which has no camera", () => {
    render(<CaptureSheet open initialMode="voice" onClose={noop} onLogged={noop} onOpenSearch={noop} />);
    expect(screen.queryByText(NOTICE_TEXT)).toBeNull();
  });
});
