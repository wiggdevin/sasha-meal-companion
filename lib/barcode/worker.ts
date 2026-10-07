/**
 * The decoder, off the main thread. The camera loop in BarcodeScanSheet posts an ImageData every
 * 150 ms and gets back whatever zxing found; the quorum rule decides when that is trustworthy.
 *
 * The .wasm is served from /zxing/ (copied out of node_modules by scripts/copy-zxing-wasm.mjs on
 * postinstall, never committed, never fetched from a CDN), so the scanner works offline and the
 * CSP needs no third-party origin (spec "Client changes").
 */
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { SCAN_FORMATS, type ScanReply, type ScanRequest } from "@/lib/barcode/client";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? `/zxing/${path}` : `${prefix}${path}`,
  },
});

self.addEventListener("message", (event: MessageEvent<ScanRequest>) => {
  const { id, data } = event.data;
  void readBarcodes(data, { formats: [...SCAN_FORMATS], tryHarder: true })
    .then((results) => {
      const reply: ScanReply = {
        id,
        results: results
          .filter((r) => r.isValid !== false && typeof r.text === "string" && r.text.length > 0)
          .map((r) => ({ text: r.text, format: String(r.format) })),
      };
      (self as unknown as Worker).postMessage(reply);
    })
    .catch((err: unknown) => {
      console.error("[barcode worker] readBarcodes failed", err);
      (self as unknown as Worker).postMessage({ id, results: [], error: true } satisfies ScanReply);
    });
});
