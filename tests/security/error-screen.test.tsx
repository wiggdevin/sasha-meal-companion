// @vitest-environment jsdom
/**
 * The app-wide error boundaries (audit 2026-10-08 §5): a plain recovery screen that never shows
 * the error, with Try again (the boundary's retry, else reset) and Go to Today.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { resetClientErrorReporterForTests } from "@/lib/client-error-reporter";
import AppError from "@/app/error";
import GlobalError from "@/app/global-error";

vi.mock("@/app/globals.css", () => ({}));

let send: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetClientErrorReporterForTests();
  send = vi.fn(async () => new Response(null, { status: 202 }));
  vi.stubGlobal("fetch", send);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); resetClientErrorReporterForTests(); });

const crash = () => Object.assign(new Error("secret detail sasha@example.com"), {
  digest: "d1", stack: "Error: secret\n    at Component (app/page.tsx:1:1)" });

describe("app/error.tsx", () => {
  it("shows the recovery screen and never the message, digest or stack", () => {
    render(<AppError error={crash()} retry={() => {}} />);
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    const text = document.body.textContent ?? "";
    for (const leak of ["secret", "d1", "app/page.tsx", "sasha"]) expect(text).not.toContain(leak);
    expect(screen.getByRole("link", { name: "Go to Today" }).getAttribute("href")).toBe("/");
  });

  it("Try again calls retry, else reset", () => {
    const retry = vi.fn();
    const reset = vi.fn();
    render(<AppError error={crash()} retry={retry} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    cleanup();
    render(<AppError error={crash()} reset={reset} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("reports the crash once", () => {
    render(<AppError error={crash()} retry={() => {}} />);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((send.mock.calls[0][1] as RequestInit).body)).source).toBe("boundary");
  });
});

describe("app/global-error.tsx", () => {
  it("draws its own document with the same recovery screen", () => {
    const markup = renderToStaticMarkup(<GlobalError error={crash()} retry={() => {}} />);
    expect(markup).toMatch(/^<html lang="en">(<head>.*<\/head>)?<body/);
    expect(markup).toContain("Something went wrong");
    expect(markup).toContain("Go to Today");
    expect(markup).not.toContain("secret");
  });
});
