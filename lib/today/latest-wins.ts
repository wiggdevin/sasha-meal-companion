/**
 * One write in flight at a time, and only the newest value waits behind it (audit b4b #4: the water
 * scrub). Values asked for while a write runs replace each other; when it settles, the last one is
 * written next. Every caller's promise settles once the queue is quiet, or with the first failure
 * (the values still waiting are dropped: the screen re-reads the stored count).
 */
export function latestWins<T>(write: (value: T) => Promise<void>): (value: T) => Promise<void> {
  let pending: { value: T } | null = null;
  let running: Promise<void> | null = null;
  return (value) => {
    pending = { value };
    running ??= (async () => {
      try {
        while (pending) {
          const next = pending.value;
          pending = null;
          await write(next);
        }
      } finally {
        pending = null;
        running = null;
      }
    })();
    return running;
  };
}
