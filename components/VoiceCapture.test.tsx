/**
 * Audit 2026-09-13 #73: RecordButton only wired onPointerDown/onPointerUp, so a keyboard or
 * switch-control "activate" never starts a recording, and beginRecording's single catch put a
 * denied mic permission and a truly unsupported device behind the same "This phone will not
 * record here" copy. @testing-library/react is not installed and no dependency may be added, so
 * this follows the tests/log/capture-row.test.tsx pattern: RecordButton takes no hooks, so it can
 * be called directly as a plain function to inspect the element it returns, and the error
 * classification is a pure function tested with plain objects instead of a real getUserMedia
 * rejection.
 */
import { describe, expect, it, vi } from "vitest";
import { RecordButton, classifyMicError, unsupportedCopy } from "./VoiceCapture";

describe("RecordButton keyboard operability", () => {
  it("starts recording on Enter/Space keydown, mirroring the pointer-hold gesture", () => {
    const onPointerDown = vi.fn();
    const onPointerUp = vi.fn();
    const element = RecordButton({ onPointerDown, onPointerUp, disabled: false });

    expect(typeof element.props.onKeyDown).toBe("function");
    const preventDefault = vi.fn();
    element.props.onKeyDown({ key: " ", repeat: false, preventDefault });
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();

    element.props.onKeyDown({ key: "Enter", repeat: false, preventDefault: vi.fn() });
    expect(onPointerDown).toHaveBeenCalledTimes(2);
  });

  it("ignores key auto-repeat so holding Enter does not restart the clip", () => {
    const onPointerDown = vi.fn();
    const element = RecordButton({ onPointerDown, onPointerUp: vi.fn(), disabled: false });
    element.props.onKeyDown({ key: "Enter", repeat: true, preventDefault: vi.fn() });
    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it("stops recording on Enter/Space keyup, same as releasing the pointer", () => {
    const onPointerUp = vi.fn();
    const element = RecordButton({ onPointerDown: vi.fn(), onPointerUp, disabled: false });
    expect(typeof element.props.onKeyUp).toBe("function");
    element.props.onKeyUp({ key: " " });
    expect(onPointerUp).toHaveBeenCalledTimes(1);
  });

  it("ignores keys other than Enter/Space", () => {
    const onPointerDown = vi.fn();
    const element = RecordButton({ onPointerDown, onPointerUp: vi.fn(), disabled: false });
    element.props.onKeyDown({ key: "Tab", repeat: false, preventDefault: vi.fn() });
    expect(onPointerDown).not.toHaveBeenCalled();
  });
});

describe("classifyMicError", () => {
  it("treats a denied mic permission as recoverable, not a device limitation", () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    expect(classifyMicError(denied)).toBe("permission-denied");
  });

  it("treats a missing device or any other rejection as unsupported", () => {
    const notFound = Object.assign(new Error("no mic"), { name: "NotFoundError" });
    expect(classifyMicError(notFound)).toBe("unsupported");
    expect(classifyMicError(new Error("boom"))).toBe("unsupported");
    expect(classifyMicError(undefined)).toBe("unsupported");
  });
});

describe("unsupportedCopy", () => {
  it("tells her to allow mic access instead of calling a denied permission a device limitation", () => {
    expect(unsupportedCopy("permission-denied")).not.toBe(unsupportedCopy("unsupported"));
    expect(unsupportedCopy("permission-denied")).toMatch(/allow/i);
    expect(unsupportedCopy("unsupported")).toMatch(/will not record/i);
  });
});
