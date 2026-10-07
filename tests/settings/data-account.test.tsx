import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SyncCard, type SyncStatusState } from "@/components/SyncStatus";

describe("Data and account identity", () => {
  it("labels the signed-in account email beside the manual sync action", () => {
    const state: SyncStatusState = {
      email: "signed-in@example.test",
      pending: 0,
      lastSync: "2026-09-20T12:00:00.000Z",
      error: null,
      syncing: false,
      loaded: true,
    };

    const markup = renderToStaticMarkup(<SyncCard state={state} onSync={() => {}} />);

    expect(markup).toContain("Account email");
    expect(markup).toContain("signed-in@example.test");
    expect(markup).toContain("Sync now");
  });

  it("says how many changes from before the update are held, with no action (Phase 9 §0.6)", () => {
    const state: SyncStatusState = {
      email: "signed-in@example.test", pending: 0, lastSync: null, error: null,
      syncing: false, loaded: true, held: 2,
    };
    const markup = renderToStaticMarkup(<SyncCard state={state} onSync={() => {}} />);
    expect(markup).toContain("2 changes from before the update are held on this phone.");
    const none = renderToStaticMarkup(<SyncCard state={{ ...state, held: 0 }} onSync={() => {}} />);
    expect(none).not.toContain("held on this phone");
  });
});
