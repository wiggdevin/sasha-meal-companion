import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("AI runtime packaging", () => {
  it("bundles @google/genai so Vercel never resolves it from /var/task at runtime", () => {
    expect(nextConfig.serverExternalPackages ?? []).not.toContain("@google/genai");
  });
});
