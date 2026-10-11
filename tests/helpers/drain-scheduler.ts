// A React commit made outside act() (a hook settling under vi.waitFor, say) queues its passive
// effects on React's scheduler, which uses setImmediate in Node. cleanup() unmounts the tree but
// leaves that task queued; when it runs after the file's jsdom is torn down, it reads
// `window.event` and fails the run with "window is not defined" (CI on PR #67,
// components/Onboarding/v2/account-switch.test.tsx). Let every queued task run while the
// environment still exists. setImmediate is FIFO, so two turns cover a task queued from inside one.
import { afterAll } from "vitest";

afterAll(async () => {
  if (typeof window === "undefined") return;
  for (let i = 0; i < 2; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
});
