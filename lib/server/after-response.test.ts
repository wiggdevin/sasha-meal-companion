import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));

import { afterResponse } from "./after-response";

describe("afterResponse", () => {
  afterEach(() => { vi.restoreAllMocks(); mocks.after.mockReset(); });

  it("hands the task to Next's after() inside a request scope", () => {
    const task = vi.fn(async () => {});
    afterResponse(task);
    expect(mocks.after).toHaveBeenCalledWith(task);
    expect(task).not.toHaveBeenCalled();
  });

  it("never throws into the route when there is no request scope; it logs and skips", () => {
    mocks.after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const task = vi.fn(async () => {});
    expect(() => afterResponse(task)).not.toThrow();
    expect(task).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("after-response");
  });
});
