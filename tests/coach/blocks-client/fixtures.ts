import { vi } from "vitest";
import type { CoachBlockContext } from "@/components/coach/blocks";

export function blockContext(overrides: Partial<CoachBlockContext> = {}): CoachBlockContext {
  return {
    tz: "America/Denver",
    onBlockStatus: vi.fn(),
    onSearchManually: vi.fn(),
    rerunAsLabel: vi.fn(),
    sendText: vi.fn(),
    logFood: vi.fn(),
    markEats: vi.fn(),
    markAvoid: vi.fn(),
    applyAction: vi.fn(),
    isLatestAssistant: true,
    ...overrides,
  };
}
