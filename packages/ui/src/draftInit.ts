/**
 * Where a new conversation's settings come from when the page opens: the saved draft, or the default only when the
 * saved settings were read successfully and hold no draft. A failed read (e.g. the connection dropped while loading)
 * is not "nothing saved": it reports the failure and waits for a retry (the user's, or a reconnect), so the default
 * never replaces a saved draft that the next edit would then overwrite.
 *
 * Kept free of React so the order of events can be tested (scripts/test-workflow.mjs).
 */
export interface DraftInit<D> {
  /** The providers and host are known: read the saved settings. */
  start(): Promise<void>;
  /** Read again (the retry button, or the connection came back). Does nothing once a draft was set. */
  retry(): Promise<void>;
  /** The saved settings arrived another way (pushed, or loaded by another part of the page). */
  saved(draft: D | undefined): void;
  readonly done: boolean;
}

export function draftInit<D>(o: {
  read: () => Promise<unknown>;
  makeDefault: () => D;
  set: (draft: D, from: 'saved' | 'default') => void;
  /** The read failed: `why` to show; null when a new attempt starts (clear the message). */
  fail: (why: string | null) => void;
}): DraftInit<D> {
  let done = false;
  let ready = false;
  let attempt = 0;
  const adopt = (d: D, from: 'saved' | 'default') => {
    if (done) return;
    done = true;
    o.fail(null);
    o.set(d, from);
  };
  const read = async () => {
    if (done || !ready) return;
    const mine = ++attempt;
    o.fail(null);
    try {
      const s = await o.read();
      // Only the newest attempt decides, success or failure: an older read answering late (e.g. from before a
      // reconnect) must not set the default while the newer one may still bring the saved draft.
      if (mine !== attempt) return;
      if (!s || typeof s !== 'object') throw new Error('the settings could not be read');
      const d = (s as { draft?: D }).draft;
      adopt(d ?? o.makeDefault(), d ? 'saved' : 'default');
    } catch (e) {
      if (!done && mine === attempt) o.fail(e instanceof Error ? e.message : String(e));
    }
  };
  return {
    start() {
      ready = true;
      return read();
    },
    retry: read,
    saved(d) {
      if (d) adopt(d, 'saved');
    },
    get done() {
      return done;
    },
  };
}

/**
 * The settings kept as the default for new conversations: what is chosen for one conversation only stays out.
 * Whole-computer access goes back to Full auto; the security check (securityReview) is dropped.
 */
export function forNewConversations<D extends { permission?: string; securityReview?: boolean }>(d: D): D {
  const { securityReview: _once, ...rest } = d;
  return (rest.permission === 'full' ? { ...rest, permission: 'auto' } : rest) as D;
}
