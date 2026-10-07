/**
 * lib/barcode/worker.ts runs inside a Worker, so this stubs `self` before importing it and
 * captures the "message" listener the module registers. readBarcodes is mocked so a decode
 * failure (corrupted wasm, unsupported image, an internal zxing error) is reproducible without
 * a real camera frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readBarcodes = vi.fn();

vi.mock("zxing-wasm/reader", () => ({
  prepareZXingModule: vi.fn(),
  readBarcodes: (...args: unknown[]) => readBarcodes(...args),
}));

type Listener = (event: { data: { id: number; data: unknown } }) => void;

function stubSelf() {
  const listeners: Listener[] = [];
  const postMessage = vi.fn();
  (globalThis as unknown as { self: unknown }).self = {
    addEventListener: (_type: string, listener: Listener) => listeners.push(listener),
    postMessage,
  };
  return { emit: (data: { id: number; data: unknown }) => listeners[0]({ data }), postMessage };
}

describe("barcode worker decode failures", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    delete (globalThis as unknown as { self?: unknown }).self;
  });

  it("flags a decode rejection instead of replying exactly like an empty read, and logs it", async () => {
    const { emit, postMessage } = stubSelf();
    readBarcodes.mockRejectedValueOnce(new Error("wasm module not instantiated"));
    await import("@/lib/barcode/worker");

    emit({ id: 7, data: {} });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());

    expect(postMessage).toHaveBeenCalledWith({ id: 7, results: [], error: true });
    expect(consoleError).toHaveBeenCalled();
  });

  it("still replies with plain empty results, no error flag, on a normal clean read", async () => {
    const { emit, postMessage } = stubSelf();
    readBarcodes.mockResolvedValueOnce([]);
    await import("@/lib/barcode/worker");

    emit({ id: 8, data: {} });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());

    expect(postMessage).toHaveBeenCalledWith({ id: 8, results: [] });
  });
});
