// @vitest-environment jsdom
/**
 * Phase 18 W12-F (docs/specs/phase-18-open-world-foods.md "The W12 boundary" item 2, acceptance 8):
 * before the camera or file picker opens for a photo, one line asks the user to keep medicines,
 * prescriptions and labels with names out of the frame. The line is present beside the photo
 * control before any tap — never a blocking dialog — so it costs no extra confirmation per photo.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlanComposer from "@/components/plan/PlanComposer";
import PhotoPrivacyNotice from "@/components/ui/PhotoPrivacyNotice";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const NOTICE_TEXT = /keep medicines, prescriptions and labels/i;

describe("the Plan sheet photo control's privacy notice", () => {
  it("is absent when no caller passes it (unaffected callers, e.g. the recipe widget)", () => {
    render(<PlanComposer draft="" onDraft={() => {}} onSubmit={() => {}} onPhoto={() => {}} busy={false} />);
    expect(screen.queryByText(NOTICE_TEXT)).toBeNull();
  });

  it("is rendered on mount, before the + tab is ever opened or a picker tapped (plan mode)", () => {
    render(<PlanComposer draft="" onDraft={() => {}} onSubmit={() => {}} onPhoto={() => {}}
      onDocument={() => {}} busy={false} photoNotice={<PhotoPrivacyNotice />} />);
    // Present immediately: no "+" tap, no camera/upload button in the DOM yet.
    expect(screen.queryByRole("button", { name: "Take a photo" })).toBeNull();
    expect(screen.getByText(NOTICE_TEXT)).toBeTruthy();
  });

  it("stays present once the + tab opens and the camera/upload buttons appear", () => {
    render(<PlanComposer draft="" onDraft={() => {}} onSubmit={() => {}} onPhoto={() => {}}
      onDocument={() => {}} busy={false} photoNotice={<PhotoPrivacyNotice />} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a photo or file" }));
    expect(screen.getByRole("button", { name: "Take a photo" })).toBeTruthy();
    expect(screen.getByText(NOTICE_TEXT)).toBeTruthy();
  });

  it("is present beside log mode's always-visible big camera button, with no tab tap needed", () => {
    render(<PlanComposer draft="" onDraft={() => {}} onSubmit={() => {}} onPhoto={() => {}} busy={false}
      cameraFirst="Snap what you ate" photoNotice={<PhotoPrivacyNotice />} />);
    expect(screen.getByRole("button", { name: /Snap what you ate/ })).toBeTruthy();
    expect(screen.getByText(NOTICE_TEXT)).toBeTruthy();
  });
});
